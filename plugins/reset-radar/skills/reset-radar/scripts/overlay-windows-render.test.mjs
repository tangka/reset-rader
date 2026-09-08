import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { windowsSystemEnvironment } from './windows-environment.mjs';

test('Windows PowerShell renderer clears stale display data without WPF', {
  skip: process.platform !== 'win32',
}, () => {
  const env = windowsSystemEnvironment();
  const root = env.SystemRoot || env.windir;
  assert.ok(root && win32.isAbsolute(root), 'Windows must provide an absolute system directory');
  const command = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = fileURLToPath(new URL('./overlay-windows-render.test.ps1', import.meta.url));
  const result = spawnSync(command, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], { env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'Renderer assertions must finish within the timeout');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Windows renderer assertions passed/);
});
