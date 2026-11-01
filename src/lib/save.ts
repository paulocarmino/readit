import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute } from 'node:path';
import { UserFacingError } from '../errors.js';

const ALLOWED_EXTENSIONS = new Set(['.md', '.txt']);

/**
 * Turns the path given by an agent into a local path. The server may run inside WSL while the
 * client runs on Windows, so Windows and UNC spellings are mapped to their Linux equivalents.
 *
 * @param raw - Path as sent by the agent
 * @param platform - Platform the server runs on
 * @returns Absolute local path
 * @throws UserFacingError when the path is relative or has an unsupported extension
 */
export function resolveSavePath(raw: string, platform: NodeJS.Platform = process.platform): string {
  let path = raw.trim();
  if (platform !== 'win32') {
    const unc = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/][^\\/]+[\\/](.*)$/i.exec(path);
    const drive = /^([a-z]):[\\/](.*)$/i.exec(path);
    if (unc) path = `/${unc[1] ?? ''}`.replaceAll('\\', '/');
    else if (drive)
      path = `/mnt/${(drive[1] ?? '').toLowerCase()}/${drive[2] ?? ''}`.replaceAll('\\', '/');
  }

  if (!isAbsolute(path)) throw new UserFacingError(`save_to must be absolute: ${raw}`, 'invalid');
  if (!ALLOWED_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new UserFacingError(`save_to must end in .md or .txt: ${raw}`, 'invalid');
  }
  return path;
}

/**
 * Writes a document to disk, creating parent folders and replacing any existing file.
 *
 * @param rawPath - Destination as sent by the agent
 * @param content - Full document
 * @returns The local path written
 */
export async function saveDocument(rawPath: string, content: string): Promise<string> {
  const path = resolveSavePath(rawPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return path;
}
