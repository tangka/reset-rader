import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOverlayArguments, runOverlay, waitForDesktop } from './overlay-runner.mjs';

function fixture({install = {installed:true,closed:false,owner:'test-session'}, closed = false,
  failUpdate = false, loadFails = false, unsupported = false} = {}) {
  const controller = new AbortController();
  const calls = [];
  let refreshes = 0;
  let signal;
  class Page {
    async open() { calls.push('open'); }
    async evaluate(expression) {
      if (expression.includes('function installCard')) { calls.push('install'); return install; }
      if (expression.includes('state.remove()')) { calls.push('remove'); return {installed:false}; }
      if (expression.includes('state.update(')) {
        calls.push('update');
        if (failUpdate) throw new Error('disconnected');
        if (loadFails) assert.ok(expression.includes('请先配置长期会员'));
        return {installed:true,owner:'test-session'};
      }
      calls.push('status');
      if (unsupported) return {unsupported:true};
      return {installed:!closed,closed,owner:'test-session'};
    }
    async removeOverlay(sessionId) {
      assert.equal(sessionId,'test-session');
      calls.push('remove');
      return {installed:false};
    }
    close() { calls.push('close'); }
  }
  class Data {
    async refresh(value) { refreshes++; signal = value; }
    payload() { return {status:'loading'}; }
  }
  return {calls,getRefreshes:() => refreshes,getSignal:() => signal,options:{
    target:{id:'test-target'},sessionId:'test-session',Page,Data,
    load:async () => { calls.push('load'); if (loadFails) throw new Error('secret'); return {}; },
    signal:controller.signal,sleep:async () => { controller.abort(); },
  }};
}

test('attach first, then load credentials; host stop cancels data and removes only its session',async () => {
  const f = fixture();
  assert.deepEqual(await runOverlay(f.options),{reason:'stopped'});
  assert.deepEqual(f.calls,['open','install','load','status','update','remove','close']);
  assert.equal(f.getRefreshes(),1);
  assert.equal(f.getSignal().aborted,true);
});

test('existing foreign overlay cannot be replaced and no Key is even loaded',async () => {
  const f = fixture({install:{installed:true,closed:false,owner:'someone-else'}});
  await assert.rejects(runOverlay(f.options),/already has a radar/);
  assert.deepEqual(f.calls,['open','install','close']);
  assert.equal(f.getRefreshes(),0);
});

test('user close stops before starting another fetch',async () => {
  const f = fixture({closed:true});
  assert.deepEqual(await runOverlay(f.options),{reason:'closed'});
  assert.equal(f.getRefreshes(),0);
  assert.deepEqual(f.calls,['open','install','load','status','remove','close']);
});

test('leaving the supported renderer cleans up the owned card without another data fetch',async () => {
  const f = fixture({unsupported:true});
  assert.deepEqual(await runOverlay(f.options),{reason:'renderer_changed'});
  assert.equal(f.getRefreshes(),0);
  assert.deepEqual(f.calls,['open','install','load','status','remove','close']);
});

test('disconnection cleans up while missing Key produces an explicit setup state',async () => {
  const disconnected = fixture({failUpdate:true});
  await assert.rejects(runOverlay(disconnected.options),/disconnected/);
  assert.deepEqual(disconnected.calls.slice(-2),['remove','close']);
  assert.equal(disconnected.getSignal().aborted,true);
  const missing = fixture({loadFails:true});
  await runOverlay(missing.options);
  assert.equal(missing.getRefreshes(),0);
  assert.ok(missing.calls.includes('update'));
});

test('CLI accepts only local port and exact target, never arbitrary evaluation or forced restart',() => {
  assert.deepEqual(parseOverlayArguments(['start','--port','9333','--target','id_1']),
    {command:'start',port:9333,targetId:'id_1'});
  assert.deepEqual(parseOverlayArguments(['launch']),{command:'launch'});
  for (const args of [['start','--url','https://example.com'],['start','--port','9333;cmd'],
    ['launch','--force','true'],['start','--eval','alert()'],['stop'],['start','--port'],
    ['start','--target','a','--target','b']]) assert.throws(() => parseOverlayArguments(args));
});

test('pre-cancellation does not connect, inject or read credentials',async () => {
  const f = fixture();
  await assert.rejects(runOverlay({...f.options,signal:AbortSignal.abort()}),/aborted/);
  assert.deepEqual(f.calls,['close']);
  assert.equal(f.getRefreshes(),0);
});

test('launch wait verifies the returned port and stops on timeout without restarting',async () => {
  let now = 0;
  let calls = 0;
  const options = {port:9333,clock:() => now,sleep:async () => { now+=1000; }};
  const target = await waitForDesktop({...options,find:async ({port}) => {
    calls++;
    assert.equal(port,9333);
    if (calls < 3) throw new Error('not yet');
    return {id:'main',port};
  }});
  assert.equal(target.id,'main');
  assert.equal(calls,3);
  await assert.rejects(waitForDesktop({...options,find:async () => { throw new Error(); }}),/未验证到安全/);
});
