import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, access, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCooldownLock } from './overlay-cooldown.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'reset-radar-cooldown-lock-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  return join(directory,'cooldown.json');
}

test('real exclusive owner-only locks serialize callers and release after success',async (t) => {
  const path = await fixture(t);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const order = [];
  const first = withCooldownLock(path,async () => {
    if (process.platform !== 'win32') assert.equal((await stat(`${path}.lock`)).mode & 0o777,0o600);
    order.push('first'); entered(); await held; order.push('first-finished');
  });
  await started;
  const second = withCooldownLock(path,async () => { order.push('second'); });
  release();
  await Promise.all([first,second]);
  assert.deepEqual(order,['first','first-finished','second']);
  await assert.rejects(access(`${path}.lock`),{code:'ENOENT'});
});

test('callback failure releases only the acquired lock so a following attempt can proceed',async (t) => {
  const path = await fixture(t);
  await assert.rejects(withCooldownLock(path,async () => { throw new Error('operation failed'); }),/operation failed/);
  await assert.rejects(access(`${path}.lock`),{code:'ENOENT'});
  assert.equal(await withCooldownLock(path,async () => 'ok'),'ok');
});

test('an existing or leftover lock times out without entering or removing it',async (t) => {
  const path = await fixture(t);
  await writeFile(`${path}.lock`,'existing owner',{mode:0o600});
  let entered = false;
  await assert.rejects(withCooldownLock(path,async () => { entered = true; },{timeoutMs:0}),/remains locked/);
  assert.equal(entered,false);
  assert.equal(await readFile(`${path}.lock`,'utf8'),'existing owner');
});

test('aborting a waiter never removes another caller lock',async (t) => {
  const path = await fixture(t);
  await writeFile(`${path}.lock`,'active owner',{mode:0o600});
  const controller = new AbortController();
  let entered = false;
  await assert.rejects(withCooldownLock(path,async () => { entered = true; },{
    signal:controller.signal,sleep:async () => { controller.abort(new Error('cancelled')); },
  }),/cancelled/);
  assert.equal(entered,false);
  assert.equal(await readFile(`${path}.lock`,'utf8'),'active owner');
});

test('a replaced lock is detected and left intact instead of deleting another owner',async (t) => {
  const path = await fixture(t);
  await assert.rejects(withCooldownLock(path,async () => {
    await rename(`${path}.lock`,`${path}.old-lock`);
    await writeFile(`${path}.lock`,'replacement owner',{mode:0o600});
  }),/ownership changed/);
  assert.equal(await readFile(`${path}.lock`,'utf8'),'replacement owner');
});
