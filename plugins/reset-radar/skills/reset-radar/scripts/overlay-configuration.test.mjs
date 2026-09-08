import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_API_BASE } from './api-client.mjs';
import { loadConfiguration, writePrivateFile } from './configuration.mjs';
import { saveOverlayKey } from './overlay-configuration.mjs';

const KEY = `rr_live_${'a'.repeat(12)}_${'b'.repeat(43)}`;
const REPLACEMENT = `rr_live_${'c'.repeat(12)}_${'d'.repeat(43)}`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'radar-overlay-key-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  return {directory, environment:{RESET_RADAR_STATE_DIR:directory}, path:join(directory, 'api-key')};
}

function safeFailure(code, forbidden) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    for (const value of forbidden) assert.ok(!String(error).includes(value));
    return true;
  };
}

test('missing Key becomes a loadable private configuration after saving', async t => {
  const {environment, path} = await fixture(t);
  await assert.rejects(loadConfiguration(environment), /Set up/);
  const configuration = await saveOverlayKey(`  ${KEY}\n`, environment);
  assert.deepEqual(configuration, {apiBase:DEFAULT_API_BASE, apiKey:KEY});
  assert.deepEqual(await loadConfiguration(environment), configuration);
  assert.equal(await readFile(path, 'utf8'), `${KEY}\n`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('replacement saves and loads the new Key without changing the chosen API base', async t => {
  const {environment, path} = await fixture(t);
  environment.RESET_RADAR_API_BASE = 'https://example.com/member/v1/';
  await saveOverlayKey(KEY, environment);
  const replacement = await saveOverlayKey(REPLACEMENT, environment);
  assert.deepEqual(replacement, {apiBase:'https://example.com/member/v1', apiKey:REPLACEMENT});
  assert.equal(await readFile(path, 'utf8'), `${REPLACEMENT}\n`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('the configured Key file is honored instead of the default state file', async t => {
  const {directory, environment, path} = await fixture(t);
  environment.RESET_RADAR_API_KEY_FILE = join(directory, 'selected', 'member-key');
  await saveOverlayKey(KEY, environment);
  assert.equal((await loadConfiguration(environment)).apiKey, KEY);
  assert.equal((await stat(environment.RESET_RADAR_API_KEY_FILE)).mode & 0o777, 0o600);
  await assert.rejects(stat(path), {code:'ENOENT'});
});

test('invalid, non-string and oversized input does not overwrite or create files', async t => {
  const {directory, environment, path} = await fixture(t);
  const invalidValues = [null, undefined, 12, {}, ['not a string'], '', 'bad', 'x'.repeat(513),
    `${KEY}\n${REPLACEMENT}`];
  for (const value of invalidValues) {
    await assert.rejects(saveOverlayKey(value, environment),
      safeFailure('OVERLAY_KEY_INVALID', [KEY, REPLACEMENT, directory]));
  }
  assert.deepEqual(await readdir(directory), []);
  await saveOverlayKey(KEY, environment);
  for (const value of invalidValues) {
    await assert.rejects(saveOverlayKey(value, environment), {code:'OVERLAY_KEY_INVALID'});
    assert.equal(await readFile(path, 'utf8'), `${KEY}\n`);
  }
});

test('invalid interface configuration is rejected before an existing Key is replaced', async t => {
  const {directory, environment, path} = await fixture(t);
  await saveOverlayKey(KEY, environment);
  await assert.rejects(saveOverlayKey(REPLACEMENT,
    {...environment, RESET_RADAR_API_BASE:`https://user:${REPLACEMENT}@example.com`}),
  safeFailure('OVERLAY_KEY_INVALID', [KEY, REPLACEMENT, directory]));
  assert.equal(await readFile(path, 'utf8'), `${KEY}\n`);
});

test('an explicit environment Key never produces a misleading file replacement', async t => {
  const {directory, environment, path} = await fixture(t);
  await saveOverlayKey(KEY, environment);
  for (const envKey of [KEY, 'invalid-environment-key', '']) {
    await assert.rejects(saveOverlayKey(REPLACEMENT,
      {...environment, RESET_RADAR_API_KEY:envKey}),
    safeFailure('OVERLAY_KEY_ENV_OVERRIDE', [KEY, REPLACEMENT, directory]));
    assert.equal(await readFile(path, 'utf8'), `${KEY}\n`);
  }
});

test('write failures expose neither Key nor private filesystem path', async t => {
  const {directory, environment} = await fixture(t);
  const parentFile = join(directory, 'private-parent');
  await writePrivateFile(parentFile, 'unchanged');
  await assert.rejects(saveOverlayKey(KEY,
    {...environment, RESET_RADAR_API_KEY_FILE:join(parentFile, 'key')}),
  safeFailure('OVERLAY_KEY_SAVE_FAILED', [KEY, directory, parentFile]));
  assert.equal(await readFile(parentFile, 'utf8'), 'unchanged');
  assert.deepEqual(await readdir(directory), ['private-parent']);
});
