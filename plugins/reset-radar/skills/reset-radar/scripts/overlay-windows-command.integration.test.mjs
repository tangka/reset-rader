import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { takeRefreshCommand } from './overlay-windows.mjs';

test('atomic command claim preserves the next click on the real filesystem', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-command-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'refresh.json');
  await writeFile(path, '{"type":"refresh"}', { mode: 0o600 });
  assert.equal(await takeRefreshCommand(path, {
    read: async (claimedPath) => {
      assert.notEqual(claimedPath, path);
      await writeFile(path, '{"type":"refresh"}', { mode: 0o600 });
      return readFile(claimedPath, 'utf8');
    },
    remove: unlink,
  }), true);
  assert.deepEqual(await readdir(directory), ['refresh.json']);
  assert.equal(await takeRefreshCommand(path, {
    read: (claimedPath) => readFile(claimedPath, 'utf8'), remove: unlink,
  }), true);
  assert.deepEqual(await readdir(directory), []);
});
