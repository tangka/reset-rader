import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { launchDebuggingDesktop } from './overlay-launch.mjs';

const CHATGPT = '/Applications/ChatGPT.app';
const CODEX = '/Applications/Codex.app';
const executable = (app) => `${app}/Contents/MacOS/${app === CHATGPT ? 'ChatGPT' : 'Codex'}`;

function harness({ apps = [CHATGPT], processes = [], env = {} } = {}) {
  const commands = [];
  const reads = [];
  let inspected = 0;
  let allocated = 0;
  const options = {
    platform: 'darwin', env,
    listenersImpl: async () => { inspected += 1; return { processes, listeners: [] }; },
    executeImpl: async (file, args, settings) => { commands.push({ file, args, settings }); return { stdout: '' }; },
    reservePortImpl: async () => { allocated += 1; return 45123; },
    fsImpl: {
      lstat: async (path) => {
        reads.push(path);
        if (!apps.some((app) => path === app || path === executable(app))) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return { isSymbolicLink: () => false, isDirectory: () => apps.includes(path),
          isFile: () => apps.some((app) => path === executable(app)) };
      },
      realpath: async (path) => path,
      access: async (path, mode) => { assert.equal(mode, constants.X_OK); reads.push(path); },
    },
  };
  return { options, commands, reads, inspected: () => inspected, allocated: () => allocated };
}

test('debug launch is macOS only and does not inspect or spawn on another platform', async () => {
  const h = harness();
  await assert.rejects(launchDebuggingDesktop({ ...h.options, platform: 'linux' }), /macOS only/);
  assert.equal(h.inspected(), 0);
  assert.equal(h.commands.length, 0);
});

test('running desktop without any CDP listener still refuses launch before file access', async () => {
  const h = harness({ processes: [{ pid: 23523, path: executable(CHATGPT) }] });
  await assert.rejects(launchDebuggingDesktop(h.options), /already running/);
  assert.equal(h.reads.length, 0);
  assert.equal(h.allocated(), 0);
  assert.deepEqual(h.commands, []);
});

test('unknown process state fails closed', async () => {
  const h = harness();
  h.options.listenersImpl = async () => ({ listeners: [] });
  await assert.rejects(launchDebuggingDesktop(h.options), /Cannot verify/);
  assert.deepEqual(h.commands, []);
});

test('both installed applications are ambiguous, while no installation is missing', async () => {
  for (const [apps, message] of [[[CHATGPT, CODEX], /ambiguous/], [[], /No installed/]]) {
    const h = harness({ apps });
    await assert.rejects(launchDebuggingDesktop(h.options), message);
    assert.equal(h.allocated(), 0);
    assert.deepEqual(h.commands, []);
  }
});

test('symlink bundles, executable links and redirected ancestor paths are rejected', async () => {
  for (const invalid of ['bundle-link', 'binary-link', 'bundle-realpath', 'binary-realpath', 'permission']) {
    const h = harness();
    const original = h.options.fsImpl.lstat;
    h.options.fsImpl.lstat = async (path) => {
      const stat = await original(path);
      if ((invalid === 'bundle-link' && path === CHATGPT)
          || (invalid === 'binary-link' && path === executable(CHATGPT))) stat.isSymbolicLink = () => true;
      return stat;
    };
    h.options.fsImpl.realpath = async (path) => {
      if ((invalid === 'bundle-realpath' && path === CHATGPT)
          || (invalid === 'binary-realpath' && path === executable(CHATGPT))) return `/tmp/other${path}`;
      return path;
    };
    if (invalid === 'permission') h.options.fsImpl.access = async () => { throw new Error('EACCES'); };
    await assert.rejects(launchDebuggingDesktop(h.options), /real executable/);
    assert.deepEqual(h.commands, []);
  }
});

test('valid exited desktop uses exact open arguments and a sanitized environment', async () => {
  for (const app of [CHATGPT, CODEX]) {
    const env = { HOME: '/Users/test', USER: 'test', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
      RESET_RADAR_API_KEY: 'test-only-key', RESET_RADAR_API_KEY_FILE: '/test-only-key-file',
      NODE_OPTIONS: '--require /unexpected.js', UNRELATED_SECRET: 'not-inherited' };
    const h = harness({ apps: [app], env });
    assert.deepEqual(await launchDebuggingDesktop(h.options), { port: 45123, appPath: app, launched: true });
    assert.equal(h.inspected(), 2);
    assert.equal(h.commands.length, 1);
    const [{ file, args, settings }] = h.commands;
    assert.equal(file, '/usr/bin/open');
    assert.deepEqual(args, ['-a', app, '--args', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=45123']);
    assert.equal(settings.shell, false);
    assert.deepEqual(settings.env, { HOME: env.HOME, USER: env.USER, PATH: env.PATH, LANG: env.LANG });
    assert.equal(env.RESET_RADAR_API_KEY, 'test-only-key');
  }
});

test('no shell interpolation and the default process inspection also receives no credentials', async () => {
  const h = harness({ env: { HOME: '/Users/$(command)', RESET_RADAR_API_KEY: 'never-pass' } });
  delete h.options.listenersImpl;
  h.options.executeImpl = async (file, args, settings) => {
    h.commands.push({ file, args, settings });
    assert.equal(settings.shell, false);
    assert.equal(settings.env.RESET_RADAR_API_KEY, undefined);
    assert.equal(settings.env.HOME, '/Users/$(command)');
    return { stdout: '' };
  };
  await launchDebuggingDesktop(h.options);
  assert.deepEqual(h.commands.map(({ file }) => file), ['/bin/ps', '/bin/ps', '/usr/bin/open']);
  assert.equal(h.commands.some(({ args }) => args.some((arg) => arg.includes('$(command)'))), false);
});

test('a desktop opened during preflight is refused and invalid allocated ports are rejected', async () => {
  const h = harness();
  let checks = 0;
  h.options.listenersImpl = async () => ({ processes: ++checks === 1 ? [] : [{ pid: 1 }], listeners: [] });
  await assert.rejects(launchDebuggingDesktop(h.options), /already running/);
  assert.deepEqual(h.commands, []);
  for (const port of [0, 70000, '45123;echo unsafe']) {
    const invalid = harness();
    invalid.options.reservePortImpl = async () => port;
    await assert.rejects(launchDebuggingDesktop(invalid.options), /CDP port/);
    assert.deepEqual(invalid.commands, []);
  }
});

test('aborted preflight never starts the desktop at any await boundary', async () => {
  for (const stage of ['before', 'inspection', 'filesystem', 'allocation', 'recheck']) {
    const h = harness();
    const controller = new AbortController();
    h.options.signal = controller.signal;
    const abort = () => controller.abort(new Error('user cancelled'));
    if (stage === 'before') abort();
    if (stage === 'inspection') h.options.listenersImpl = async () => { abort(); return { processes: [] }; };
    if (stage === 'filesystem') h.options.fsImpl.access = async () => abort();
    if (stage === 'allocation') h.options.reservePortImpl = async () => { abort(); return 45123; };
    if (stage === 'recheck') {
      let checks = 0;
      h.options.listenersImpl = async () => { if (++checks === 2) abort(); return { processes: [] }; };
    }
    await assert.rejects(launchDebuggingDesktop(h.options), /user cancelled/);
    assert.deepEqual(h.commands, []);
  }
});

test('cancellation after the launch request never kills or restarts a desktop', async () => {
  const h = harness();
  const controller = new AbortController();
  h.options.signal = controller.signal;
  h.options.executeImpl = async (file, args, settings) => {
    h.commands.push({ file, args, settings });
    controller.abort(new Error('user cancelled'));
  };
  await assert.rejects(launchDebuggingDesktop(h.options), /user cancelled/);
  assert.deepEqual(h.commands.map(({ file }) => file), ['/usr/bin/open']);
});

test('launcher failure does not expose raw process errors', async () => {
  const h = harness();
  h.options.executeImpl = async () => { throw new Error('test-only-sensitive-output'); };
  await assert.rejects(launchDebuggingDesktop(h.options), (error) => {
    assert.match(error.message, /launch request failed/);
    assert.equal(error.message.includes('test-only-sensitive-output'), false);
    return true;
  });
});

class FakeServer extends EventEmitter {
  listen(options) {
    this.options = options;
    queueMicrotask(() => this.emit('listening'));
    return this;
  }
  address() { return { address: '127.0.0.1', port: 49321 }; }
  close(callback) { this.closed = true; callback(); }
}

test('temporary port allocation binds only loopback with port zero and closes before opening', async () => {
  const h = harness();
  const server = new FakeServer();
  delete h.options.reservePortImpl;
  h.options.createServerImpl = () => server;
  h.options.executeImpl = async () => { assert.equal(server.closed, true); };
  assert.equal((await launchDebuggingDesktop(h.options)).port, 49321);
  assert.equal(server.options.host, '127.0.0.1');
  assert.equal(server.options.port, 0);
  assert.equal(server.options.exclusive, true);
});

test('cancelled socket allocation closes its server and never opens the desktop', async () => {
  const h = harness();
  const controller = new AbortController();
  const server = new FakeServer();
  server.listen = () => { queueMicrotask(() => controller.abort(new Error('user cancelled'))); return server; };
  delete h.options.reservePortImpl;
  h.options.signal = controller.signal;
  h.options.createServerImpl = () => server;
  await assert.rejects(launchDebuggingDesktop(h.options), { name: 'AbortError' });
  assert.equal(server.closed, true);
  assert.deepEqual(h.commands, []);
});
