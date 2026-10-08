import { homedir } from 'node:os';
import { join } from 'node:path';

/** Runtime configuration, read from environment variables. */
export interface Config {
  /** Persistent Chromium profile directory (cookies, logins). */
  profileDir: string;
  /** Default mode for launches that do not explicitly ask for a visible window. */
  headless: boolean;
  /** Close the headless browser after this many ms without tool calls (0 disables). */
  idleMs: number;
  /** Navigation / request timeout in ms. */
  timeoutMs: number;
  /** Default max characters returned by read_page. */
  maxChars: number;
  /** SQLite file with call history, logs and encrypted credentials. */
  dbPath: string;
  /** AES-256 key file used to encrypt credentials (kept outside the data dir). */
  keyFile: string;
  /** Dashboard access token file (kept across restarts so the link can be bookmarked). */
  dashboardTokenFile: string;
  /** Dashboard HTTP port (bound to 127.0.0.1). */
  dashboardPort: number;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Builds the configuration from environment variables, applying defaults.
 *
 * @returns The resolved configuration
 */
export function loadConfig(): Config {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const dataDir = join(dataHome, 'readit');
  return {
    profileDir: process.env.READIT_PROFILE_DIR ?? join(dataDir, 'profile'),
    dbPath: process.env.READIT_DB_PATH ?? join(dataDir, 'readit.db'),
    keyFile: process.env.READIT_KEY_FILE ?? join(configHome, 'readit', 'secret.key'),
    dashboardTokenFile: join(configHome, 'readit', 'dashboard.token'),
    dashboardPort: intFromEnv('READIT_DASHBOARD_PORT', 7777),
    headless: process.env.READIT_HEADLESS !== 'false',
    idleMs: intFromEnv('READIT_IDLE_MS', 10 * 60 * 1000),
    timeoutMs: intFromEnv('READIT_TIMEOUT_MS', 30_000),
    maxChars: intFromEnv('READIT_MAX_CHARS', 40_000),
  };
}
