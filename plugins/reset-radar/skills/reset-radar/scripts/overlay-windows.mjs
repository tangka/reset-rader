import { randomUUID } from 'node:crypto';
import { lstat, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfiguration, readPrivateFile, stateDirectory, writePrivateFile } from './configuration.mjs';
import { OverlayData } from './overlay-data.mjs';
import { windowsSystemEnvironment } from './windows-environment.mjs';
import { rendererError, waitForWindowsRenderer } from './overlay-windows-host.mjs';

const scriptPath = fileURLToPath(new URL('./overlay-windows.ps1', import.meta.url));

function validSession(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,160}$/.test(value)) throw new Error('Invalid overlay session.');
  return value;
}

export function windowsOverlayPaths(directory, sessionId) {
  const id = validSession(sessionId);
  return {
    statePath: join(directory, `windows-overlay-${id}.json`),
    commandPath: join(directory, `windows-overlay-${id}.command.json`),
  };
}

// The native renderer receives display data only. It never receives configuration or API responses.
export function windowsPayload(data) {
  const payload = data.payload();
  return {
    status: payload.status,
    message: typeof payload.message === 'string' ? payload.message.slice(0, 240) : '',
    nextRefreshAt: Number.isFinite(payload.nextRefreshAt) ? payload.nextRefreshAt : 0,
    refreshing: Boolean(data.inFlight),
    canRefresh: !data.terminal && !data.inFlight && Date.now() >= (data.retryAfterAt || 0),
    report: payload.report || null,
  };
}

async function removeQuietly(path, remove) {
  await remove(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

export async function takeRefreshCommand(path, { read, remove, claim = rename }) {
  const claimedPath = `${path}.${randomUUID()}.claimed`;
  try { await claim(path, claimedPath); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    // Windows PowerShell 5.1 writes UTF-8 with a BOM. Accept it without treating
    // a user click as malformed, while still accepting only the exact command.
    const request = JSON.parse((await read(claimedPath)).replace(/^\uFEFF/,''));
    return request?.type === 'refresh';
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return false;
  } finally {
    await removeQuietly(claimedPath, remove);
  }
}

function windowsPowerShell(environment = process.env) {
  const root = environment.SystemRoot || environment.windir;
  return root ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

async function assertRenderer(script, stat = lstat) {
  try {
    const entry = await stat(script);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error();
  } catch { throw new Error('Windows radar renderer is unavailable; plugin files may be incomplete.'); }
}

/** A native Windows card. It needs neither CDP nor a desktop-client restart. */
export async function runWindowsOverlay({ environment = process.env, platform = process.platform, signal, sessionId = randomUUID(),
  directory = stateDirectory(environment), Data = OverlayData, load = loadConfiguration,
  write = writePrivateFile, read = readPrivateFile, remove = unlink, claim = rename, spawnImpl = spawn,
  stat = lstat, sleep = (ms, options) => delay(ms, undefined, options), emit = () => {}, readyTimeoutMs = 15000 } = {}) {
  if (platform !== 'win32') throw new Error('The native radar card is available on Windows only.');
  signal?.throwIfAborted();
  const configuration = await load(environment);
  const paths = windowsOverlayPaths(resolve(directory), sessionId);
  await assertRenderer(scriptPath, stat);
  const data = new Data(configuration, { directory: resolve(directory) });
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let child;
  let encoded = '';
  let refresh;
  let firstRefresh = true;
  let rendererFailed = false;
  try {
    await write(paths.statePath, JSON.stringify(windowsPayload(data)));
    const rendererEnvironment = windowsSystemEnvironment(environment);
    child = spawnImpl(windowsPowerShell(rendererEnvironment), [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-StatePath', paths.statePath, '-CommandPath', paths.commandPath,
    ], { env: rendererEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    child.on('error', () => { rendererFailed = true; controller.abort(); });
    child.once('exit', (code) => { rendererFailed ||= code !== 0; controller.abort(); });
    try { await waitForWindowsRenderer(child, { signal: combined, timeoutMs: readyTimeoutMs }); }
    catch {
      if (signal?.aborted) return { reason: 'closed' };
      throw rendererError();
    }
    if (combined.aborted) {
      if (signal?.aborted || !rendererFailed) return { reason: 'closed' };
      throw rendererError();
    }
    emit({ type: 'overlay_attached', mode: 'native-windows' });
    while (!combined.aborted) {
      const manual = firstRefresh || (!data.inFlight && await takeRefreshCommand(paths.commandPath, { read, remove, claim }));
      firstRefresh = false;
      if (!data.inFlight) refresh = data.refresh(combined, { manual }).catch(() => {});
      const next = JSON.stringify(windowsPayload(data));
      if (next !== encoded) {
        encoded = next;
        await write(paths.statePath, next);
      }
      try { await sleep(400, { signal: combined }); } catch (error) {
        if (!combined.aborted) throw error;
      }
    }
    if (rendererFailed && !signal?.aborted) throw rendererError();
    return { reason: 'closed' };
  } finally {
    controller.abort();
    await refresh?.catch(() => {});
    if (child && !child.killed) child.kill();
    await removeQuietly(paths.commandPath, remove);
    await removeQuietly(paths.statePath, remove);
  }
}
