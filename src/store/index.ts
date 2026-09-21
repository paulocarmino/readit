import type { Config } from '../config.js';
import { CallStore } from './calls.js';
import { CredentialStore } from './credentials.js';
import { loadSecretKey } from './crypto.js';
import { openDatabase, type Database } from './db.js';

/** Everything persisted in readit.db. */
export interface Stores {
  db: Database;
  calls: CallStore;
  credentials: CredentialStore;
}

/**
 * Opens the database and the secret key.
 *
 * @param config - Paths
 * @returns Stores
 * @throws When the database or key cannot be opened
 */
export function openStores(config: Config): Stores {
  const db = openDatabase(config.dbPath);
  return {
    db,
    calls: new CallStore(db),
    credentials: new CredentialStore(db, loadSecretKey(config.keyFile)),
  };
}
