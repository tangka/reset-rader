import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWindowsPrivateFile, writeWindowsPrivateFile } from '../plugins/reset-radar/skills/reset-radar/scripts/windows-private-file.mjs';

// Validate the real cold-start path before parallel suites contend for the runner.
// Use the production deadlines/protocol and disposable synthetic data, never a member Key.
assert.equal(process.platform, 'win32');
const directory = await mkdtemp(join(tmpdir(), 'radar-cold-start-'));
const path = join(directory, 'private-fixture');
try {
  await assert.rejects(readWindowsPrivateFile(path), {code:'ENOENT'});
  await writeWindowsPrivateFile(path, 'synthetic-cold-start-check');
  assert.equal(await readWindowsPrivateFile(path), 'synthetic-cold-start-check');
  console.log('Windows native cold-start, private write, and private read passed.');
} finally {
  await rm(directory, {recursive:true,force:true});
}
