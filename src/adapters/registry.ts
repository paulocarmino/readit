import { z } from 'zod';
import { UserFacingError } from '../errors.js';
import type { RegisteredAdapter } from './types.js';

/**
 * Checks whether `hostname` is one of `hosts` or a subdomain of one.
 *
 * @param hostname - URL hostname
 * @param hosts - Domains an adapter handles
 * @returns True on match
 */
export function hostMatches(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Holds the adapters and picks one per URL. The generic adapter is the fallback. */
export class AdapterRegistry {
  private readonly byName = new Map<string, RegisteredAdapter>();

  /**
   * @param adapters - Site-specific adapters, in priority order
   * @param fallback - Adapter used when no other matches
   */
  constructor(
    adapters: readonly RegisteredAdapter[],
    private readonly fallback: RegisteredAdapter
  ) {
    for (const adapter of [...adapters, fallback]) {
      if (this.byName.has(adapter.name))
        throw new Error(`Adapter "${adapter.name}" registered twice`);
      this.byName.set(adapter.name, adapter);
    }
  }

  /**
   * Picks the adapter for a URL.
   *
   * @param url - Target URL
   * @param forced - Adapter name requested explicitly by the caller
   * @returns The adapter to use
   * @throws UserFacingError when `forced` does not exist
   */
  resolve(url: URL, forced?: string): RegisteredAdapter {
    if (forced) {
      const adapter = this.byName.get(forced);
      if (!adapter) {
        throw new UserFacingError(
          `Unknown adapter "${forced}". Available: ${this.names().join(', ')}`,
          'invalid'
        );
      }
      return adapter;
    }

    for (const adapter of this.byName.values()) {
      if (adapter === this.fallback) continue;
      if (hostMatches(url.hostname, adapter.hosts) && (adapter.matches?.(url) ?? true))
        return adapter;
    }
    return this.fallback;
  }

  /** Adapter names, fallback last. */
  names(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * Human-readable list of adapters and their options, for the tool description.
   *
   * @returns Markdown-ish text
   */
  describe(): string {
    return [...this.byName.values()]
      .map((adapter) => {
        const hosts = adapter.hosts.length > 0 ? adapter.hosts.join(', ') : 'any site (fallback)';
        const schema = z.toJSONSchema(adapter.optionsSchema, {
          io: 'input',
          unrepresentable: 'any',
        });
        // .int() adds ±MAX_SAFE_INTEGER bounds that are pure noise in a tool description.
        const props =
          'properties' in schema && schema.properties
            ? JSON.stringify(schema.properties, (_key, value: unknown) =>
                typeof value === 'number' && Math.abs(value) === Number.MAX_SAFE_INTEGER
                  ? undefined
                  : value
              )
            : '{}';
        return `- ${adapter.name} [${hosts}]: ${adapter.description}\n  adapter_options: ${props}`;
      })
      .join('\n');
  }
}
