import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// node:sqlite prints an ExperimentalWarning on load. It goes to stderr (harmless for MCP), but it
// is noise in every client log, so drop that one warning before importing the module.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  (originalEmitWarning as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { DatabaseSync } = await import('node:sqlite');

/** Open SQLite handle. */
export type Database = DatabaseSyncType;

/** Schema migrations, applied in order; `PRAGMA user_version` tracks the last applied one. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE calls (
    id          TEXT PRIMARY KEY,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER,
    tool        TEXT NOT NULL,
    url         TEXT,
    host        TEXT,
    adapter     TEXT,
    status      TEXT NOT NULL,
    chars       INTEGER,
    source      TEXT,
    error       TEXT,
    client      TEXT,
    pid         INTEGER NOT NULL,
    args        TEXT
  );
  CREATE INDEX calls_started_at ON calls (started_at);

  CREATE TABLE logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    time      INTEGER NOT NULL,
    level     INTEGER NOT NULL,
    call_id   TEXT,
    pid       INTEGER NOT NULL,
    component TEXT,
    msg       TEXT NOT NULL,
    data      TEXT
  );
  CREATE INDEX logs_call_id ON logs (call_id);
  CREATE INDEX logs_time ON logs (time);

  CREATE TABLE credentials (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL,
    label            TEXT,
    domain           TEXT NOT NULL UNIQUE,
    cookie_names     TEXT NOT NULL,
    preview          TEXT NOT NULL,
    secret           TEXT NOT NULL,
    expires_at       INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    last_injected_at INTEGER
  );

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

/**
 * Opens (creating if needed) the shared SQLite database and applies migrations.
 * WAL + busy_timeout let several MCP processes and the dashboard use it at the same time.
 *
 * @param path - Database file path
 * @returns Open database
 */
export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

  const row = db.prepare('PRAGMA user_version').get();
  const current = typeof row?.user_version === 'number' ? row.user_version : 0;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}

/**
 * Reads a string column from a row, or null.
 *
 * @param row - Row returned by node:sqlite
 * @param key - Column name
 * @returns The string value, or null when missing / not a string
 */
export function str(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Reads a numeric column from a row, or null.
 *
 * @param row - Row returned by node:sqlite
 * @param key - Column name
 * @returns The number, or null when missing / not numeric
 */
export function num(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}
