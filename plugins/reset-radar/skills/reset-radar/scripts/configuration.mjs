import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { API_KEY_PATTERN, readConfiguration } from './api-client.mjs';
import { readWindowsPrivateFile, writeWindowsPrivateFile } from './windows-private-file.mjs';

export function stateDirectory(environment = process.env) {
  if (environment.RESET_RADAR_STATE_DIR) return resolve(environment.RESET_RADAR_STATE_DIR);
  const root = process.platform === 'win32'
    ? environment.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : join(homedir(), '.config');
  return resolve(join(root, 'reset-radar'));
}

export async function readPrivateFile(path) {
  if (process.platform === 'win32') return readWindowsPrivateFile(path);
  let handle;
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Private radar file must be a regular file.');
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    const unsafePermissions = (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid());
    if (!stat.isFile() || stat.size > 65536 || unsafePermissions) {
      throw new Error('Private radar file must be owner-only (chmod 600).');
    }
    return await handle.readFile('utf8');
  } finally { await handle?.close(); }
}

export async function writePrivateFile(path, content) {
  if (process.platform === 'win32') return writeWindowsPrivateFile(path, content);
  await mkdir(dirname(path), {recursive:true,mode:0o700});
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function loadConfiguration(environment = process.env) {
  if (environment.RESET_RADAR_API_KEY) return readConfiguration(environment);
  const path = environment.RESET_RADAR_API_KEY_FILE || join(stateDirectory(environment), 'api-key');
  let apiKey;
  try { apiKey = await readPrivateFile(path); } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Set up a long-term member API Key first (configure --key-stdin).');
    throw new Error(process.platform === 'win32'
      ? 'Cannot read private radar Key file; check Windows owner and ACL permissions.'
      : 'Cannot read private radar Key file; check owner and chmod 600.');
  }
  return readConfiguration({...environment,RESET_RADAR_API_KEY:apiKey});
}

export async function configureKey(input, environment = process.env) {
  let text = '';
  for await (const chunk of input) {
    text += chunk;
    if (text.length > 512) throw new Error('Invalid API Key input.');
  }
  const key = text.trim();
  if (!API_KEY_PATTERN.test(key)) throw new Error('Invalid API Key input.');
  const path = environment.RESET_RADAR_API_KEY_FILE || join(stateDirectory(environment), 'api-key');
  await writePrivateFile(path, `${key}\n`);
}
