import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Loads the AES-256 key: `READIT_SECRET_KEY` (base64, 32 bytes) if set, otherwise the key file,
 * creating it (mode 0600, directory 0700) on first use.
 *
 * @param keyFile - Path of the key file
 * @returns 32-byte key
 * @throws When the env var or file does not hold a 32-byte base64 key
 */
export function loadSecretKey(keyFile: string): Buffer {
  const fromEnv = process.env.READIT_SECRET_KEY;
  if (fromEnv) return decodeKey(fromEnv, 'READIT_SECRET_KEY');

  if (!existsSync(keyFile)) {
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    writeFileSync(keyFile, `${randomBytes(KEY_BYTES).toString('base64')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  }
  chmodSync(keyFile, 0o600);
  return decodeKey(readFileSync(keyFile, 'utf8'), keyFile);
}

function decodeKey(raw: string, source: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== KEY_BYTES)
    throw new Error(`${source} must contain a base64-encoded ${KEY_BYTES}-byte key`);
  return key;
}

/**
 * Encrypts with AES-256-GCM. `aad` (e.g. the row id) is authenticated but not stored, so a
 * ciphertext copied to another row fails to decrypt.
 *
 * @param key - 32-byte key
 * @param plaintext - Data to protect
 * @param aad - Associated data bound to the ciphertext
 * @returns `v1:<base64(iv | tag | ciphertext)>`
 */
export function encrypt(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
}

/**
 * Decrypts a value produced by {@link encrypt}.
 *
 * @param key - 32-byte key
 * @param payload - `v1:...` string
 * @param aad - Same associated data used to encrypt
 * @returns Plaintext
 * @throws When the key is wrong, the data was tampered with, or the format is unknown
 */
export function decrypt(key: Buffer, payload: string, aad: string): string {
  const [version, body] = payload.split(':', 2);
  if (version !== VERSION || !body) throw new Error('Unknown secret format');
  const raw = Buffer.from(body, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
