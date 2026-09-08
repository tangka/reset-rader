import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { readWindowsPrivateFile, writeWindowsPrivateFile } from './windows-private-file.mjs';

const PRIVATE_PATH = 'C:\\Users\\test-user\\private radar\\api-key';
const PRIVATE_CONTENT = 'test-only-radar-secret-绝不外传\n';
const SAFE_MESSAGE = 'Cannot access private radar Key file; check Windows owner and ACL permissions.';

// Every call injects this fake: the suite never starts Windows or reads a real Key.
function fakeProcess(onRequest = () => {}) {
  const child = new EventEmitter();
  const chunks = [];
  child.requests = [];
  child.killCount = 0;
  child.kill = () => { child.killCount += 1; return true; };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.complete = (response, code = 0) => {
    if (response !== undefined) child.stdout.write(JSON.stringify(response));
    child.stdout.end();
    child.emit('exit', code);
    child.emit('close', code);
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
    final(callback) {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      child.requests.push(request);
      callback();
      setImmediate(() => onRequest(request, child));
    },
  });
  return child;
}

async function withEnvironment(values, run) {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function withWindowsRoot(run) {
  return withEnvironment({ SystemRoot: 'C:\\Windows' }, run);
}

function safeError(code = 'EPRIVATE') {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, SAFE_MESSAGE);
    assert.equal(error.cause, undefined);
    assert.equal(error.path, undefined);
    assert.equal(error.stderr, undefined);
    assert.deepEqual(Object.keys(error), ['code']);
    assert.doesNotMatch(String(error.stack), /test-only-radar-secret|test-user|untrusted diagnostic/);
    return true;
  };
}

test('read sends only a stdin request, preserves UTF-8 content, and uses a fixed PowerShell script', async () => {
  await withWindowsRoot(async () => {
    let invocation;
    const child = fakeProcess((_request, process) => {
      const response = Buffer.from(JSON.stringify({ ok: true, content: PRIVATE_CONTENT }));
      const split = response.indexOf(Buffer.from('绝')) + 1;
      process.stdout.write(response.subarray(0, split));
      process.stdout.write(response.subarray(split));
      process.complete();
    });
    const result = await readWindowsPrivateFile(PRIVATE_PATH, {
      spawnProcess: (...args) => { invocation = args; return child; },
    });
    const [command, args, options] = invocation;
    assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(args.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.equal(args.length, 7);
    assert.match(args[6], /[\\/]windows-private-file\.ps1$/);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
    assert.doesNotMatch(JSON.stringify([command, args, options]), /test-only-radar-secret|test-user/);
    assert.deepEqual(child.requests, [{ operation: 'read', path: PRIVATE_PATH }]);
    assert.equal(result, PRIVATE_CONTENT);
  });
});

test('write sends Key content only through stdin and scrubs inherited Radar credential variables', async () => {
  await withEnvironment({
    SystemRoot: 'C:\\Windows',
    RESET_RADAR_API_KEY: PRIVATE_CONTENT,
    RESET_RADAR_API_KEY_FILE: PRIVATE_PATH,
  }, async () => {
    let invocation;
    const child = fakeProcess((_request, process) => process.complete({ ok: true }));
    await writeWindowsPrivateFile(PRIVATE_PATH, PRIVATE_CONTENT, {
      spawnProcess: (...args) => { invocation = args; return child; },
    });
    assert.deepEqual(child.requests, [{ operation: 'write', path: PRIVATE_PATH, content: PRIVATE_CONTENT }]);
    const [command, args, options] = invocation;
    assert.ok(options.env, 'explicit environment must prevent credential inheritance');
    assert.equal(options.env.RESET_RADAR_API_KEY, undefined);
    assert.equal(options.env.RESET_RADAR_API_KEY_FILE, undefined);
    assert.equal(options.env.SystemRoot, 'C:\\Windows');
    assert.doesNotMatch(JSON.stringify([command, args, options]), /test-only-radar-secret|test-user/);
  });
});

test('a missing file preserves only ENOENT from a valid successful-process response', async () => {
  await withWindowsRoot(async () => {
    const child = fakeProcess((_request, process) => {
      process.stderr.write('untrusted diagnostic: ' + PRIVATE_CONTENT);
      process.complete({ ok: false, code: 'ENOENT', message: PRIVATE_CONTENT, path: PRIVATE_PATH });
    });
    await assert.rejects(readWindowsPrivateFile(PRIVATE_PATH, { spawnProcess: () => child }), safeError('ENOENT'));
  });
});

test('ACL denial and unknown helper failures never expose private response fields or stderr', async () => {
  await withWindowsRoot(async () => {
    for (const code of ['EPRIVATE', 'EACCES', PRIVATE_CONTENT, undefined]) {
      const child = fakeProcess((_request, process) => {
        process.stderr.write('untrusted diagnostic: ' + PRIVATE_CONTENT + PRIVATE_PATH);
        process.complete({ ok: false, code, message: PRIVATE_CONTENT, cause: { path: PRIVATE_PATH } });
      });
      await assert.rejects(readWindowsPrivateFile(PRIVATE_PATH, { spawnProcess: () => child }), safeError());
    }
  });
});

test('nonzero exit rejects even a success or ENOENT response', async () => {
  await withWindowsRoot(async () => {
    for (const response of [{ ok: true, content: PRIVATE_CONTENT }, { ok: false, code: 'ENOENT' }, undefined]) {
      const child = fakeProcess((_request, process) => process.complete(response, 1));
      await assert.rejects(readWindowsPrivateFile(PRIVATE_PATH, { spawnProcess: () => child }), safeError());
    }
  });
});

test('spawn exceptions and child process errors are redacted, including ENOENT spawn errors', async () => {
  await withWindowsRoot(async () => {
    await assert.rejects(readWindowsPrivateFile(PRIVATE_PATH, {
      spawnProcess: () => { throw Object.assign(new Error(PRIVATE_CONTENT), { code: 'ENOENT', path: PRIVATE_PATH }); },
    }), safeError());
    const child = fakeProcess((_request, process) => {
      process.emit('error', Object.assign(new Error(PRIVATE_CONTENT), { code: 'ENOENT', path: PRIVATE_PATH }));
    });
    await assert.rejects(readWindowsPrivateFile(PRIVATE_PATH, { spawnProcess: () => child }), safeError());
  });
});

test('stdin and stdout stream errors are redacted', async () => {
  await withWindowsRoot(async () => {
    for (const stream of ['stdin', 'stdout']) {
      const child = fakeProcess((_request, process) => process[stream].emit('error', new Error(PRIVATE_CONTENT)));
      await assert.rejects(writeWindowsPrivateFile(PRIVATE_PATH, PRIVATE_CONTENT, {
        spawnProcess: () => child,
      }), safeError());
    }
  });
});

test('timeout kills a stalled helper and rejects with the fixed safe message', async () => {
  await withWindowsRoot(async () => {
    const child = fakeProcess();
    await assert.rejects(readWindowsPrivateFile(PRIVATE_PATH, {
      spawnProcess: () => child, timeoutMs: 10,
    }), safeError());
    assert.equal(child.killCount, 1);
  });
});

test('malformed JSON and invalid result shapes are rejected without private diagnostics', async () => {
  await withWindowsRoot(async () => {
    for (const response of [null, [], {}, { ok: true }, { ok: true, content: 42 }, { ok: 'true', content: PRIVATE_CONTENT }]) {
      const child = fakeProcess((_request, process) => process.complete(response));
      await assert.rejects(readWindowsPrivateFile(PRIVATE_PATH, { spawnProcess: () => child }), safeError());
    }
    const child = fakeProcess((_request, process) => {
      process.stdout.write('untrusted diagnostic: ' + PRIVATE_CONTENT);
      process.complete();
    });
    await assert.rejects(readWindowsPrivateFile(PRIVATE_PATH, { spawnProcess: () => child }), safeError());
  });
});

test('stdout and decoded Key content have independent byte limits', async () => {
  await withWindowsRoot(async () => {
    const excessiveOutput = fakeProcess((_request, process) => process.stdout.write('x'.repeat(524289)));
    await assert.rejects(readWindowsPrivateFile(PRIVATE_PATH, {
      spawnProcess: () => excessiveOutput,
    }), safeError());
    assert.equal(excessiveOutput.killCount, 1);
    const excessiveContent = fakeProcess((_request, process) => {
      process.complete({ ok: true, content: '界'.repeat(21846) });
    });
    await assert.rejects(readWindowsPrivateFile(PRIVATE_PATH, {
      spawnProcess: () => excessiveContent,
    }), safeError());
  });
});
