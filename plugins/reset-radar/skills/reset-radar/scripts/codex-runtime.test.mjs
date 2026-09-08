import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import test from 'node:test';
import { resolveCodexRuntime } from './codex-runtime.mjs';

const SYSTEM = '/Applications/Codex.app';
const USER = '/Users/example/Applications/ChatGPT.app';
const CUSTOM = '/Volumes/Work Tools/Private Codex.app';
const binary = (app) => `${app}/Contents/Resources/codex`;

function fixture({ apps = [], running = [], platform = 'darwin', environment = {},
  ids = {}, missing = [], links = {}, standalone = [], denied = [] } = {}) {
  const directories = new Set(apps);
  const files = new Set([...apps.map(binary), ...standalone]);
  for (const path of missing) files.delete(path);
  const commands = [];
  const absent = () => { throw Object.assign(new Error('private metadata'), { code: 'ENOENT' }); };
  const options = {
    platform, environment, home: '/Users/example',
    fsImpl: {
      async realpath(path) {
        if (!directories.has(path) && !files.has(path) && !links[path]) absent();
        return links[path] || path;
      },
      async stat(path) {
        if (!directories.has(path) && !files.has(path)) absent();
        return { isDirectory: () => directories.has(path), isFile: () => files.has(path) };
      },
      async access(path, mode) {
        assert.equal(mode, constants.X_OK);
        if (!files.has(path) || denied.includes(path)) absent();
      },
    },
    async executeImpl(command, args, settings) {
      commands.push({ command, args, settings });
      assert.equal(settings.shell, false);
      assert.deepEqual(settings.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
      if (command === '/bin/ps') {
        assert.deepEqual(args, ['-axo', 'comm=']);
        return { stdout: running.map((path) => `${path}/Contents/MacOS/Codex`).join('\n') };
      }
      assert.equal(command, '/usr/libexec/PlistBuddy');
      assert.deepEqual(args.slice(0, 2), ['-c', 'Print :CFBundleIdentifier']);
      const app = args[2].replace(/\/Contents\/Info.plist$/, '');
      return { stdout: ids[app] || 'com.openai.codex\n' };
    },
  };
  return { options, commands };
}

test('without a desktop, preserve the legacy PATH choice; never launch an app', async () => {
  const f = fixture();
  assert.deepEqual(await resolveCodexRuntime(f.options), { command: 'codex', source: 'path' });
  assert.deepEqual(f.commands.map((call) => call.command), ['/bin/ps']);
});

test('prefer a verified running custom-location app, without codex on PATH', async () => {
  const f = fixture({ apps: [SYSTEM, CUSTOM], running: [CUSTOM, CUSTOM],
    environment: { PATH: '/no-cli', RESET_RADAR_API_KEY: 'private-test-key', NODE_OPTIONS: 'never-forward' } });
  assert.deepEqual(await resolveCodexRuntime(f.options), {
    command: binary(CUSTOM), source: 'desktop', appPath: CUSTOM,
  });
  assert.equal(f.commands.length, 2);
});

test('detect both supported app names in the system and user Applications directories', async () => {
  for (const app of [SYSTEM, '/Applications/ChatGPT.app', USER, '/Users/example/Applications/Codex.app']) {
    const f = fixture({ apps: [app] });
    assert.equal((await resolveCodexRuntime(f.options)).command, binary(app));
  }
});

test('before install, while available, and after removal resolve from current state', async () => {
  for (const apps of [[], [SYSTEM], []]) {
    const runtime = await resolveCodexRuntime(fixture({ apps }).options);
    assert.equal(runtime.source, apps.length ? 'desktop' : 'path');
  }
});

test('wrong bundle identity, missing or non-executable binary, and external links are not run', async () => {
  for (const overrides of [
    { ids: { [SYSTEM]: 'com.example.other' } },
    { missing: [binary(SYSTEM)] },
    { denied: [binary(SYSTEM)] },
    { links: { [binary(SYSTEM)]: '/external/codex' }, standalone: ['/external/codex'] },
  ]) {
    const f = fixture({ apps: [SYSTEM], running: [SYSTEM], ...overrides });
    assert.equal((await resolveCodexRuntime(f.options)).source, 'path');
  }
});

test('explicit custom app selection is honored; invalid overrides do not fall back', async () => {
  const f = fixture({ apps: [CUSTOM, SYSTEM], environment: { RESET_RADAR_CODEX_APP: CUSTOM } });
  assert.equal((await resolveCodexRuntime(f.options)).command, binary(CUSTOM));
  assert.ok(f.commands.every((call) => call.command !== '/bin/ps'));
  for (const path of ['', 'relative.app', '/missing.app', `${CUSTOM}\n`, '/Applications']) {
    await assert.rejects(resolveCodexRuntime(fixture({ apps: [SYSTEM],
      environment: { RESET_RADAR_CODEX_APP: path } }).options), { code: 'local_codex_runtime_invalid' });
  }
});

test('explicit executable wins over desktop overrides and safely preserves spaces', async () => {
  const path = '/Volumes/Tools With Spaces/codex';
  const f = fixture({ apps: [SYSTEM], standalone: [path], environment: {
    RESET_RADAR_CODEX_PATH: path, RESET_RADAR_CODEX_APP: '/invalid.app',
  } });
  assert.deepEqual(await resolveCodexRuntime(f.options), { command: path, source: 'explicit' });
  assert.equal(f.commands.length, 0);
  for (const value of ['', 'codex', '/missing/executable', `${path}\n`]) {
    await assert.rejects(resolveCodexRuntime(fixture({ apps: [SYSTEM],
      environment: { RESET_RADAR_CODEX_PATH: value } }).options), { code: 'local_codex_runtime_invalid' });
  }
});

test('ambiguous running or installed desktops require a user selection', async () => {
  for (const running of [[], [SYSTEM, USER]]) {
    await assert.rejects(resolveCodexRuntime(fixture({ apps: [SYSTEM, USER], running }).options), {
      code: 'local_codex_runtime_ambiguous',
    });
  }
});

test('other platforms keep CLI fallback and do not execute macOS inspection commands', async () => {
  for (const platform of ['linux', 'win32']) {
    const f = fixture({ platform, apps: [SYSTEM] });
    assert.equal((await resolveCodexRuntime(f.options)).source, 'path');
    assert.equal(f.commands.length, 0);
  }
});

test('inspection failure can use installed apps; cancellation never becomes PATH fallback', async () => {
  const f = fixture({ apps: [SYSTEM] });
  const inspect = f.options.executeImpl;
  f.options.executeImpl = async (command, ...args) => {
    if (command === '/bin/ps') throw new Error('private process metadata');
    return inspect(command, ...args);
  };
  assert.equal((await resolveCodexRuntime(f.options)).source, 'desktop');
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.executeImpl = async () => { controller.abort(); throw new Error('cancelled'); };
  await assert.rejects(resolveCodexRuntime(f.options), { name: 'AbortError' });
  await assert.rejects(resolveCodexRuntime({ ...f.options, signal: AbortSignal.abort() }), { name: 'AbortError' });
});
