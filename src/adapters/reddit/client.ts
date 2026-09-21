import type { APIRequestContext, Page } from 'playwright';
import type { Logger } from '../../logger.js';
import { isRetryableError, withRetry } from '../../lib/retry.js';

/** Reddit answered with a block/login page instead of JSON. */
export class RedditBlockedError extends Error {
  override readonly name = 'RedditBlockedError';
}

class RetryableHttpError extends Error {
  constructor(readonly status: number) {
    super(`Reddit returned HTTP ${status}`);
  }
}

interface InPageResponse {
  status: number;
  type: string;
  text: string;
  url: string;
}

/**
 * Fetches Reddit JSON with the profile's cookies.
 *
 * Strategy: `context.request` first (no tab, fastest). If Reddit rejects it (its TLS/HTTP
 * fingerprint is Node's, not Chrome's), switch to `fetch()` inside a reddit.com tab, which is
 * a real Chrome request. 429/5xx are retried with backoff; anything else becomes
 * {@link RedditBlockedError} so the adapter can fall back to the old.reddit DOM.
 */
export class RedditClient {
  private viaPage = false;
  private tabReady = false;

  constructor(
    private readonly request: APIRequestContext,
    private readonly tab: Page,
    private readonly timeoutMs: number,
    private readonly log: Logger
  ) {}

  /** Which strategy ended up being used, for diagnostics. */
  get strategy(): 'context.request' | 'in-page fetch' {
    return this.viaPage ? 'in-page fetch' : 'context.request';
  }

  /**
   * GETs a Reddit JSON endpoint.
   *
   * @param url - Absolute www.reddit.com URL
   * @returns Parsed JSON
   * @throws RedditBlockedError when both strategies are rejected
   */
  async getJson(url: string): Promise<unknown> {
    const started = Date.now();
    const json = await this.getJsonWithRetry(url);
    this.log.info({ url, ms: Date.now() - started, via: this.strategy }, 'Reddit JSON fetched');
    return json;
  }

  private getJsonWithRetry(url: string): Promise<unknown> {
    return withRetry(() => this.fetchOnce(url), {
      maxAttempts: 3,
      baseDelay: 1500,
      shouldRetry: (error) => error instanceof RetryableHttpError,
      onRetry: (error, attempt, delayMs) =>
        this.log.warn({ url, attempt, delayMs, error: error.message }, 'Retrying Reddit request'),
    });
  }

  /**
   * Follows the redirect of a share link (/r/x/s/abc) to the real permalink.
   *
   * @param url - Share URL
   * @returns Final URL
   */
  async resolveRedirect(url: string): Promise<string> {
    if (!this.viaPage) {
      const res = await this.request.get(url, { failOnStatusCode: false, timeout: this.timeoutMs });
      if (res.ok()) return res.url();
      this.viaPage = true;
    }
    const res = await this.fetchInPage(url);
    return res.url;
  }

  private async fetchOnce(url: string): Promise<unknown> {
    if (!this.viaPage) {
      const res = await this.request.get(url, {
        failOnStatusCode: false,
        timeout: this.timeoutMs,
        headers: { accept: 'application/json' },
      });
      const type = res.headers()['content-type'] ?? '';
      if (res.ok() && type.includes('json')) return (await res.json()) as unknown;
      if (res.status() === 429 || res.status() >= 500) throw new RetryableHttpError(res.status());

      this.log.info(
        { status: res.status(), type },
        'context.request rejected by Reddit, switching to in-page fetch'
      );
      this.viaPage = true;
    }

    const res = await this.fetchInPage(url);
    if (res.status === 200 && res.type.includes('json')) return JSON.parse(res.text) as unknown;
    if (isRetryableError(res.status)) throw new RetryableHttpError(res.status);
    throw new RedditBlockedError(
      `Reddit returned HTTP ${res.status} (${res.type || 'no content-type'})`
    );
  }

  private async fetchInPage(url: string): Promise<InPageResponse> {
    if (!this.tabReady) {
      // Any same-origin document works as a fetch origin; robots.txt is tiny and has no JS.
      await this.tab.goto('https://www.reddit.com/robots.txt', {
        waitUntil: 'domcontentloaded',
        timeout: this.timeoutMs,
      });
      this.tabReady = true;
    }
    return this.tab.evaluate(async (target: string): Promise<InPageResponse> => {
      const r = await fetch(target, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      return {
        status: r.status,
        type: r.headers.get('content-type') ?? '',
        text: await r.text(),
        url: r.url,
      };
    }, url);
  }
}
