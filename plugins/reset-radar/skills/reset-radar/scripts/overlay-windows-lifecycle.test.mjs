import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runWindowsOverlay } from './overlay-windows.mjs';

function fixture(t, overrides = {}) {
  const controller = new AbortController();
  const files = new Map();
  const removed = [];
  const events = [];
  const refreshSignals = [];
  let announceSpawn;
  let announceAttachment;
  let running;
  let spawnOptions;
  let spawnArgs;
  const spawned = new Promise(resolve => { announceSpawn = resolve; });
  const attached = new Promise(resolve => { announceAttachment = resolve; });
  class Child extends EventEmitter {
    stdout = new PassThrough();
    killed = false;
    killCount = 0;
    exitCode = null;
    signalCode = null;
    kill() { this.killed = true; this.killCount += 1; return true; }
    exit(code) { this.exitCode = code; this.emit('exit',code,null); }
  }
  const child = new Child();
  class Data {
    terminal = false;
    refresh(signal) {
      refreshSignals.push(signal);
      const pending = new Promise(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort',resolve,{once:true});
      });
      this.inFlight = pending.finally(() => { this.inFlight = null; });
      return this.inFlight;
    }
    payload() { return {status:'loading',message:'synthetic lifecycle data'}; }
  }
  const missing = () => Object.assign(new Error('missing synthetic file'),{code:'ENOENT'});
  const options = {
    platform:'win32', environment:{SystemRoot:'C:/Windows'}, signal:controller.signal,
    sessionId:'lifecycle-session', directory:'C:/synthetic-state', readyTimeoutMs:500, Data,
    load:async () => ({apiKey:'synthetic-key',apiBase:'https://example.test'}),
    stat:async () => ({isFile:() => true,isSymbolicLink:() => false}),
    write:async (path,content) => { files.set(path,content); },
    read:async () => { throw missing(); },
    claim:async () => { throw missing(); },
    remove:async path => { removed.push(path); if (!files.delete(path)) throw missing(); },
    spawnImpl:(_command,args,settings) => {
      spawnArgs = args;
      spawnOptions = settings;
      queueMicrotask(() => { child.emit('spawn'); announceSpawn(); });
      return child;
    },
    emit:event => {
      events.push(event);
      if (event.type === 'overlay_attached') announceAttachment();
    },
    ...overrides,
  };
  t.after(async () => {
    controller.abort();
    await running?.catch(() => {});
    child.stdout.destroy();
  });
  return {
    child,controller,files,removed,events,refreshSignals,spawned,attached,
    start() {
      running = runWindowsOverlay(options);
      running.catch(() => {}); // Tests may drive a failure before awaiting the result.
      return running;
    },
    assertCleaned() {
      assert.ok(child.killed || child.exitCode !== null,'renderer must have stopped');
      assert.ok(child.killCount <= 1,'renderer must not be killed repeatedly');
      assert.equal(files.size,0);
      const statePath = spawnArgs[spawnArgs.indexOf('-StatePath')+1];
      const commandPath = spawnArgs[spawnArgs.indexOf('-CommandPath')+1];
      assert.deepEqual(new Set(removed),new Set([statePath,commandPath]));
      assert.ok(refreshSignals.every(signal => signal.aborted));
      assert.equal(spawnOptions.stdio[1],'pipe');
      assert.equal(spawnOptions.stdio[2],'ignore');
      assert.doesNotMatch(JSON.stringify(events),/private-renderer-test-key|private-debug-detail/);
    },
  };
}

function safeRendererError(error) {
  assert.match(error.message,/renderer|PowerShell|radar card/i);
  assert.doesNotMatch(error.message,/private-renderer-test-key|private-debug-detail/);
  return true;
}

test('spawn alone cannot attach; the complete ready line attaches and exit zero closes normally', {timeout:2000}, async t => {
  const f = fixture(t);
  const running = f.start();
  await f.spawned;
  await nextTurn();
  assert.deepEqual(f.events,[]);
  assert.equal(f.refreshSignals.length,0);
  f.child.stdout.write('RESET_RADAR_');
  await nextTurn();
  assert.deepEqual(f.events,[]);
  f.child.stdout.write('READY\n');
  await f.attached;
  assert.deepEqual(f.events,[{type:'overlay_attached',mode:'native-windows'}]);
  f.child.exit(0);
  assert.deepEqual(await running,{reason:'closed'});
  f.assertCleaned();
});

for (const failure of ['exit', 'error']) {
  test(`a renderer ${failure} before readiness fails safely and cleans up`, {timeout:2000}, async t => {
    const f = fixture(t);
    const running = f.start();
    await f.spawned;
    if (failure === 'exit') f.child.exit(1);
    else f.child.emit('error',new Error('private-renderer-test-key private-debug-detail'));
    await assert.rejects(running,safeRendererError);
    assert.deepEqual(f.events,[]);
    assert.equal(f.refreshSignals.length,0);
    f.assertCleaned();
  });
}

test('readiness timeout fails safely without announcing attachment', {timeout:2000}, async t => {
  const f = fixture(t,{readyTimeoutMs:15});
  await assert.rejects(f.start(),safeRendererError);
  assert.deepEqual(f.events,[]);
  assert.equal(f.refreshSignals.length,0);
  f.assertCleaned();
});

for (const failure of ['exit', 'error']) {
  test(`a renderer ${failure} after readiness is not reported as a normal close`, {timeout:2000}, async t => {
    const f = fixture(t);
    const running = f.start();
    await f.spawned;
    f.child.stdout.write('RESET_RADAR_READY\n');
    await f.attached;
    if (failure === 'exit') f.child.exit(1);
    else f.child.emit('error',new Error('private-renderer-test-key private-debug-detail'));
    await assert.rejects(running,safeRendererError);
    assert.equal(f.events.filter(event => event.type === 'overlay_attached').length,1);
    f.assertCleaned();
  });
}

test('external cancellation after readiness aborts the active data read and cleans up', {timeout:2000}, async t => {
  const f = fixture(t);
  const running = f.start();
  await f.spawned;
  f.child.stdout.write('RESET_RADAR_READY\n');
  await f.attached;
  assert.equal(f.refreshSignals.length,1);
  assert.equal(f.refreshSignals[0].aborted,false);
  f.controller.abort();
  assert.deepEqual(await running,{reason:'closed'});
  f.assertCleaned();
});

test('pre-cancellation never loads configuration or starts a renderer', async () => {
  await assert.rejects(runWindowsOverlay({
    platform:'win32', environment:{}, signal:AbortSignal.abort(), directory:'C:/synthetic-state',
    load:async () => assert.fail('configuration must not be loaded after cancellation'),
    spawnImpl:() => assert.fail('renderer must not spawn after cancellation'),
  }),{name:'AbortError'});
});
