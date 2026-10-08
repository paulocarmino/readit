import pino from 'pino';
import type { CallStore } from './store/calls.js';

/** Logger type used across the project. */
export type Logger = pino.Logger;

/** Fields pino adds that are not worth persisting per line. */
const OMIT_FIELDS = new Set([
  'level',
  'time',
  'msg',
  'callId',
  'component',
  'pid',
  'hostname',
  'name',
  'v',
]);

/**
 * Stream that stores pino JSON lines in SQLite. Never throws: losing a log line must not break a tool call.
 *
 * @param store - Call/log store
 * @returns pino destination
 */
function sqliteStream(store: CallStore): pino.DestinationStream {
  return {
    write(line: string): void {
      try {
        const entry: unknown = JSON.parse(line);
        if (typeof entry !== 'object' || entry === null) return;
        const record = entry as Record<string, unknown>;
        const data: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record))
          if (!OMIT_FIELDS.has(key)) data[key] = value;
        store.log({
          time: typeof record.time === 'number' ? record.time : Date.now(),
          level: typeof record.level === 'number' ? record.level : 30,
          callId: typeof record.callId === 'string' ? record.callId : null,
          pid: typeof record.pid === 'number' ? record.pid : process.pid,
          component: typeof record.component === 'string' ? record.component : null,
          msg: typeof record.msg === 'string' ? record.msg : '',
          data: Object.keys(data).length > 0 ? JSON.stringify(data) : null,
        });
      } catch {
        // Best effort.
      }
    },
  };
}

function isLevel(value: string): value is pino.Level {
  return ['fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(value);
}

/**
 * Creates the root logger. Always writes to stderr (fd 2), because stdout is the MCP stdio
 * channel. With a store, info+ lines are also persisted for the dashboard.
 *
 * @param store - Optional call/log store
 * @returns Logger
 */
export function createLogger(store?: CallStore): Logger {
  const requested = process.env.READIT_LOG_LEVEL ?? 'info';
  const level: pino.Level = isLevel(requested) ? requested : 'info';
  const streams: pino.StreamEntry[] = [{ level, stream: pino.destination(2) }];
  if (store) streams.push({ level: 'info', stream: sqliteStream(store) });

  // The root level must let through everything any stream wants.
  const rootLevel: pino.Level = (pino.levels.values[level] ?? 30) < 30 ? level : 'info';
  return pino({ name: 'readit', level: rootLevel }, pino.multistream(streams));
}
