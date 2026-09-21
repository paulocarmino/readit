import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { parseGenericCredential, parseRedditCredential } from '../credentials/parse.js';
import { UserFacingError, errorMessage } from '../errors.js';
import { createLogger } from '../logger.js';
import { openStores, type Stores } from '../store/index.js';

const PUBLIC_DIR = new URL('../../public/', import.meta.url);
const STATIC_FILES: Record<string, string> = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/app.css': 'app.css',
};
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const AUTH_COOKIE = 'readit_dash';
const MAX_BODY_BYTES = 256 * 1024;
const RANGES: Record<string, number> = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: 0 };

const credentialInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reddit'),
    value: z.string().min(1),
    label: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal('generic'),
    domain: z.string().min(1),
    cookies: z.string().min(1),
    label: z.string().max(80).optional(),
  }),
]);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type = 'application/json; charset=utf-8'
): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // No keep-alive: the WSL localhost relay can leave the browser holding a socket the server
    // already closed, and browsers do not retry a POST on it ("Failed to fetch").
    Connection: 'close',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value));
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Body too large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function openInBrowser(url: string): void {
  const [command, args] = process.env.WSL_DISTRO_NAME
    ? ['explorer.exe', [url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is printed anyway.
  }
}

/**
 * Routes one API request. Returns false when the path is not an API route.
 */
async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  stores: Stores
): Promise<boolean> {
  const { calls, credentials } = stores;
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET' && path === '/api/info') {
    const config = loadConfig();
    json(res, 200, {
      dbPath: config.dbPath,
      keyFile: config.keyFile,
      profileDir: config.profileDir,
    });
    return true;
  }
  if (method === 'GET' && path === '/api/stats') {
    const range = RANGES[url.searchParams.get('range') ?? '7d'] ?? RANGES['7d'] ?? 0;
    json(res, 200, calls.stats(range === 0 ? 0 : Date.now() - range));
    return true;
  }
  if (method === 'GET' && path === '/api/calls') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);
    json(
      res,
      200,
      calls.recent({
        limit,
        status: url.searchParams.get('status') ?? undefined,
        tool: url.searchParams.get('tool') ?? undefined,
        q: url.searchParams.get('q') ?? undefined,
      })
    );
    return true;
  }
  const callMatch = /^\/api\/calls\/([\w-]+)$/.exec(path);
  if (method === 'GET' && callMatch?.[1]) {
    const call = calls.get(callMatch[1]);
    if (!call) throw new HttpError(404, 'Call not found');
    json(res, 200, call);
    return true;
  }
  if (method === 'GET' && path === '/api/logs') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 300) || 300, 2000);
    const minLevel = Number(url.searchParams.get('level') ?? 30) || 30;
    json(res, 200, calls.logs({ limit, minLevel }));
    return true;
  }
  if (method === 'DELETE' && path === '/api/history') {
    calls.clear();
    json(res, 200, { ok: true });
    return true;
  }
  if (method === 'GET' && path === '/api/credentials') {
    json(res, 200, credentials.list());
    return true;
  }
  if (method === 'POST' && path === '/api/credentials') {
    const parsed = credentialInput.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
    const input = parsed.data;
    const credential =
      input.kind === 'reddit'
        ? parseRedditCredential(input.value, input.label)
        : parseGenericCredential(input.domain, input.cookies, input.label);
    json(res, 201, credentials.save(credential));
    return true;
  }
  const credMatch = /^\/api\/credentials\/([\w-]+)$/.exec(path);
  if (method === 'DELETE' && credMatch?.[1]) {
    if (!credentials.remove(credMatch[1])) throw new HttpError(404, 'Credential not found');
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}

/**
 * Starts the local dashboard: usage stats, call history with per-call logs, and credential
 * management. Bound to 127.0.0.1 and protected by a per-run token (exchanged for an HttpOnly,
 * SameSite=Strict cookie), Host/Origin checks against DNS rebinding and CSRF, and a strict CSP.
 *
 * @param options - Whether to open the browser automatically
 */
export async function startDashboard(options: { open: boolean }): Promise<void> {
  const config = loadConfig();
  const stores = openStores(config);
  const logger = createLogger().child({ component: 'dashboard' });
  const port = config.dashboardPort;
  const token = randomBytes(24).toString('base64url');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer((req, res) => {
    void (async () => {
      const host = req.headers.host ?? '';
      if (!allowedHosts.has(host)) return send(res, 421, 'Misdirected request', 'text/plain');
      const url = new URL(req.url ?? '/', `http://${host}`);

      // Token exchange: the printed URL carries ?token=..., which becomes an HttpOnly cookie.
      const queryToken = url.searchParams.get('token');
      if (queryToken !== null) {
        if (!sameToken(queryToken, token)) return send(res, 401, 'Invalid token', 'text/plain');
        res.writeHead(303, {
          Location: '/',
          'Set-Cookie': `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          'Referrer-Policy': 'no-referrer',
          Connection: 'close',
        });
        return res.end();
      }

      const authed = sameToken(cookieValue(req, AUTH_COOKIE) ?? '', token);
      if (!authed) {
        return send(
          res,
          401,
          'Not authorized. Open the URL printed by `pnpm dashboard` (the token changes on every start).',
          'text/plain; charset=utf-8'
        );
      }

      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin !== undefined && !allowedHosts.has(origin.replace(/^http:\/\//, ''))) {
          return send(res, 403, 'Cross-origin request refused', 'text/plain');
        }
      }

      try {
        if (url.pathname.startsWith('/api/')) {
          if (await handleApi(req, res, url, stores)) return;
          throw new HttpError(404, 'Not found');
        }
        const file = STATIC_FILES[url.pathname];
        if (method !== 'GET' || !file) throw new HttpError(404, 'Not found');
        const body = await readFile(new URL(file, PUBLIC_DIR), 'utf8');
        send(res, 200, body, MIME[extname(file)] ?? 'text/plain');
      } catch (error) {
        const status =
          error instanceof HttpError ? error.status : error instanceof UserFacingError ? 400 : 500;
        if (status === 500)
          logger.error({ error: errorMessage(error), path: url.pathname }, 'Dashboard error');
        json(res, status, { error: errorMessage(error) });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const link = `http://localhost:${port}/?token=${token}`;
  process.stderr.write(
    `\n  readit-idgaf dashboard\n  ${link}\n\n  db:  ${config.dbPath}\n  key: ${config.keyFile}\n\n`
  );
  if (options.open) openInBrowser(link);

  const stop = (): void => {
    server.close();
    stores.db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
