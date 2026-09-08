import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { desktopListeners, validPort } from './overlay-cdp.mjs';

const execute = promisify(execFile);
const APPLICATIONS = [
  { appPath: '/Applications/ChatGPT.app', executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
  { appPath: '/Applications/Codex.app', executable: '/Applications/Codex.app/Contents/MacOS/Codex' },
];

function launchEnvironment(env) {
  // Read only ordinary launch settings. Credentials and runtime injection settings are not inherited.
  const result = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (typeof env[key] === 'string') result[key] = env[key];
  }
  return result;
}

async function requireStopped(listenersImpl, options, signal) {
  signal?.throwIfAborted();
  const state = await listenersImpl(options);
  signal?.throwIfAborted();
  if (!Array.isArray(state?.processes)) throw new Error('Cannot verify whether Codex desktop is running.');
  if (state.processes.length) {
    throw new Error('Codex or ChatGPT desktop is already running. Quit it yourself before debug launch; no app was stopped or restarted.');
  }
}

async function installedApplication(fsImpl, signal) {
  const installed = [];
  for (const candidate of APPLICATIONS) {
    signal?.throwIfAborted();
    try {
      installed.push({ ...candidate, stat: await fsImpl.lstat(candidate.appPath) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot verify the installed desktop application.');
    }
  }
  signal?.throwIfAborted();
  if (!installed.length) throw new Error('No installed ChatGPT.app or Codex.app was found in /Applications.');
  if (installed.length > 1) throw new Error('Both ChatGPT.app and Codex.app are installed. Debug launch is ambiguous; no app was launched.');
  const selected = installed[0];
  try {
    if (selected.stat.isSymbolicLink() || !selected.stat.isDirectory()
        || await fsImpl.realpath(selected.appPath) !== selected.appPath) throw new Error();
    const executableStat = await fsImpl.lstat(selected.executable);
    if (executableStat.isSymbolicLink() || !executableStat.isFile()
        || await fsImpl.realpath(selected.executable) !== selected.executable) throw new Error();
    await fsImpl.access(selected.executable, constants.X_OK);
  } catch {
    throw new Error('The desktop application must contain its real executable at the expected path; symbolic links and invalid installations are rejected.');
  }
  signal?.throwIfAborted();
  return selected;
}

async function allocateLoopbackPort({ signal, createServerImpl }) {
  signal?.throwIfAborted();
  const server = createServerImpl();
  try {
    const listening = once(server, 'listening', { signal });
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true, signal });
    await listening;
    signal?.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      throw new Error('Cannot reserve a local debugging port.');
    }
    return validPort(address.port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(new Error('Cannot release the temporary debugging port.'));
      else resolve();
    }));
  }
}

/** Explicit opt-in only. Launch an already exited desktop without changing its installed files. */
export async function launchDebuggingDesktop({ signal, executeImpl = execute,
  listenersImpl = desktopListeners, platform = process.platform, env = process.env,
  fsImpl = filesystem, reservePortImpl = allocateLoopbackPort, createServerImpl = createServer } = {}) {
  signal?.throwIfAborted();
  if (platform !== 'darwin') throw new Error('Codex desktop debug launch currently supports macOS only.');
  const childEnv = launchEnvironment(env);
  const executeSafely = (file, args, options = {}) => executeImpl(file, args, {
    ...options, env: childEnv, shell: false, signal,
  });
  const inspectionOptions = { executeImpl: executeSafely, platform };
  await requireStopped(listenersImpl, inspectionOptions, signal);
  const { appPath } = await installedApplication(fsImpl, signal);
  const port = validPort(await reservePortImpl({ signal, createServerImpl }));
  signal?.throwIfAborted();
  // A user may have opened the client while the installation or port was being checked.
  await requireStopped(listenersImpl, inspectionOptions, signal);
  try {
    await executeSafely('/usr/bin/open', ['-a', appPath, '--args',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`],
    { timeout: 5000, maxBuffer: 65536 });
  } catch {
    signal?.throwIfAborted();
    throw new Error('The desktop debug launch request failed. No application files or configuration were changed.');
  }
  // Cancellation never tries to terminate a desktop that may already have opened.
  signal?.throwIfAborted();
  return { port, appPath, launched: true };
}
