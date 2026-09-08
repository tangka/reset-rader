import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { waitForWindowsRenderer } from './overlay-windows-host.mjs';

function host() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  return child;
}

test('renderer readiness accepts a complete marker split across chunks and removes listeners', async () => {
  const child = host();
  const ready = waitForWindowsRenderer(child);
  child.stdout.write('RESET_RADAR_');
  child.stdout.write('READY\r\n');
  await ready;
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('unrecognized renderer output cannot claim readiness or appear in the error', async () => {
  const child = host();
  const ready = waitForWindowsRenderer(child, { timeoutMs: 15 });
  child.stdout.write('fixture-private-value RESET_RADAR_READY\n');
  await assert.rejects(ready, (error) => {
    assert.match(error.message, /renderer/);
    assert.equal(error.message.includes('fixture-private-value'), false);
    return true;
  });
});

test('renderer output is bounded before readiness', async () => {
  const child = host();
  const ready = waitForWindowsRenderer(child);
  child.stdout.write('x'.repeat(4097));
  await assert.rejects(ready, /renderer/);
  assert.equal(child.stdout.listenerCount('data'), 0);
});
