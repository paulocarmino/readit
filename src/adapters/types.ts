import type { APIRequestContext, Page } from 'playwright';
import { z } from 'zod';
import { UserFacingError } from '../errors.js';
import type { Logger } from '../logger.js';

/** What every adapter returns. */
export interface PageResult {
  title: string;
  /** Final URL after redirects. */
  url: string;
  markdown: string;
  /** Extra facts rendered in the header (author, date, counts...). */
  meta?: Record<string, string | number>;
  /** Things the agent should know (partial content, timeouts...). */
  warnings?: string[];
}

/** Options every read_page call accepts, regardless of adapter. */
export interface CommonOptions {
  /** Extract only elements matching this CSS selector. */
  selector?: string;
  /** Wait for this CSS selector before extracting. */
  waitFor?: string;
}

/** Services the core hands to an adapter. */
export interface AdapterContext {
  /** Opens a tab, navigates (domcontentloaded + waits + challenge check), runs fn, closes the tab. */
  withPage: <T>(
    url: string,
    fn: (page: Page, warnings: string[]) => Promise<T>,
    options?: { waitForStableContent?: boolean }
  ) => Promise<T>;
  /** Opens a blank tab, runs fn, closes the tab. The adapter drives navigation itself. */
  withTab: <T>(fn: (page: Page) => Promise<T>) => Promise<T>;
  /** HTTP client that shares cookies with the logged-in profile. */
  request: APIRequestContext;
  common: CommonOptions;
  timeoutMs: number;
  logger: Logger;
}

/** Definition written by each site adapter. */
export interface SiteAdapter<TOptions> {
  name: string;
  /** One line, shown to the agent in the read_page tool description. */
  description: string;
  /** Domains handled, matched by suffix: 'reddit.com' also matches 'old.reddit.com'. Empty = none. */
  hosts: readonly string[];
  /** Optional refinement; returning false lets the next adapter (or generic) handle the URL. */
  matches?: (url: URL) => boolean;
  /** Validates `adapter_options`. Must accept `{}`. */
  optionsSchema: z.ZodType<TOptions>;
  read: (url: URL, options: TOptions, ctx: AdapterContext) => Promise<PageResult>;
}

/** Type-erased adapter as stored in the registry (options are validated inside `read`). */
export interface RegisteredAdapter {
  name: string;
  description: string;
  hosts: readonly string[];
  matches?: (url: URL) => boolean;
  optionsSchema: z.ZodType;
  read: (url: URL, rawOptions: unknown, ctx: AdapterContext) => Promise<PageResult>;
}

/**
 * Declares a site adapter. Validates `adapter_options` with the adapter's zod schema
 * before calling its handler, so handlers receive typed options.
 *
 * @param def - Adapter definition
 * @returns Adapter ready to be listed in `src/adapters/index.ts`
 */
export function defineAdapter<TOptions>(def: SiteAdapter<TOptions>): RegisteredAdapter {
  return {
    name: def.name,
    description: def.description,
    hosts: def.hosts,
    matches: def.matches,
    optionsSchema: def.optionsSchema,
    read: (url, rawOptions, ctx) => {
      const parsed = def.optionsSchema.safeParse(rawOptions ?? {});
      if (!parsed.success) {
        throw new UserFacingError(
          `Invalid adapter_options for "${def.name}":\n${z.prettifyError(parsed.error)}`,
          'invalid'
        );
      }
      return def.read(url, parsed.data, ctx);
    },
  };
}
