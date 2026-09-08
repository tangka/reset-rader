import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { configureKey, loadConfiguration, readPrivateFile, writePrivateFile } from './configuration.mjs';
import { takeRefreshCommand, windowsOverlayPaths } from './overlay-windows.mjs';
import { windowsSystemEnvironment } from './windows-environment.mjs';

const windows = { skip: process.platform !== 'win32' };
const execute = promisify(execFile);
const KEY = `rr_live_${'a'.repeat(12)}_${'b'.repeat(43)}`;
const NEXT_KEY = `rr_live_${'c'.repeat(12)}_${'d'.repeat(43)}`;
const PRIVATE_ERROR = {
  code: 'EPRIVATE',
  message: 'Cannot access private radar Key file; check Windows owner and ACL permissions.',
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'radar-windows-acl-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'key with spaces & apostrophe\'s.txt') };
}

async function icacls(path, ...args) {
  // Only test fixtures are modified; never inspect an installed user's Key.
  await execute(join(process.env.SystemRoot, 'System32', 'icacls.exe'), [path, ...args],
    { windowsHide: true, shell: false, timeout: 10000 });
}

async function writeNativeRefreshCommand(commandPath) {
  const source = await readFile(new URL('./overlay-windows.ps1', import.meta.url), 'utf8');
  const handler = source.match(/^\$Refresh\.Add_Click\(\{ (.+) \}\)\r?$/m)?.[1];
  assert.ok(handler, 'exercise the production refresh handler without opening its WPF window');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())',
    '$CommandPath = [string]$request.path',
    '$libraryPath = [string]$request.libraryPath',
    '. $libraryPath',
    handler,
  ].join('\n');
  const invocation = execute(join(process.env.SystemRoot,
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { env: windowsSystemEnvironment(), windowsHide: true, shell: false, timeout: 15000, maxBuffer: 128 * 1024 });
  invocation.child.stdin.end(JSON.stringify({
    path: commandPath,
    libraryPath: fileURLToPath(new URL('./windows-private-file-library.ps1', import.meta.url)),
  }), 'utf8');
  await invocation;
}

async function consumeNativeRefreshCommand(commandPath) {
  await writeNativeRefreshCommand(commandPath);
  assert.equal(await readPrivateFile(commandPath), '{"type":"refresh"}');
  assert.equal(await takeRefreshCommand(commandPath, { read: readPrivateFile, remove: unlink }), true);
  assert.equal(await takeRefreshCommand(commandPath, { read: readPrivateFile, remove: unlink }), false);
}

test('Windows Key ACL is checked before, during, and after an unsafe permission change', windows, async t => {
  const { directory, path } = await fixture(t);
  const environment = { RESET_RADAR_API_KEY_FILE: path };
  await configureKey([KEY], environment);
  assert.equal((await loadConfiguration(environment)).apiKey, KEY);

  await icacls(path, '/grant', '*S-1-1-0:(R)');
  try {
    await assert.rejects(loadConfiguration(environment), /private radar.*ACL/);
    await assert.rejects(configureKey([NEXT_KEY], environment), PRIVATE_ERROR);
    await assert.rejects(readPrivateFile(path), PRIVATE_ERROR);
    assert.equal(await readFile(path, 'utf8'), `${KEY}\n`);
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    await icacls(path, '/remove:g', '*S-1-1-0');
  }

  assert.equal((await loadConfiguration(environment)).apiKey, KEY);
  await configureKey([NEXT_KEY], environment);
  assert.equal((await loadConfiguration(environment)).apiKey, NEXT_KEY);
});

test('Windows refuses a shared writable custom state directory without changing existing contents', windows, async t => {
  const { directory, path } = await fixture(t);
  await writePrivateFile(path, KEY);
  assert.equal(await readPrivateFile(path), KEY);
  await icacls(directory, '/grant', '*S-1-1-0:(M)');
  try {
    await assert.rejects(readPrivateFile(path), PRIVATE_ERROR);
    await assert.rejects(writePrivateFile(path, NEXT_KEY), PRIVATE_ERROR);
    assert.equal(await readFile(path, 'utf8'), KEY);
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    await icacls(directory, '/remove:g', '*S-1-1-0');
  }
  assert.equal(await readPrivateFile(path), KEY);
  await writePrivateFile(path, NEXT_KEY);
  assert.equal(await readPrivateFile(path), NEXT_KEY);
});

test('Windows reports missing files safely and never modifies a directory passed as a Key', windows, async t => {
  const { directory, path } = await fixture(t);
  await assert.rejects(readPrivateFile(path), { ...PRIVATE_ERROR, code: 'ENOENT' });
  await assert.rejects(readPrivateFile(directory), PRIVATE_ERROR);
  await assert.rejects(writePrivateFile(directory, KEY), PRIVATE_ERROR);
  assert.deepEqual(await readdir(directory), []);
});

test('Windows native refresh commands remain private and readable after atomic claim', windows, async t => {
  const { directory } = await fixture(t);
  const stateDirectory = join(directory, "private overlay & apostrophe's");
  const { statePath, commandPath } = windowsOverlayPaths(stateDirectory, 'acl-fixture');
  // Create the same private inheritable directory used before the native renderer starts.
  await writePrivateFile(statePath, '{"status":"loading"}');
  for (let click = 0; click < 2; click += 1) {
    await consumeNativeRefreshCommand(commandPath);
    assert.deepEqual(await readdir(stateDirectory), ['windows-overlay-acl-fixture.json']);
  }
  assert.equal(await readPrivateFile(statePath), '{"status":"loading"}');
});

test('Windows native refresh files stay private in a custom directory readable by Everyone', windows, async t => {
  const { directory } = await fixture(t);
  const stateDirectory = join(directory, 'read-shared custom state');
  const { statePath, commandPath } = windowsOverlayPaths(stateDirectory, 'read-shared-fixture');
  await writePrivateFile(statePath, '{"status":"loading"}');
  await consumeNativeRefreshCommand(commandPath);

  // Read-only inheritance is allowed on the directory, but never on a private file.
  await icacls(stateDirectory, '/grant', '*S-1-1-0:(OI)(CI)(R)');
  try {
    await consumeNativeRefreshCommand(commandPath);
    assert.equal(await readPrivateFile(statePath), '{"status":"loading"}');
    assert.deepEqual(await readdir(stateDirectory), ['windows-overlay-read-shared-fixture.json']);
  } finally {
    await icacls(stateDirectory, '/remove:g', '*S-1-1-0');
  }

  await consumeNativeRefreshCommand(commandPath);
  assert.deepEqual(await readdir(stateDirectory), ['windows-overlay-read-shared-fixture.json']);
});
