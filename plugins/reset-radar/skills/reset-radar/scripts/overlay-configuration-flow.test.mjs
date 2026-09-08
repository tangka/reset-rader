import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOverlay } from './overlay-runner.mjs';
import { saveOverlayKey } from './overlay-configuration.mjs';
import { loadConfiguration } from './configuration.mjs';

const TEST_KEY = `rr_live_${'a'.repeat(12)}_${'b'.repeat(43)}`;

function bridge({requests = [], load = async () => { throw new Error('missing'); },
  save = saveOverlayKey, environment = {}, Data} = {}) {
  const controller = new AbortController();
  const payloads = [];
  const events = [];
  let iterations = 0;
  const status = () => ({installed:true,closed:false,owner:'session',
    configurationPending:requests.length > 0});
  class Page {
    async open() {}
    async evaluate(expression) {
      if (expression.includes('function installCard')) return status();
      if (!expression.includes('state.update(')) return status();
      return vm.runInNewContext(expression, {window:{__resetRadarOverlayV1:{
        owner:'session', update(payload) { payloads.push(payload); return status(); }, status,
      }}});
    }
    async takeConfiguration() { return requests.shift(); }
    async removeOverlay() {}
    close() {}
  }
  class DefaultData {
    constructor(configuration) { this.configuration = configuration; }
    async refresh() { events.push({type:'refreshed'}); }
    payload() { return {status:'loading',message:'automatically connected'}; }
  }
  return {controller,payloads,events,options:{target:{id:'test'},sessionId:'session',
    Page,Data:Data || DefaultData,load,save,environment,signal:controller.signal,
    emit:value => events.push(value),sleep:async () => {
      if (++iterations >= 3) controller.abort();
      await Promise.resolve();
    }}};
}

test('explicit card save uses private file then refreshes in the same session without echoing Key', async () => {
  const directory = await mkdtemp(join(tmpdir(),'radar-card-config-'));
  try {
    const request = {requestId:1,key:TEST_KEY};
    const environment = {RESET_RADAR_STATE_DIR:directory};
    const f = bridge({requests:[request],environment});
    await runOverlay(f.options);
    assert.equal((await loadConfiguration(environment)).apiKey,TEST_KEY);
    assert.equal(request.key,'');
    assert.equal(f.payloads[0].configurationRequired,false);
    assert.equal(f.payloads[0].configurationResult.saved,true);
    assert.ok(f.events.some(value => value.type === 'refreshed'));
    assert.ok(!JSON.stringify([f.events,f.payloads]).includes(TEST_KEY));
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('save failure stays in card, sanitizes internal errors and permits the next explicit retry', async () => {
  let calls = 0;
  const f = bridge({requests:[{requestId:1,key:TEST_KEY},{requestId:2,key:TEST_KEY}],
    save:async () => { if (++calls === 1) throw new Error(TEST_KEY); return {}; }});
  await runOverlay(f.options);
  assert.equal(f.payloads[0].configurationRequired,true);
  assert.equal(f.payloads[0].configurationResult.saved,false);
  assert.match(f.payloads[0].configurationResult.message,/保存失败/);
  assert.equal(f.payloads[1].configurationResult.saved,true);
  assert.equal(f.payloads[1].configurationRequired,false);
  assert.ok(!JSON.stringify(f.payloads).includes(TEST_KEY));
});

test('changing a Key aborts and drains the old fetch before creating the replacement data source', async () => {
  const lifecycle = [];
  const requests = [];
  let oldSignal;
  class Data {
    constructor(configuration) { this.version = configuration.apiKey; lifecycle.push('new-'+this.version); }
    async refresh(signal) {
      if (this.version === 'old') {
        oldSignal = signal;
        lifecycle.push('fetch-old');
        await new Promise(resolve => signal.addEventListener('abort',resolve,{once:true}));
        lifecycle.push('old-drained');
      } else lifecycle.push('fetch-new');
    }
    payload() { return {status:'loading',message:this.version}; }
  }
  const f = bridge({requests,Data,load:async () => ({apiKey:'old'}),save:async () => ({apiKey:'new'})});
  let iterations = 0;
  f.options.sleep = async () => {
    if (++iterations === 1) requests.push({requestId:1,key:TEST_KEY});
    else f.controller.abort();
  };
  await runOverlay(f.options);
  assert.equal(oldSignal.aborted,true);
  assert.ok(lifecycle.indexOf('old-drained') < lifecycle.indexOf('new-new'));
  assert.equal(f.payloads.at(-1).message,'new');
});

test('a replayed configuration request is discarded instead of saving or restarting again', async () => {
  let saved = 0;
  const f = bridge({requests:[{requestId:1,key:TEST_KEY},{requestId:1,key:TEST_KEY}],
    save:async () => { saved++; return {}; }});
  await runOverlay(f.options);
  assert.equal(saved,1);
});

test('saving the same Key preserves loaded data and its existing cooldown', async () => {
  let constructed = 0;
  class Data {
    constructor() { constructed++; }
    async refresh() {}
    payload() { return {status:'loading',message:'existing data and cooldown'}; }
  }
  const configuration = {apiKey:TEST_KEY,apiBase:'https://api.example.test'};
  const f = bridge({Data,requests:[{requestId:1,key:TEST_KEY}],
    load:async () => configuration,save:async () => ({...configuration})});
  await runOverlay(f.options);
  assert.equal(constructed,1);
  assert.equal(f.payloads[0].configurationResult.saved,true);
  assert.equal(f.payloads[0].message,'existing data and cooldown');
});
