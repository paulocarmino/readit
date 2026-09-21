import { randomUUID } from 'node:crypto';
import type { ParsedCredential, StoredCookie } from '../credentials/parse.js';
import { decrypt, encrypt } from './crypto.js';
import type { Database } from './db.js';
import { num, str } from './db.js';

/** What the dashboard can see about a credential. Never contains cookie values. */
export interface CredentialSummary {
  id: string;
  kind: string;
  label: string | null;
  domain: string;
  cookieNames: string[];
  preview: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastInjectedAt: number | null;
}

/** Decrypted cookies ready for the browser, plus credentials that failed to decrypt. */
export interface LoadedCookies {
  cookies: StoredCookie[];
  ids: string[];
  failed: string[];
}

function mask(value: string): string {
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}

/**
 * Encrypted credential storage (AES-256-GCM, row id as associated data).
 * Values only leave this class decrypted through {@link loadCookies}, for browser injection.
 */
export class CredentialStore {
  constructor(
    private readonly db: Database,
    private readonly key: Buffer
  ) {}

  /**
   * Lists credentials without their values.
   *
   * @returns Summaries, newest first
   */
  list(): CredentialSummary[] {
    return this.db
      .prepare('SELECT * FROM credentials ORDER BY updated_at DESC')
      .all()
      .map((row) => ({
        id: str(row, 'id') ?? '',
        kind: str(row, 'kind') ?? 'generic',
        label: str(row, 'label'),
        domain: str(row, 'domain') ?? '',
        cookieNames: JSON.parse(str(row, 'cookie_names') ?? '[]') as string[],
        preview: str(row, 'preview') ?? '',
        expiresAt: num(row, 'expires_at'),
        createdAt: num(row, 'created_at') ?? 0,
        updatedAt: num(row, 'updated_at') ?? 0,
        lastInjectedAt: num(row, 'last_injected_at'),
      }));
  }

  /**
   * Saves a credential, replacing any existing one for the same domain.
   *
   * @param credential - Parsed credential
   * @returns Summary of the saved row
   */
  save(credential: ParsedCredential): CredentialSummary {
    const existing = this.db
      .prepare('SELECT id, created_at FROM credentials WHERE domain = ?')
      .get(credential.domain);
    const id = (existing && str(existing, 'id')) ?? randomUUID();
    const createdAt = (existing && num(existing, 'created_at')) ?? Date.now();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO credentials (id, kind, label, domain, cookie_names, preview, secret, expires_at, created_at, updated_at, last_injected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, label = excluded.label, cookie_names = excluded.cookie_names,
           preview = excluded.preview, secret = excluded.secret, expires_at = excluded.expires_at,
           updated_at = excluded.updated_at, last_injected_at = NULL`
      )
      .run(
        id,
        credential.kind,
        credential.label,
        credential.domain,
        JSON.stringify(credential.cookies.map((c) => c.name)),
        credential.cookies.map((c) => `${c.name}=${mask(c.value)}`).join('; '),
        encrypt(this.key, JSON.stringify(credential.cookies), id),
        credential.expiresAt === null ? null : credential.expiresAt * 1000,
        createdAt,
        now
      );
    this.bumpVersion();

    const saved = this.list().find((c) => c.id === id);
    if (!saved) throw new Error('Credential was not saved');
    return saved;
  }

  /**
   * Deletes a credential.
   *
   * @param id - Credential id
   * @returns True when a row was removed
   */
  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    if (Number(result.changes) === 0) return false;
    this.bumpVersion();
    return true;
  }

  /**
   * Changes whenever credentials are added, replaced or removed. Lets a running MCP process
   * notice edits made from the dashboard (another process) with one cheap query.
   *
   * @returns Opaque version string
   */
  version(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'credentials_version'").get();
    return (row && str(row, 'value')) ?? '0';
  }

  /**
   * Decrypts every credential's cookies for injection into the browser.
   *
   * @returns Cookies, the ids they came from, and domains that could not be decrypted
   */
  loadCookies(): LoadedCookies {
    const out: LoadedCookies = { cookies: [], ids: [], failed: [] };
    for (const row of this.db.prepare('SELECT id, domain, secret FROM credentials').all()) {
      const id = str(row, 'id') ?? '';
      try {
        const cookies = JSON.parse(
          decrypt(this.key, str(row, 'secret') ?? '', id)
        ) as StoredCookie[];
        out.cookies.push(...cookies);
        out.ids.push(id);
      } catch {
        out.failed.push(str(row, 'domain') ?? id);
      }
    }
    return out;
  }

  /**
   * Records that the browser received these credentials.
   *
   * @param ids - Credential ids
   */
  markInjected(ids: readonly string[]): void {
    const statement = this.db.prepare('UPDATE credentials SET last_injected_at = ? WHERE id = ?');
    const now = Date.now();
    for (const id of ids) statement.run(now, id);
  }

  /**
   * Identities (domain|path|name, no values) of the cookies last injected into the profile,
   * shared across processes so a deleted credential can be removed from the browser later.
   *
   * @returns Cookie identity keys
   */
  injectedKeys(): string[] {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'injected_cookies'").get();
    const parsed: unknown = JSON.parse((row && str(row, 'value')) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  }

  /**
   * Stores the identities of the cookies just injected.
   *
   * @param keys - Cookie identity keys (domain|path|name)
   */
  setInjectedKeys(keys: readonly string[]): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('injected_cookies', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
      )
      .run(JSON.stringify(keys));
  }

  private bumpVersion(): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('credentials_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
      )
      .run(randomUUID());
  }
}
