import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { readLocalCodexRateLimits } from './local-codex.mjs';

const KEY = 'synthetic-radar-key-must-not-leak';
const KEY_FILE = '/synthetic-radar-key-file-must-not-leak';

function quotaProcess() {
  const child = new EventEmitter();
  child.messages = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString());
      child.messages.push(message);
      callback();
      setImmediate(() => {
        if (message.id === 1) child.stdout.write('{"id":1,"result":{}}\n');
        if (message.id === 2) child.stdout.write('{"id":2,"result":{"rateLimits":null}}\n');
      });
    },
  });
  return child;
}

async function spawnedEnvironment(platform, source, discover = false) {
  const environment = Object.freeze({ ...source });
  const before = { ...environment };
  const child = quotaProcess();
  const calls = [];
  let discoveries = 0;
  const result = await readLocalCodexRateLimits({
    platform,
    environment,
    ...(discover ? {} : { codexCommand: '/local/codex' }),
    resolveImpl: async (options) => {
      discoveries += 1;
      assert.equal(options.platform, platform);
      assert.equal(options.environment, environment);
      assert.equal(options.signal.aborted, false);
      return { command: '/local/codex' };
    },
    spawnImpl: (...args) => { calls.push(args); return child; },
  });
  assert.deepEqual(result, { rateLimits: null });
  assert.equal(discoveries, discover ? 1 : 0);
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, '/local/codex');
  assert.deepEqual(args, ['app-server', '--stdio']);
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(child.messages.map(({ method }) => method), [
    'initialize', 'initialized', 'account/rateLimits/read',
  ]);
  assert.notEqual(options.env, environment);
  assert.deepEqual(environment, before, 'normalizing the child environment must not mutate its source');
  assert.doesNotMatch(JSON.stringify([command, args, options, child.messages]), /synthetic-radar-key/);
  return options.env;
}

const posixCases = [
  ['keeps distinct PATH, Path, path, and PaTh names', {
    PATH: '/canonical/bin', Path: '/case-sensitive/bin', path: '/case-sensitive/data', PaTh: '/other/value',
  }],
  ['keeps aliases when exact PATH is missing', { Path: '/mixed/bin', path: '/lower/bin' }],
  ['keeps an empty exact PATH alongside aliases', { PATH: '', Path: '/mixed/bin', path: '/lower/bin' }],
  ['keeps an empty lowercase path without inventing PATH', { path: '' }],
  ['does not invent PATH when every spelling is missing', { LANG: 'C' }],
];

for (const platform of ['darwin', 'linux']) {
  for (const [description, environment] of posixCases) {
    test(`${platform} ${description}`, async () => {
      assert.deepEqual(await spawnedEnvironment(platform, environment), environment);
    });
  }
}

test('win32 prefers exact PATH over aliases regardless of insertion order and removes every alias', async () => {
  const expected = { PATH: 'C:\\canonical', LANG: 'C' };
  for (const environment of [
    { Path: 'C:\\mixed', path: 'C:\\lower', PATH: 'C:\\canonical', pAtH: 'C:\\other', LANG: 'C' },
    { PATH: 'C:\\canonical', pAtH: 'C:\\other', path: 'C:\\lower', Path: 'C:\\mixed', LANG: 'C' },
  ]) {
    assert.deepEqual(await spawnedEnvironment('win32', environment), expected);
  }
});

test('win32 keeps an explicitly empty PATH instead of falling back to an alias', async () => {
  assert.deepEqual(await spawnedEnvironment('win32', {
    Path: 'C:\\fallback', path: 'C:\\other', PATH: '',
  }), { PATH: '' });
});

test('win32 chooses the first lexically sorted alias when exact PATH is absent', async () => {
  const entries = [
    ['path', 'C:\\lower'], ['pAtH', 'C:\\camel'], ['PaTH', 'C:\\selected'], ['Path', 'C:\\title'],
  ];
  for (const ordered of [entries, [...entries].reverse()]) {
    assert.deepEqual(await spawnedEnvironment('win32', Object.fromEntries(ordered)), { PATH: 'C:\\selected' });
  }
});

test('win32 preserves an empty selected alias and removes the other aliases', async () => {
  assert.deepEqual(await spawnedEnvironment('win32', { path: 'C:\\fallback', Path: '' }), { PATH: '' });
});

test('win32 leaves PATH absent when no spelling exists', async () => {
  assert.deepEqual(await spawnedEnvironment('win32', { LANG: 'C' }), { LANG: 'C' });
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} strips Radar Key and Key-file variables before quota RPC`, async () => {
    assert.deepEqual(await spawnedEnvironment(platform, {
      PATH: '/synthetic/tools', KEEP: 'public-value', RESET_RADAR_API_KEY: KEY, RESET_RADAR_API_KEY_FILE: KEY_FILE,
    }), { PATH: '/synthetic/tools', KEEP: 'public-value' });
  });
}

test('win32 strips every capitalization of Radar Key and Key-file variable names', async () => {
  assert.deepEqual(await spawnedEnvironment('win32', {
    PATH: 'C:\\synthetic-tools', KEEP: 'public-value',
    RESET_RADAR_API_KEY: KEY, reset_radar_api_key: KEY, Reset_Radar_Api_Key: KEY,
    RESET_RADAR_API_KEY_FILE: KEY_FILE, reset_radar_api_key_file: KEY_FILE, Reset_Radar_Api_Key_File: KEY_FILE,
  }), { PATH: 'C:\\synthetic-tools', KEEP: 'public-value' });
});

test('runtime discovery receives the selected platform and original environment before quota RPC', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const environment = { PATH: '/synthetic/tools', KEEP: 'public-value' };
    assert.deepEqual(await spawnedEnvironment(platform, environment, true), environment);
  }
});
