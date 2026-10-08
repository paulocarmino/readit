import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { Config } from '../config.js';
import type { StoredCookie } from '../credentials/parse.js';
import { UserFacingError, errorMessage } from '../errors.js';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);

/** Whether the browser window is visible. */
export type BrowserMode = 'headless' | 'headed';

/** Source of saved credentials (the encrypted store). */
export interface CredentialSource {
  version(): string;
  loadCookies(): { cookies: StoredCookie[]; ids: string[]; failed: string[] };
  markInjected(ids: readonly string[]): void;
  injectedKeys(): string[];
  setInjectedKeys(keys: readonly string[]): void;
}

function cookieKey(cookie: Pick<StoredCookie, 'domain' | 'path' | 'name'>): string {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

const PROFILE_LOCK_PATTERN = /ProcessSingleton|SingletonLock|profile appears to be in use/i;

/**
 * Owns the single persistent Chromium context.
 *
 * - Lazy: launched on the first operation.
 * - One profile, one process: switching between headless and headed means closing and
 *   relaunching on the same profile (Chromium locks the profile directory).
 * - All operations are serialized through {@link run}, so parallel tool calls never race.
 * - Shutdown is idempotent; cleanup errors are logged, never propagated.
 */
export class BrowserManager {
  private context: BrowserContext | null = null;
  private mode: BrowserMode | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private userAgent: string | null = null;
  private isShutDown = false;
  private credentialsVersion: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly credentials?: CredentialSource
  ) {}

  /**
   * Runs `fn` after every previously queued operation has finished.
   *
   * @param fn - Operation that uses the browser
   * @returns Whatever `fn` returns
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.clearIdleTimer();
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => this.armIdleTimer(),
      () => this.armIdleTimer()
    );
    return result;
  }

  /** Current mode, or null when the browser is not running. */
  get currentMode(): BrowserMode | null {
    return this.mode;
  }

  /**
   * Returns the running context, launching it if needed.
   * With `want`, guarantees that mode (relaunching if the running one differs).
   * Without it, reuses whatever is running (a headed window stays headed).
   * Must be called inside {@link run}.
   *
   * @param want - Required mode, if any
   * @returns The persistent browser context
   */
  async getContext(want?: BrowserMode): Promise<BrowserContext> {
    if (this.isShutDown) throw new Error('Browser manager is shut down');
    if (this.context && (want === undefined || want === this.mode)) {
      await this.syncCredentials(this.context);
      return this.context;
    }
    if (this.context) await this.close();
    const context = await this.launch(want ?? (this.config.headless ? 'headless' : 'headed'));
    await this.syncCredentials(context);
    return context;
  }

  /**
   * Makes the browser's cookies match the saved credentials: adds/refreshes saved cookies and
   * removes cookies from credentials deleted since the last injection. Runs on launch and, via a
   * one-row version check, before every operation (credentials may change from the dashboard).
   * Never throws: a broken credential must not stop the page from loading.
   */
  private async syncCredentials(context: BrowserContext): Promise<void> {
    if (!this.credentials) return;
    try {
      const version = this.credentials.version();
      if (version === this.credentialsVersion) return;

      const loaded = this.credentials.loadCookies();
      const current = new Set(loaded.cookies.map(cookieKey));
      for (const key of this.credentials.injectedKeys()) {
        if (current.has(key)) continue;
        const [domain = '', path = '/', name = ''] = key.split('|');
        // Chromium may report ".example.com" as "example.com": match both, exact otherwise.
        const bare = domain.replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await context.clearCookies({ domain: new RegExp(`^\\.?${bare}$`), path, name });
      }

      const added = await this.addCookies(context, loaded.cookies);
      this.credentials.setInjectedKeys([...current]);
      this.credentials.markInjected(loaded.ids);
      this.credentialsVersion = version;

      if (loaded.failed.length > 0) {
        this.log.warn(
          { domains: loaded.failed },
          'Could not decrypt credentials (secret key changed?)'
        );
      }
      this.log.info(
        { cookies: added, domains: [...new Set(loaded.cookies.map((c) => c.domain))] },
        'Credentials injected'
      );
    } catch (error) {
      this.log.error({ error: errorMessage(error) }, 'Could not sync credentials');
    }
  }

  private async addCookies(
    context: BrowserContext,
    cookies: readonly StoredCookie[]
  ): Promise<number> {
    const toPlaywright = (c: StoredCookie) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure || c.sameSite === 'None',
      httpOnly: c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      expires: c.expires ?? -1,
    });
    if (cookies.length === 0) return 0;
    try {
      await context.addCookies(cookies.map(toPlaywright));
      return cookies.length;
    } catch {
      // One bad cookie rejects the whole batch: retry one by one to keep the good ones.
      let added = 0;
      for (const cookie of cookies) {
        try {
          await context.addCookies([toPlaywright(cookie)]);
          added += 1;
        } catch (error) {
          this.log.warn(
            { cookie: cookie.name, domain: cookie.domain, error: errorMessage(error) },
            'Cookie rejected'
          );
        }
      }
      return added;
    }
  }

  /**
   * Opens a fresh tab, runs `fn`, and always closes the tab afterwards.
   * Must be called inside {@link run}.
   *
   * @param fn - Work to do with the page
   * @returns Whatever `fn` returns
   */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const context = await this.getContext();
    const page = await context.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch((error: unknown) => {
        this.log.warn({ error: errorMessage(error) }, 'Error closing page');
      });
    }
  }

  /**
   * Closes the browser. Safe to call when nothing is running.
   */
  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.mode = null;
    if (!context) return;

    try {
      await context.close();
      this.log.info('Browser closed');
    } catch (error) {
      this.log.error({ error: errorMessage(error) }, 'Error closing browser');
    }
  }

  /**
   * Final shutdown: closes the browser and refuses new launches. Idempotent.
   */
  async shutdown(): Promise<void> {
    if (this.isShutDown) return;
    this.isShutDown = true;
    this.clearIdleTimer();
    await this.close();
  }

  private async launch(mode: BrowserMode): Promise<BrowserContext> {
    await mkdir(this.config.profileDir, { recursive: true });
    const headless = mode === 'headless';
    this.log.info({ mode, profileDir: this.config.profileDir }, 'Launching Chromium');

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(this.config.profileDir, {
        // Full Chromium binary in both modes (new headless), so the profile is always
        // written by the same browser build and headless is harder to fingerprint.
        channel: 'chromium',
        headless,
        viewport: headless ? { width: 1366, height: 900 } : null,
        userAgent: headless ? await this.headlessUserAgent() : undefined,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled'],
      });
    } catch (error) {
      const message = errorMessage(error);
      if (PROFILE_LOCK_PATTERN.test(message)) {
        throw new UserFacingError(
          `The browser profile at ${this.config.profileDir} is in use by another Chromium (probably another readit instance from a different MCP client). Close it, or set READIT_PROFILE_DIR to a different directory for this client.`
        );
      }
      throw error;
    }

    context.setDefaultTimeout(this.config.timeoutMs);
    context.on('close', () => {
      if (this.context === context) {
        this.context = null;
        this.mode = null;
        this.log.info('Browser context closed (window closed or process exited)');
      }
    });

    this.context = context;
    this.mode = mode;
    this.credentialsVersion = null;
    return context;
  }

  /**
   * Headless Chromium advertises "HeadlessChrome" in its User-Agent (and context.request uses
   * the same UA), which Reddit and others block. Build a regular Chrome UA from the binary version.
   */
  private async headlessUserAgent(): Promise<string> {
    if (this.userAgent) return this.userAgent;

    let major = '153';
    try {
      const { stdout } = await execFileAsync(chromium.executablePath(), ['--version']);
      major = /(\d+)\.\d+\.\d+\.\d+/.exec(stdout)?.[1] ?? major;
    } catch (error) {
      this.log.warn({ error: errorMessage(error) }, 'Could not read Chromium version');
    }

    this.userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    return this.userAgent;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    // A visible window stays open until close_browser: the user may be logging in.
    if (this.config.idleMs === 0 || this.mode !== 'headless') return;

    this.idleTimer = setTimeout(() => {
      this.log.info({ idleMs: this.config.idleMs }, 'Idle timeout, closing browser');
      void this.run(() => this.close());
    }, this.config.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
