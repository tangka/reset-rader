import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function runtimeSetupMessage(error) {
  return {
    local_codex_runtime_invalid: 'Codex 读取程序路径无效，请检查 RESET_RADAR_CODEX_PATH 或 RESET_RADAR_CODEX_APP。',
    local_codex_runtime_ambiguous: '检测到多个 Codex 桌面程序，请用 RESET_RADAR_CODEX_APP 指定要使用的应用。',
  }[error?.code] || null;
}

function runtimeError(code, message) {
  return Object.assign(new Error(message), { code: `local_codex_runtime_${code}` });
}

function pathImplementation(platform) {
  return platform === 'win32' ? win32 : posix;
}

function absolutePath(value, pathImpl) {
  return typeof value === 'string' && pathImpl.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
}

async function executable(path, fsImpl, pathImpl) {
  if (!absolutePath(path, pathImpl)) throw new Error('Invalid path.');
  const actual = await fsImpl.realpath(path);
  if (!(await fsImpl.stat(actual)).isFile()) throw new Error('Not a file.');
  await fsImpl.access(actual, constants.X_OK);
  return actual;
}

/** Resolve only an executable; never read authentication, launch a desktop or query an account. */
export async function resolveCodexRuntime({ environment = process.env, platform = process.platform,
  home = homedir(), fsImpl = filesystem, executeImpl = execute, signal } = {}) {
  signal?.throwIfAborted();
  const paths = pathImplementation(platform);
  if (Object.hasOwn(environment, 'RESET_RADAR_CODEX_PATH')) {
    try {
      const command = await executable(environment.RESET_RADAR_CODEX_PATH, fsImpl, paths);
      signal?.throwIfAborted();
      return { command, source: 'explicit' };
    } catch {
      signal?.throwIfAborted();
      throw runtimeError('invalid', 'RESET_RADAR_CODEX_PATH must name an existing executable using an absolute path.');
    }
  }

  const inspect = (file, args) => executeImpl(file, args, {
    shell: false, timeout: 2000, maxBuffer: 1024 * 1024, signal,
    // Metadata inspection does not need the member Key or shell/runtime injection settings.
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  const bundleRuntime = async (path) => {
    if (!absolutePath(path, paths) || !path.endsWith('.app')) return null;
    try {
      const appPath = await fsImpl.realpath(path);
      if (!(await fsImpl.stat(appPath)).isDirectory()) return null;
      const { stdout } = await inspect('/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleIdentifier', paths.join(appPath, 'Contents/Info.plist')]);
      if (stdout.trim() !== 'com.openai.codex') return null;
      const command = await executable(paths.join(appPath, 'Contents/Resources/codex'), fsImpl, paths);
      // Do not follow an embedded executable link out of the verified app bundle.
      if (!command.startsWith(appPath + paths.sep)) return null;
      signal?.throwIfAborted();
      return { command, source: 'desktop', appPath };
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  };
  const selectBundle = async (paths) => {
    const found = new Map();
    for (const path of new Set(paths)) {
      signal?.throwIfAborted();
      const runtime = await bundleRuntime(path);
      if (runtime) found.set(runtime.command, runtime);
    }
    if (found.size > 1) {
      throw runtimeError('ambiguous', 'Multiple Codex desktop runtimes found. Set RESET_RADAR_CODEX_APP to the intended app.');
    }
    return found.values().next().value;
  };

  if (Object.hasOwn(environment, 'RESET_RADAR_CODEX_APP')) {
    const runtime = platform === 'darwin' ? await bundleRuntime(environment.RESET_RADAR_CODEX_APP) : null;
    if (!runtime) throw runtimeError('invalid', 'RESET_RADAR_CODEX_APP must name a supported macOS Codex app with its bundled executable.');
    return runtime;
  }
  if (platform === 'darwin') {
    let running = [];
    try {
      const { stdout } = await inspect('/bin/ps', ['-axo', 'comm=']);
      running = stdout.split('\n').flatMap((line) => {
        const match = line.trim().match(/^(\/.*\.app)\/Contents\/MacOS\/(?:Codex|ChatGPT)$/);
        return match ? [match[1]] : [];
      });
    } catch { signal?.throwIfAborted(); }
    const active = await selectBundle(running);
    if (active) return active;
    const installed = await selectBundle([
      paths.join(home, 'Applications/Codex.app'), paths.join(home, 'Applications/ChatGPT.app'),
      '/Applications/Codex.app', '/Applications/ChatGPT.app',
    ]);
    if (installed) return installed;
  }
  signal?.throwIfAborted();
  // Preserve the existing CLI behavior when no compatible desktop runtime is present.
  // Actual executable/protocol/login availability is verified by the quota reader.
  return { command: 'codex', source: 'path' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resolveCodexRuntime().then((runtime) => process.stdout.write(`${JSON.stringify(runtime)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
