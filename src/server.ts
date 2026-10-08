import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from 'playwright';
import { z } from 'zod';
import type { AdapterRegistry } from './adapters/registry.js';
import type { AdapterContext, PageResult } from './adapters/types.js';
import type { BrowserManager } from './browser/browser-manager.js';
import { navigate } from './browser/navigate.js';
import type { Config } from './config.js';
import { UserFacingError, errorMessage } from './errors.js';
import { truncate } from './lib/truncate.js';
import type { Logger } from './logger.js';
import type { CallFinish, CallStatus, CallStore } from './store/calls.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;

interface Dependencies {
  manager: BrowserManager;
  registry: AdapterRegistry;
  config: Config;
  logger: Logger;
  /** Call history for the dashboard; optional so the server still works if the DB is unavailable. */
  history?: CallStore;
}

/** Per-call state: id, a logger bound to it, and outcome details filled in by the handler. */
interface CallContext {
  log: Logger;
  info: Omit<CallFinish, 'status'>;
}

/**
 * Parses a user-supplied URL, adding https:// when the scheme is missing.
 *
 * @param raw - URL as typed by the agent
 * @returns Parsed http(s) URL
 * @throws UserFacingError for invalid or non-http URLs
 */
export function parseTargetUrl(raw: string): URL {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UserFacingError(`Invalid URL: ${raw}`, 'invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UserFacingError(`Only http(s) URLs are supported, got ${url.protocol}`, 'invalid');
  }
  return url;
}

/**
 * Renders an adapter result as the markdown document returned to the agent.
 *
 * @param result - Adapter output
 * @param adapter - Adapter name
 * @param elapsedMs - Time spent
 * @returns Markdown with a small header
 */
export function formatPageResult(result: PageResult, adapter: string, elapsedMs: number): string {
  const header = [
    `# ${result.title || '(untitled)'}`,
    '',
    `URL: ${result.url}`,
    `Adapter: ${adapter} · ${elapsedMs} ms`,
  ];
  for (const [key, value] of Object.entries(result.meta ?? {})) {
    if (value !== '') header.push(`${key}: ${value}`);
  }
  if (result.warnings && result.warnings.length > 0) {
    header.push('Warnings:', ...result.warnings.map((w) => `- ${w}`));
  }
  return `${header.join('\n')}\n\n---\n\n${result.markdown}\n`;
}

function statusOf(error: unknown): CallStatus {
  if (!(error instanceof UserFacingError)) return 'error';
  if (error.kind === 'user') return 'error';
  return error.kind;
}

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

/**
 * Creates the MCP server with the read_page, open_browser, screenshot and close_browser tools.
 * Every call is recorded (when a history store is given) with its outcome and log lines.
 *
 * @param deps - Browser manager, adapter registry, config, logger and optional history
 * @returns Server ready to be connected to a transport
 */
export function createServer({
  manager,
  registry,
  config,
  logger,
  history,
}: Dependencies): McpServer {
  const server = new McpServer({ name: 'readit', version: '1.0.0' });
  const cache = new Map<string, { text: string; at: number }>();

  const cacheGet = (key: string): string | undefined => {
    const hit = cache.get(key);
    if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return undefined;
    return hit.text;
  };
  const cacheSet = (key: string, value: string): void => {
    cache.delete(key);
    cache.set(key, { text: value, at: Date.now() });
    const oldest = cache.keys().next().value;
    if (cache.size > CACHE_MAX_ENTRIES && oldest !== undefined) cache.delete(oldest);
  };

  /** History writes are best effort: a DB problem must never fail a tool call. */
  const record = (fn: () => void): void => {
    if (!history) return;
    try {
      fn();
    } catch (error) {
      logger.warn({ error: errorMessage(error) }, 'Could not write call history');
    }
  };

  /**
   * Runs a tool handler with a call id, a logger bound to it, history recording and error mapping.
   */
  const tracked = async (
    tool: string,
    args: Record<string, unknown>,
    fn: (call: CallContext) => Promise<CallToolResult>
  ): Promise<CallToolResult> => {
    const callId = randomUUID();
    const call: CallContext = { log: logger.child({ callId, tool }), info: {} };
    const url = typeof args.url === 'string' ? args.url : undefined;
    record(() =>
      history?.start(callId, { tool, url, args, client: server.server.getClientVersion()?.name })
    );
    call.log.info({ args }, `${tool} called`);

    try {
      const result = await fn(call);
      const chars = result.content.reduce(
        (sum, c) => sum + (c.type === 'text' ? c.text.length : 0),
        0
      );
      record(() => history?.finish(callId, { ...call.info, status: 'ok', chars }));
      call.log.info({ status: 'ok', chars }, `${tool} finished`);
      return result;
    } catch (error) {
      const message = errorMessage(error);
      const status = statusOf(error);
      if (error instanceof UserFacingError)
        call.log.warn({ status, error: message }, `${tool} needs attention`);
      else
        call.log.error(
          { status, error: message, stack: error instanceof Error ? error.stack : undefined },
          `${tool} failed`
        );
      record(() => history?.finish(callId, { ...call.info, status, error: message }));
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  };

  server.registerTool(
    'read_page',
    {
      title: 'Read a web page',
      description: [
        "Opens ONE URL in the user's own Chromium (persistent profile: their logins, cookies and residential IP), waits for JS to render, removes noise and returns clean markdown with title and final URL.",
        'Works on JS-heavy sites and sites that block scrapers. Long results are paginated: pass start_index as instructed at the end of the output (served from a 10 min cache, no reload).',
        'If the result says the page is blocked or needs login, call open_browser with the URL and ask the user to solve it in the window, then retry.',
        '',
        'Adapters (picked by domain; force one with `adapter`):',
        registry.describe(),
      ].join('\n'),
      inputSchema: {
        url: z.string().min(1).describe('Page URL.'),
        selector: z
          .string()
          .optional()
          .describe(
            'CSS selector: return only matching elements instead of the auto-detected main content.'
          ),
        wait_for: z
          .string()
          .optional()
          .describe('CSS selector to wait for before extracting (for slow JS content).'),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(1_000_000)
          .optional()
          .describe(`Max characters returned (default ${config.maxChars}).`),
        start_index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Character offset for reading the next chunk of a long page.'),
        adapter: z
          .string()
          .optional()
          .describe(`Force an adapter: ${registry.names().join(', ')}.`),
        adapter_options: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Options for the chosen adapter (see list above).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      tracked('read_page', args, async (call) => {
        const target = parseTargetUrl(args.url);
        const key = JSON.stringify([
          target.href,
          args.selector,
          args.wait_for,
          args.adapter,
          args.adapter_options,
        ]);
        let full = (args.start_index ?? 0) > 0 ? cacheGet(key) : undefined;

        if (full !== undefined) {
          call.info.source = 'cache';
        } else {
          const adapter = registry.resolve(target, args.adapter);
          const log = call.log.child({ adapter: adapter.name });
          call.info.adapter = adapter.name;

          full = await manager.run(async () => {
            const context = await manager.getContext();
            const ctx: AdapterContext = {
              withPage: (url, fn, options) =>
                manager.withPage(async (page) => {
                  const started = Date.now();
                  const warnings = await navigate(page, url, {
                    timeoutMs: config.timeoutMs,
                    waitFor: args.wait_for,
                    waitForStableContent: options?.waitForStableContent,
                  });
                  log.info(
                    { url, finalUrl: page.url(), ms: Date.now() - started, warnings },
                    'Page loaded'
                  );
                  return fn(page, warnings);
                }),
              withTab: (fn) => manager.withPage(fn),
              request: context.request,
              common: { selector: args.selector, waitFor: args.wait_for },
              timeoutMs: config.timeoutMs,
              logger: log,
            };
            const started = Date.now();
            const result = await adapter.read(target, args.adapter_options, ctx);
            call.info.url = result.url;
            const source = result.meta?.source;
            if (typeof source === 'string') call.info.source = source;
            return formatPageResult(result, adapter.name, Date.now() - started);
          });
          cacheSet(key, full);
        }

        return text(truncate(full, args.max_chars ?? config.maxChars, args.start_index ?? 0).text);
      })
  );

  server.registerTool(
    'open_browser',
    {
      title: 'Open visible browser window',
      description:
        'Opens a VISIBLE Chromium window on the same profile so the user can log in or solve a captcha/challenge by hand. Returns immediately: tell the user what to do and wait for them to confirm before calling read_page again. The window stays open (and read_page uses it) until close_browser.',
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe('Page to open (e.g. the login page or the blocked URL).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      tracked('open_browser', args, (call) =>
        manager.run(async () => {
          const target = args.url ? parseTargetUrl(args.url) : null;
          const context = await manager.getContext('headed');
          const page = context.pages()[0] ?? (await context.newPage());
          await page.bringToFront();
          if (target) {
            await page
              .goto(target.href, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs })
              .catch((error: unknown) => {
                call.log.warn(
                  { error: errorMessage(error) },
                  'open_browser navigation did not finish'
                );
              });
          }
          return text(
            `Visible browser window is open${target ? ` at ${target.href}` : ''} (profile: ${config.profileDir}). Ask the user to log in / solve the challenge there and tell you when done, then call read_page again. Call close_browser to go back to headless.`
          );
        })
      )
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot a page',
      description:
        'Debug helper: returns a JPEG screenshot of a URL (or, without url, of the tab currently open in the visible window). Does not fail on challenge pages, so it shows what the browser is actually seeing.',
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe('Page to capture. Omit to capture the current open tab.'),
        full_page: z
          .boolean()
          .optional()
          .describe('Capture the whole scrollable page (default false).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      tracked('screenshot', args, (call) =>
        manager.run(async () => {
          const shoot = async (page: Page): Promise<CallToolResult> => {
            const buffer = await page.screenshot({
              type: 'jpeg',
              quality: 70,
              fullPage: args.full_page ?? false,
            });
            call.info.url = page.url();
            return {
              content: [
                { type: 'image', data: buffer.toString('base64'), mimeType: 'image/jpeg' },
                { type: 'text', text: `${page.url()} — ${await page.title()}` },
              ],
            };
          };

          if (args.url) {
            const target = parseTargetUrl(args.url);
            return manager.withPage(async (page) => {
              await navigate(page, target.href, {
                timeoutMs: config.timeoutMs,
                checkChallenge: false,
              });
              return shoot(page);
            });
          }

          const pages = manager.currentMode ? (await manager.getContext()).pages() : [];
          const page = pages.at(-1);
          if (!page) throw new UserFacingError('No tab is open. Pass a url.', 'invalid');
          return shoot(page);
        })
      )
  );

  server.registerTool(
    'close_browser',
    {
      title: 'Close browser',
      description:
        'Closes the browser (visible or headless). The next read_page relaunches it headless. Cookies/logins stay in the profile.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () =>
      tracked('close_browser', {}, () =>
        manager.run(async () => {
          const was = manager.currentMode;
          await manager.close();
          return text(was ? `Browser (${was}) closed.` : 'Browser was not running.');
        })
      )
  );

  return server;
}
