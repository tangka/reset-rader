import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runOverlay } from './overlay-runner.mjs';

function fixture({states = [{refreshRequestId:0}], Data,
  load = async () => ({apiKey:'old'}), save = async () => ({apiKey:'new'}),
  onSleep = async () => {}, onStatus = () => {}} = {}) {
  const controller = new AbortController();
  const calls = [];
  const payloads = [];
  let iteration = 0;
  const status = () => ({installed:true,closed:false,owner:'session',...states[iteration]});
  class Page {
    async open() {}
    async evaluate(expression) {
      if (expression.includes('function installCard')) return {installed:true,owner:'session'};
      if (!expression.includes('state.update(')) {
        onStatus(controller);
        return status();
      }
      return vm.runInNewContext(expression, {window:{__resetRadarOverlayV1:{
        owner:'session', update(payload) { payloads.push(payload); return status(); }, status,
      }}});
    }
    async takeConfiguration() { return {requestId:1,key:'fixture-key'}; }
    async removeOverlay() { calls.push({type:'removed'}); }
    close() { calls.push({type:'closed'}); }
  }
  class DefaultData {
    async refresh(signal, options) { calls.push({type:'refresh',signal,options}); }
    payload() { return {status:'loading'}; }
  }
  return {controller,calls,payloads,options:{
    target:{id:'offline-fixture'},sessionId:'session',environment:{},Page,Data:Data || DefaultData,
    load,save,signal:controller.signal,sleep:async () => {
      await onSleep(iteration,controller);
      if (++iteration >= states.length) controller.abort();
      await Promise.resolve();
    },
  }};
}

test('manual clicks are acknowledged once; duplicate, old and malformed request IDs stay automatic', async () => {
  const f = fixture({states:[0,1,1,NaN,-1,0,2,2].map(refreshRequestId => ({refreshRequestId}))});
  await runOverlay(f.options);
  const refreshes = f.calls.filter(call => call.type === 'refresh');
  assert.equal(refreshes.length,8);
  assert.deepEqual(refreshes.map(call => call.options?.manual === true),
    [false,true,false,false,false,false,true,false]);
  assert.deepEqual(f.payloads.map(payload => payload.refreshRequestId),[0,1,1,1,1,1,2,2]);
  assert.ok(f.payloads.every(payload => payload.canRefresh && !payload.refreshing));
  assert.ok(f.payloads.every(payload => payload.refreshBlockedUntil === 0));
});

test('clicks during a running fetch merge without queuing another manual fetch after completion', async () => {
  const started = [];
  let resolveInitial;
  class Data {
    refresh(signal, options) {
      if (started.length && !options?.manual) return Promise.resolve();
      started.push(options?.manual === true ? 'manual' : 'auto');
      const operation = new Promise(resolve => {
        if (started.length === 1) resolveInitial = resolve;
        signal.addEventListener('abort',resolve,{once:true});
      });
      this.inFlight = operation.finally(() => { this.inFlight = null; });
      return this.inFlight;
    }
    payload() { return {status:'loading'}; }
  }
  const f = fixture({Data,states:[0,1,1,2].map(refreshRequestId => ({refreshRequestId})),
    onSleep:async iteration => {
      if (iteration === 1) {
        resolveInitial();
        await Promise.resolve();
        await Promise.resolve();
      }
    }});
  await runOverlay(f.options);
  assert.deepEqual(started,['auto','manual']);
  assert.deepEqual(f.payloads.map(payload => payload.refreshRequestId),[0,1,1,2]);
  assert.deepEqual(f.payloads.map(payload => payload.refreshing),[true,true,false,true]);
});

test('missing credentials, terminal data and local refresh failures disable manual refresh', async () => {
  const missing = fixture({states:[{refreshRequestId:1}],load:async () => { throw new Error('missing'); }});
  await runOverlay(missing.options);
  assert.equal(missing.payloads[0].canRefresh,false);
  assert.equal(missing.payloads[0].refreshRequestId,1);
  assert.equal(missing.calls.filter(call => call.type === 'refresh').length,0);
  const optionsSeen = [];
  class TerminalData {
    terminal = true;
    retryAfterAt = 123456;
    async refresh(signal, options) { optionsSeen.push(options); }
    payload() { return {status:'error',message:'expired membership'}; }
  }
  const terminal = fixture({Data:TerminalData,states:[{refreshRequestId:1}]});
  await runOverlay(terminal.options);
  assert.deepEqual(optionsSeen,[undefined]);
  assert.equal(terminal.payloads[0].canRefresh,false);
  assert.equal(terminal.payloads[0].refreshBlockedUntil,123456);
  class FailedData {
    async refresh() { throw new Error('private details'); }
    payload() { return {status:'loading'}; }
  }
  const failed = fixture({Data:FailedData,states:[{refreshRequestId:0},{refreshRequestId:1}]});
  await runOverlay(failed.options);
  assert.equal(failed.payloads.at(-1).canRefresh,false);
  assert.ok(!JSON.stringify(failed.payloads).includes('private details'));
});

test('a simultaneous Key replacement drains old data and discards its pending manual click', async () => {
  const events = [];
  class Data {
    constructor(configuration) { this.name = configuration.apiKey; events.push(`new:${this.name}`); }
    refresh(signal, options) {
      events.push(`${this.name}:${options?.manual ? 'manual' : 'auto'}`);
      if (this.name === 'new') return Promise.resolve();
      this.inFlight = new Promise(resolve => signal.addEventListener('abort',() => {
        events.push('old:drained');
        resolve();
      },{once:true})).finally(() => { this.inFlight = null; });
      return this.inFlight;
    }
    payload() { return {status:'loading',message:this.name}; }
  }
  const f = fixture({Data,states:[{refreshRequestId:0},
    {refreshRequestId:1,configurationPending:true},{refreshRequestId:1}]});
  await runOverlay(f.options);
  assert.ok(events.indexOf('old:drained') < events.indexOf('new:new'));
  assert.ok(!events.some(event => event.endsWith(':manual')));
  assert.equal(f.payloads[1].message,'new');
  assert.equal(f.payloads[1].configurationResult.saved,true);
  assert.equal(f.payloads[1].refreshRequestId,1);
});

test('close, owner change and cancellation reject pending manual refresh before any fetch', async () => {
  for (const state of [{closed:true},{owner:'other'}]) {
    const f = fixture({states:[{...state,refreshRequestId:1}]});
    assert.deepEqual(await runOverlay(f.options),{reason:'closed'});
    assert.equal(f.calls.filter(call => call.type === 'refresh').length,0);
    assert.equal(f.payloads.length,0);
  }
  const cancelled = fixture({states:[{refreshRequestId:1}],onStatus:controller => controller.abort()});
  assert.deepEqual(await runOverlay(cancelled.options),{reason:'stopped'});
  assert.equal(cancelled.calls.filter(call => call.type === 'refresh').length,0);
  assert.equal(cancelled.payloads.length,0);
});
