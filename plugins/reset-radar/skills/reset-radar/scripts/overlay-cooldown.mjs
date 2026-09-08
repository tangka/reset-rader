import * as filesystem from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Hold only the shared cooldown read/modify/write, never the network request. */
export async function withCooldownLock(path, operation, { signal, fsImpl = filesystem,
  timeoutMs = 2000, clock = Date.now, sleep = (ms, options) => delay(ms, undefined, options) } = {}) {
  signal?.throwIfAborted();
  const lockPath = `${path}.lock`;
  await fsImpl.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = clock() + timeoutMs;
  let handle;
  while (!handle) {
    signal?.throwIfAborted();
    try { handle = await fsImpl.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw new Error('Cannot acquire the private overlay cooldown lock.');
      if (clock() >= deadline) {
        throw new Error('Overlay cooldown remains locked. Another process or a leftover lock needs checking; no lock was removed.');
      }
      await sleep(Math.min(25, Math.max(1, deadline - clock())), { signal });
    }
  }
  let identity;
  try {
    identity = await handle.stat();
    if (!identity.isFile() || (identity.mode & 0o077)
        || (process.getuid && identity.uid !== process.getuid())) {
      throw new Error('Overlay cooldown lock must be an owner-only regular file.');
    }
    signal?.throwIfAborted();
    return await operation();
  } finally {
    try {
      if (!identity) throw new Error('Cannot verify the acquired overlay cooldown lock; it was not removed.');
      const current = await fsImpl.lstat(lockPath);
      if (!current.isFile() || current.isSymbolicLink()
          || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error('Overlay cooldown lock ownership changed; the replacement was not removed.');
      }
      await fsImpl.unlink(lockPath);
    } finally { await handle.close(); }
  }
}
