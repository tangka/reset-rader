import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { readLocalCodexRateLimits as productionRead } from './local-codex.mjs';

// Unit tests must not discover or depend on a desktop installed on the test host.
const readLocalCodexRateLimits = (options) => productionRead({
  resolveImpl: async () => ({ command: 'codex', source: 'path' }), ...options,
});

function fakeProcess(onMessage = () => {}) {
  const child = new EventEmitter();
  child.messages = [];
  child.killCount = 0;
  child.kill = () => { child.killCount += 1; return true; };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.reply = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString());
      child.messages.push(message);
      callback();
      setImmediate(() => onMessage(message, child));
    },
  });
  return child;
}

const cleanup = (child) => {
  assert.equal(child.killCount, 1);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
};

test('only initialize and read quota, scrub Radar secrets, and clean up on success', async () => {
  const quota = { rateLimitsByLimitId: { codex: { secondary: { windowDurationMins: 10080, resetsAt: 1800000000 } } } };
  const child = fakeProcess((message, process) => {
    if (message.id === 1) process.reply({ id: 1, result: {} });
    if (message.id === 2) process.reply({ id: 2, result: quota });
  });
  const previous = process.env.RESET_RADAR_API_KEY;
  const previousFile = process.env.RESET_RADAR_API_KEY_FILE;
  process.env.RESET_RADAR_API_KEY = 'private-radar-test-key';
  process.env.RESET_RADAR_API_KEY_FILE = '/private/radar-key';
  try {
    const result = await readLocalCodexRateLimits({
      codexCommand: '/local/codex',
      spawnImpl(command, args, options) {
        assert.equal(command, '/local/codex');
        assert.deepEqual(args, ['app-server', '--stdio']);
        assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
        assert.equal(options.shell, false);
        assert.equal(options.env.RESET_RADAR_API_KEY, undefined);
        assert.equal(options.env.RESET_RADAR_API_KEY_FILE, undefined);
        assert.equal(options.env.PATH, process.env.PATH);
        return child;
      },
    });
    assert.deepEqual(result, quota);
    assert.deepEqual(child.messages.map((item) => item.method), ['initialize', 'initialized', 'account/rateLimits/read']);
    cleanup(child);
  } finally {
    if (previous === undefined) delete process.env.RESET_RADAR_API_KEY;
    else process.env.RESET_RADAR_API_KEY = previous;
    if (previousFile === undefined) delete process.env.RESET_RADAR_API_KEY_FILE;
    else process.env.RESET_RADAR_API_KEY_FILE = previousFile;
  }
});

test('handles split JSON lines and ignores unrelated notifications', async () => {
  const child = fakeProcess((message, process) => {
    if (message.id === 1) {
      process.stdout.write('{"id":1,');
      process.stdout.write('"result":{}}\n');
      process.reply({ method: 'notification', params: {} });
    }
    if (message.id === 2) process.reply({ id: 2, result: { rateLimits: null } });
  });
  assert.deepEqual(await readLocalCodexRateLimits({ spawnImpl: () => child }), { rateLimits: null });
  cleanup(child);
});

test('RPC and process errors never disclose stderr, message payloads, or credentials', async () => {
  for (const failure of ['initialize', 'quotas', 'spawn', 'stdin', 'stdout', 'stderr', 'exit']) {
    const child = fakeProcess((message, process) => {
      process.stderr.write('a-private-local-token');
      if (failure === 'initialize') process.reply({ id: 1, error: { message: 'a-private-local-token' } });
      else if (failure === 'quotas') {
        if (message.id === 1) process.reply({ id: 1, result: {} });
        if (message.id === 2) process.reply({ id: 2, error: { message: 'a-private-local-token' } });
      } else if (failure === 'spawn') process.emit('error', new Error('a-private-local-token'));
      else if (failure === 'exit') process.emit('exit', 0);
      else process[failure].emit('error', new Error('a-private-local-token'));
    });
    await assert.rejects(readLocalCodexRateLimits({ spawnImpl: () => child }), (error) => {
      assert.equal(error.code, 'local_codex_unavailable');
      assert.doesNotMatch(error.message, /private-local-token/);
      return true;
    });
    cleanup(child);
  }
});

test('timeouts and mid-flight cancellation kill the reader and remove abort listeners', async () => {
  const child = fakeProcess();
  await assert.rejects(readLocalCodexRateLimits({ timeoutMs: 5, spawnImpl: () => child }), { code: 'local_codex_timeout' });
  cleanup(child);
  const controller = new AbortController();
  const cancelled = fakeProcess(() => controller.abort(new Error('private abort reason')));
  await assert.rejects(readLocalCodexRateLimits({ signal: controller.signal, spawnImpl: () => cancelled }), {
    code: 'local_codex_aborted', message: 'Local Codex quota lookup was cancelled.',
  });
  cleanup(cancelled);
});

test('already cancelled call never spawns; synchronous spawn failures are redacted', async () => {
  let spawned = false;
  await assert.rejects(readLocalCodexRateLimits({
    signal: AbortSignal.abort(), spawnImpl: () => { spawned = true; },
  }), { code: 'local_codex_aborted' });
  assert.equal(spawned, false);
  await assert.rejects(readLocalCodexRateLimits({ spawnImpl: () => { throw new Error('private token'); } }), (error) => {
    assert.equal(error.code, 'local_codex_unavailable');
    assert.doesNotMatch(error.message, /private token/);
    return true;
  });
});

test('invalid JSON, invalid results, and excessive stdout or stderr are bounded and redacted', async () => {
  for (const mode of ['json', 'result', 'stdout', 'stderr']) {
    const child = fakeProcess((message, process) => {
      if (mode === 'json') process.stdout.write('private invalid json\n');
      else if (mode === 'stdout' || mode === 'stderr') process[mode].write('x'.repeat(1024 * 1024 + 1));
      else {
        if (message.id === 1) process.reply({ id: 1, result: {} });
        if (message.id === 2) process.reply({ id: 2, result: null });
      }
    });
    await assert.rejects(readLocalCodexRateLimits({ spawnImpl: () => child }), {
      code: mode === 'stdout' || mode === 'stderr' ? 'local_codex_too_large' : 'local_codex_protocol',
    });
    cleanup(child);
  }
});

test('quota reader executes the selected bundled runtime with no CLI on PATH', async () => {
  const environment = { PATH: '/without-codex', RESET_RADAR_API_KEY: 'never-forward' };
  const child = fakeProcess((message, process) => {
    if (message.id === 1) process.reply({ id: 1, result: {} });
    if (message.id === 2) process.reply({ id: 2, result: { rateLimits: null } });
  });
  const result = await productionRead({
    environment,
    resolveImpl: async ({ environment: actual, signal }) => {
      assert.equal(actual, environment);
      assert.equal(signal.aborted, false);
      return { command: '/Applications/Codex.app/Contents/Resources/codex', source: 'desktop' };
    },
    spawnImpl: (command, args, options) => {
      assert.equal(command, '/Applications/Codex.app/Contents/Resources/codex');
      assert.deepEqual(args, ['app-server', '--stdio']);
      assert.equal(options.shell, false);
      assert.deepEqual(options.env, { PATH: '/without-codex' });
      return child;
    },
  });
  assert.deepEqual(result, { rateLimits: null });
  cleanup(child);
});

test('explicit programmatic command bypasses discovery for existing callers', async () => {
  const child = fakeProcess((message, process) => {
    if (message.id === 1) process.reply({ id: 1, result: {} });
    if (message.id === 2) process.reply({ id: 2, result: { rateLimits: null } });
  });
  await productionRead({ codexCommand: '/local/codex',
    resolveImpl: () => assert.fail('Explicit command must not trigger discovery'), spawnImpl: () => child });
  cleanup(child);
});

test('discovery failures are bounded, redact unknown errors, and never spawn', async () => {
  for (const mode of ['cancel', 'timeout', 'unknown', 'invalid']) {
    const controller = new AbortController();
    let spawned = false;
    await assert.rejects(productionRead({ signal: controller.signal, timeoutMs: 20,
      spawnImpl: () => { spawned = true; },
      resolveImpl: async ({ signal }) => {
        if (mode === 'cancel') controller.abort(new Error('private cancellation'));
        if (mode === 'timeout') {
          await new Promise((resolve) => setTimeout(resolve, 30));
          signal.throwIfAborted();
        }
        if (mode === 'invalid') throw Object.assign(new Error('Invalid runtime configuration.'), {
          code: 'local_codex_runtime_invalid',
        });
        throw new Error('private discovery failure');
      },
    }), (error) => {
      assert.equal(error.code, { cancel: 'local_codex_aborted', timeout: 'local_codex_timeout',
        unknown: 'local_codex_unavailable', invalid: 'local_codex_runtime_invalid' }[mode]);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(spawned, false);
  }
});
