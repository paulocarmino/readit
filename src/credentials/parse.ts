import { UserFacingError } from '../errors.js';

/** A cookie as stored and injected into the browser. `expires` is unix seconds. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

/** Credential kinds the dashboard knows how to guide. */
export type CredentialKind = 'reddit' | 'generic';

/** Output of the parsers, ready to be encrypted and saved. */
export interface ParsedCredential {
  kind: CredentialKind;
  /** Registrable domain the credential is for (unique key). */
  domain: string;
  label: string | null;
  cookies: StoredCookie[];
  /** Earliest cookie expiry (unix seconds), when known. */
  expiresAt: number | null;
}

const DEFAULT_TTL_SECONDS = 180 * 24 * 60 * 60;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_COOKIES = 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function assertCookie(name: string, value: string): void {
  if (!COOKIE_NAME.test(name)) throw new UserFacingError(`Invalid cookie name "${name}".`);
  if (value === '') throw new UserFacingError(`Cookie "${name}" has an empty value.`);
  if (/[;\r\n]/.test(value))
    throw new UserFacingError(`Cookie "${name}" value contains ";" or a line break.`);
}

/**
 * Reads the `exp` claim of a JWT without verifying it.
 *
 * @param token - Possible JWT
 * @returns Expiry in unix seconds, or null when it is not a JWT with exp
 */
export function jwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'exp' in payload &&
      typeof payload.exp === 'number'
    ) {
      return payload.exp;
    }
  } catch {
    // Not a JWT.
  }
  return null;
}

/**
 * Normalizes what the user typed as domain ("https://www.example.com/x" → "example.com").
 *
 * @param input - Domain or URL
 * @returns Lowercase hostname without "www."
 * @throws UserFacingError when it is not a hostname
 */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    throw new UserFacingError(`Invalid domain "${input}".`);
  }
  host = host.replace(/^\.+/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host))
    throw new UserFacingError(`Invalid domain "${input}".`);
  return host;
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1');
}

/**
 * Builds a Reddit credential from the value of the `reddit_session` cookie.
 * Accepts the bare value or `reddit_session=<value>`.
 *
 * @param rawValue - What the user pasted
 * @param label - Optional name (e.g. the account)
 * @returns Credential with one HttpOnly, Secure cookie on .reddit.com
 */
export function parseRedditCredential(rawValue: string, label?: string | null): ParsedCredential {
  const value = stripQuotes(
    rawValue
      .trim()
      .replace(/^reddit_session\s*=\s*/i, '')
      .replace(/;$/, '')
  );
  assertCookie('reddit_session', value);
  if (value.length < 20)
    throw new UserFacingError('This does not look like a reddit_session value (too short).');

  const expires = jwtExpiry(value) ?? nowSeconds() + DEFAULT_TTL_SECONDS;
  if (expires < nowSeconds())
    throw new UserFacingError(
      'This reddit_session has already expired. Log in again and copy a fresh one.'
    );

  return {
    kind: 'reddit',
    domain: 'reddit.com',
    label: label?.trim() || null,
    cookies: [
      {
        name: 'reddit_session',
        value,
        domain: '.reddit.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'None',
        expires,
      },
    ],
    expiresAt: expires,
  };
}

function sameSiteFrom(value: unknown): StoredCookie['sameSite'] {
  if (typeof value !== 'string') return undefined;
  const v = value.toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'lax') return 'Lax';
  if (v === 'none' || v === 'no_restriction') return 'None';
  return undefined;
}

function cookieFromJson(item: unknown, fallbackDomain: string): StoredCookie {
  if (typeof item !== 'object' || item === null)
    throw new UserFacingError('Cookie JSON items must be objects.');
  const record = item as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '';
  const value = typeof record.value === 'string' ? record.value : '';
  assertCookie(name, value);

  const expiresRaw = record.expirationDate ?? record.expires;
  const expires =
    typeof expiresRaw === 'number' && expiresRaw > 0
      ? Math.floor(expiresRaw)
      : nowSeconds() + DEFAULT_TTL_SECONDS;
  const sameSite = sameSiteFrom(record.sameSite);
  const secure = record.secure === true || sameSite === 'None';

  return {
    name,
    value,
    domain: typeof record.domain === 'string' && record.domain ? record.domain : fallbackDomain,
    path: typeof record.path === 'string' && record.path ? record.path : '/',
    secure,
    httpOnly: record.httpOnly === true,
    ...(sameSite ? { sameSite } : {}),
    expires,
  };
}

function cookieFromPair(name: string, value: string, domain: string): StoredCookie {
  const cleanName = name.trim();
  const cleanValue = stripQuotes(value);
  assertCookie(cleanName, cleanValue);
  return {
    name: cleanName,
    value: cleanValue,
    domain,
    path: '/',
    secure: true,
    httpOnly: true,
    expires: nowSeconds() + DEFAULT_TTL_SECONDS,
  };
}

/**
 * Builds a credential for any site from pasted cookies. Accepted formats:
 * - JSON array exported by Cookie-Editor / EditThisCookie
 * - a `Cookie:` request header (`a=1; b=2`), with or without the `Cookie:` prefix
 * - one `name=value` per line
 * - rows copied from the DevTools cookie table (tab-separated: name, value, domain, path...)
 *
 * @param domainInput - Site domain or URL
 * @param text - Pasted cookies
 * @param label - Optional name
 * @returns Parsed credential
 * @throws UserFacingError on unparseable input
 */
export function parseGenericCredential(
  domainInput: string,
  text: string,
  label?: string | null
): ParsedCredential {
  const domain = normalizeDomain(domainInput);
  const cookieDomain = `.${domain}`;
  const input = text.trim();
  if (input === '') throw new UserFacingError('Paste at least one cookie.');

  let cookies: StoredCookie[];
  if (input.startsWith('[') || input.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(input);
    } catch {
      throw new UserFacingError('The text looks like JSON but does not parse.');
    }
    const items = Array.isArray(json) ? json : [json];
    cookies = items.map((item) => cookieFromJson(item, cookieDomain));
  } else if (input.includes('\t')) {
    cookies = input
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [name = '', value = '', rowDomain, path] = line.split('\t');
        const cookie = cookieFromPair(name, value, rowDomain?.trim() || cookieDomain);
        return path?.trim() ? { ...cookie, path: path.trim() } : cookie;
      });
  } else {
    const header = input.replace(/^cookie:\s*/i, '');
    cookies = header
      .split(/;|\r?\n/)
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => {
        const eq = part.indexOf('=');
        if (eq <= 0)
          throw new UserFacingError(`Cannot read "${part.slice(0, 40)}": expected name=value.`);
        return cookieFromPair(part.slice(0, eq), part.slice(eq + 1), cookieDomain);
      });
  }

  if (cookies.length === 0) throw new UserFacingError('No cookies found in the pasted text.');
  if (cookies.length > MAX_COOKIES)
    throw new UserFacingError(
      `Too many cookies (${cookies.length}); paste only the ones needed for login.`
    );

  const expiries = cookies.map((c) => c.expires).filter((e): e is number => e !== undefined);
  return {
    kind: 'generic',
    domain,
    label: label?.trim() || null,
    cookies,
    expiresAt: expiries.length > 0 ? Math.min(...expiries) : null,
  };
}
