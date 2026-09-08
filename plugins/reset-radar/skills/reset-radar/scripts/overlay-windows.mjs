import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfiguration, readPrivateFile, stateDirectory, writePrivateFile } from './configuration.mjs';
import { OverlayData } from './overlay-data.mjs';

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

export async function takeRefreshCommand(path, { read, remove }) {
  try {
    // Windows PowerShell 5.1 writes UTF-8 with a BOM. Accept it without treating
    // a user click as malformed, while still accepting only the exact command.
    const request = JSON.parse((await read(path)).replace(/^\uFEFF/,''));
    return request?.type === 'refresh';
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return false;
  } finally {
    await removeQuietly(path, remove);
  }
}

function windowsPowerShell(environment = process.env) {
  const root = environment.SystemRoot || environment.WINDIR;
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
  write = writePrivateFile, read = readPrivateFile, remove = unlink, spawnImpl = spawn,
  stat = lstat, sleep = (ms, options) => delay(ms, undefined, options), emit = () => {} } = {}) {
  if (platform !== 'win32') throw new Error('The native radar card is available on Windows only.');
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
  try {
    await write(paths.statePath, JSON.stringify(windowsPayload(data)));
    child = spawnImpl(windowsPowerShell(environment), [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-StatePath', paths.statePath, '-CommandPath', paths.commandPath,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], shell: false });
    child.once('exit', () => controller.abort());
    try { await once(child, 'spawn'); }
    catch { throw new Error('Windows PowerShell could not start the Reset Radar card.'); }
    emit({ type: 'overlay_attached', mode: 'native-windows' });
    while (!combined.aborted) {
      const manual = firstRefresh || await takeRefreshCommand(paths.commandPath, { read, remove });
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
    return { reason: 'closed' };
  } finally {
    controller.abort();
    await refresh?.catch(() => {});
    if (child && !child.killed) child.kill();
    await removeQuietly(paths.commandPath, remove);
    await removeQuietly(paths.statePath, remove);
  }
}
