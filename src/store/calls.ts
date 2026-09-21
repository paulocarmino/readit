import type { Database } from './db.js';
import { num, str } from './db.js';

/** Outcome of a tool call. `blocked` = challenge page, `login` = login wall. */
export type CallStatus = 'running' | 'ok' | 'error' | 'blocked' | 'login' | 'invalid';

/** Fields known when a call starts. */
export interface CallStart {
  tool: string;
  url?: string;
  args?: unknown;
  client?: string;
}

/** Fields known when a call ends. */
export interface CallFinish {
  status: CallStatus;
  adapter?: string;
  url?: string;
  chars?: number;
  source?: string;
  error?: string;
}

/** A call row as shown in the dashboard. */
export interface CallRow {
  id: string;
  startedAt: number;
  durationMs: number | null;
  tool: string;
  url: string | null;
  host: string | null;
  adapter: string | null;
  status: string;
  chars: number | null;
  source: string | null;
  error: string | null;
  client: string | null;
  pid: number;
  args: string | null;
}

/** A persisted log line. */
export interface LogRow {
  id: number;
  time: number;
  level: number;
  callId: string | null;
  pid: number;
  component: string | null;
  msg: string;
  data: string | null;
}

/** Aggregates for the usage view. */
export interface UsageStats {
  totals: {
    calls: number;
    ok: number;
    error: number;
    blocked: number;
    login: number;
    chars: number;
  };
  latency: { p50: number | null; p95: number | null; max: number | null };
  byTool: Array<{ name: string; calls: number; failed: number }>;
  byAdapter: Array<{ name: string; calls: number; failed: number; avgMs: number | null }>;
  topHosts: Array<{ name: string; calls: number; failed: number; lastAt: number }>;
  perDay: Array<{ day: string; ok: number; failed: number }>;
}

/** Calls still "running" after this long belonged to a process that died. */
const ABANDONED_AFTER_MS = 5 * 60 * 1000;

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function toCall(row: Record<string, unknown>): CallRow {
  const startedAt = num(row, 'started_at') ?? 0;
  let status = str(row, 'status') ?? 'error';
  if (status === 'running' && Date.now() - startedAt > ABANDONED_AFTER_MS) status = 'abandoned';
  return {
    id: str(row, 'id') ?? '',
    startedAt,
    durationMs: num(row, 'duration_ms'),
    tool: str(row, 'tool') ?? '',
    url: str(row, 'url'),
    host: str(row, 'host'),
    adapter: str(row, 'adapter'),
    status,
    chars: num(row, 'chars'),
    source: str(row, 'source'),
    error: str(row, 'error'),
    client: str(row, 'client'),
    pid: num(row, 'pid') ?? 0,
    args: str(row, 'args'),
  };
}

function toLog(row: Record<string, unknown>): LogRow {
  return {
    id: num(row, 'id') ?? 0,
    time: num(row, 'time') ?? 0,
    level: num(row, 'level') ?? 30,
    callId: str(row, 'call_id'),
    pid: num(row, 'pid') ?? 0,
    component: str(row, 'component'),
    msg: str(row, 'msg') ?? '',
    data: str(row, 'data'),
  };
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

/** Tool-call history and logs, shared by all MCP processes and the dashboard. */
export class CallStore {
  constructor(private readonly db: Database) {}

  /**
   * Records the start of a call.
   *
   * @param id - Call id (also bound to its log lines)
   * @param call - What was called
   */
  start(id: string, call: CallStart): void {
    this.db
      .prepare(
        "INSERT INTO calls (id, started_at, tool, url, host, status, client, pid, args) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)"
      )
      .run(
        id,
        Date.now(),
        call.tool,
        call.url ?? null,
        hostOf(call.url),
        call.client ?? null,
        process.pid,
        call.args === undefined ? null : JSON.stringify(call.args)
      );
  }

  /**
   * Records the outcome of a call.
   *
   * @param id - Call id
   * @param result - Outcome
   */
  finish(id: string, result: CallFinish): void {
    this.db
      .prepare(
        `UPDATE calls SET finished_at = ?, duration_ms = ? - started_at, status = ?, adapter = COALESCE(?, adapter),
           url = COALESCE(?, url), host = COALESCE(?, host), chars = ?, source = ?, error = ? WHERE id = ?`
      )
      .run(
        Date.now(),
        Date.now(),
        result.status,
        result.adapter ?? null,
        result.url ?? null,
        hostOf(result.url),
        result.chars ?? null,
        result.source ?? null,
        result.error ?? null,
        id
      );
  }

  /**
   * Stores a log line.
   *
   * @param entry - Log line without id
   */
  log(entry: Omit<LogRow, 'id'>): void {
    this.db
      .prepare(
        'INSERT INTO logs (time, level, call_id, pid, component, msg, data) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        entry.time,
        entry.level,
        entry.callId,
        entry.pid,
        entry.component,
        entry.msg,
        entry.data
      );
  }

  /**
   * Usage aggregates since a point in time.
   *
   * @param sinceMs - Lower bound (epoch ms); 0 = all time
   * @returns Totals, latency percentiles and breakdowns
   */
  stats(sinceMs: number): UsageStats {
    const failed = "SUM(status NOT IN ('ok', 'running'))";
    const totals =
      this.db
        .prepare(
          `SELECT COUNT(*) AS calls, SUM(status = 'ok') AS ok, SUM(status IN ('error', 'invalid')) AS error,
           SUM(status = 'blocked') AS blocked, SUM(status = 'login') AS login, SUM(COALESCE(chars, 0)) AS chars
         FROM calls WHERE started_at >= ?`
        )
        .get(sinceMs) ?? {};

    const durations = this.db
      .prepare(
        "SELECT duration_ms FROM calls WHERE started_at >= ? AND tool = 'read_page' AND status = 'ok' AND duration_ms IS NOT NULL ORDER BY duration_ms"
      )
      .all(sinceMs)
      .map((row) => num(row, 'duration_ms') ?? 0);

    return {
      totals: {
        calls: num(totals, 'calls') ?? 0,
        ok: num(totals, 'ok') ?? 0,
        error: num(totals, 'error') ?? 0,
        blocked: num(totals, 'blocked') ?? 0,
        login: num(totals, 'login') ?? 0,
        chars: num(totals, 'chars') ?? 0,
      },
      latency: {
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
        max: durations.at(-1) ?? null,
      },
      byTool: this.db
        .prepare(
          `SELECT tool AS name, COUNT(*) AS calls, ${failed} AS failed FROM calls WHERE started_at >= ? GROUP BY tool ORDER BY calls DESC`
        )
        .all(sinceMs)
        .map((row) => ({
          name: str(row, 'name') ?? '',
          calls: num(row, 'calls') ?? 0,
          failed: num(row, 'failed') ?? 0,
        })),
      byAdapter: this.db
        .prepare(
          `SELECT adapter AS name, COUNT(*) AS calls, ${failed} AS failed, AVG(CASE WHEN status = 'ok' THEN duration_ms END) AS avg_ms
           FROM calls WHERE started_at >= ? AND adapter IS NOT NULL GROUP BY adapter ORDER BY calls DESC`
        )
        .all(sinceMs)
        .map((row) => ({
          name: str(row, 'name') ?? '',
          calls: num(row, 'calls') ?? 0,
          failed: num(row, 'failed') ?? 0,
          avgMs: num(row, 'avg_ms'),
        })),
      topHosts: this.db
        .prepare(
          `SELECT host AS name, COUNT(*) AS calls, ${failed} AS failed, MAX(started_at) AS last_at
           FROM calls WHERE started_at >= ? AND host IS NOT NULL GROUP BY host ORDER BY calls DESC LIMIT 12`
        )
        .all(sinceMs)
        .map((row) => ({
          name: str(row, 'name') ?? '',
          calls: num(row, 'calls') ?? 0,
          failed: num(row, 'failed') ?? 0,
          lastAt: num(row, 'last_at') ?? 0,
        })),
      perDay: this.db
        .prepare(
          `SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') AS day,
             SUM(status = 'ok') AS ok, ${failed} AS failed
           FROM calls WHERE started_at >= ? GROUP BY day ORDER BY day`
        )
        .all(sinceMs)
        .map((row) => ({
          day: str(row, 'day') ?? '',
          ok: num(row, 'ok') ?? 0,
          failed: num(row, 'failed') ?? 0,
        })),
    };
  }

  /**
   * Most recent calls, optionally filtered.
   *
   * @param filter - Status, tool, free-text on url/error, and page size
   * @returns Calls, newest first
   */
  recent(filter: { limit: number; status?: string; tool?: string; q?: string }): CallRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status === 'failed') where.push("status NOT IN ('ok', 'running')");
    else if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.tool) {
      where.push('tool = ?');
      params.push(filter.tool);
    }
    if (filter.q) {
      where.push("(url LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\')");
      const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    params.push(filter.limit);
    return this.db
      .prepare(
        `SELECT * FROM calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`
      )
      .all(...params)
      .map(toCall);
  }

  /**
   * One call and its log lines.
   *
   * @param id - Call id
   * @returns Call with logs, or null
   */
  get(id: string): { call: CallRow; logs: LogRow[] } | null {
    const row = this.db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
    if (!row) return null;
    const logs = this.db
      .prepare('SELECT * FROM logs WHERE call_id = ? ORDER BY id')
      .all(id)
      .map(toLog);
    return { call: toCall(row), logs };
  }

  /**
   * Most recent log lines across all processes.
   *
   * @param filter - Minimum pino level and page size
   * @returns Logs, newest first
   */
  logs(filter: { limit: number; minLevel: number }): LogRow[] {
    return this.db
      .prepare('SELECT * FROM logs WHERE level >= ? ORDER BY id DESC LIMIT ?')
      .all(filter.minLevel, filter.limit)
      .map(toLog);
  }

  /**
   * Deletes all calls and logs (credentials are kept).
   */
  clear(): void {
    this.db.exec('DELETE FROM logs; DELETE FROM calls; VACUUM;');
  }
}
