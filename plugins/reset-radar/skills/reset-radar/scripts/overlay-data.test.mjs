import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OverlayData, safePayload } from './overlay-data.mjs';
import { RadarApiError } from './api-client.mjs';

const NOW = Date.parse('2026-09-08T10:00:00Z');
const configuration = {apiBase:'https://example.com',apiKey:'private-test-key'};
const limits = (resetMs) => ({rateLimitsByLimitId:{codex:{
  primary:{windowDurationMins:300,resetsAt:(NOW+1000)/1000},
  secondary:{windowDurationMins:10080,resetsAt:resetMs/1000},
}}});

function fixture(options = {}) {
  let now = NOW;
  const files = new Map();
  const calls = [];
  let lockTail = Promise.resolve();
  const withLock = async (path,operation) => {
    const preceding = lockTail;
    let release;
    lockTail = new Promise(resolve => { release = resolve; });
    await preceding;
    try { return await operation(); } finally { release(); }
  };
  const deps = {directory:'/tmp/test-overlay',clock:() => now,
    query:async (request) => {
      calls.push(request);
      return {naturalCycle:'exclude',generatedAt:new Date(now).toISOString(),
        platforms:[{id:'codex',probability:37}],secret:'do-not-forward'};
    },
    readLimits:async () => limits(NOW+25*3600000),
    readFile:async path => {
      if (!files.has(path)) throw Object.assign(new Error(),{code:'ENOENT'});
      return files.get(path);
    },writeFile:async (path,value) => { files.set(path,value); },withLock,...options};
  const data = new OverlayData(configuration,deps);
  return {data,files,calls,deps,setNow:value => { now = value; }};
}

test('one sample, two numeric views; heartbeat reuses weekly algorithm across 24h boundary',async () => {
  const f = fixture();
  await f.data.refresh();
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].target,'/overview?naturalCycle=exclude');
  assert.equal(f.data.payload().report.personalProbability,37);
  f.setNow(NOW+3600000);
  assert.equal(f.data.payload().report.personalProbability,100);
  assert.equal(f.calls.length,1);
  assert.equal(f.data.payload().report.weeklyWindows.length,1);
  assert.equal(f.data.payload().report.weeklyWindows[0].window,'secondary');
  assert.ok(!JSON.stringify(f.data.payload()).includes('do-not-forward'));
});

test('snapshot expiry and local deadline never remain an available personal forecast',async () => {
  const f = fixture({readLimits:async () => limits(NOW+60000)});
  await f.data.refresh();
  assert.equal(f.data.payload().report.personalProbability,100);
  f.setNow(NOW+60000);
  assert.equal(f.data.payload().report.personalProbability,null);
  assert.equal(f.data.payload().report.reason,'weekly_reset_elapsed');
  f.setNow(NOW+2*3600000+1);
  assert.equal(f.data.payload().status,'error');
  assert.equal(f.data.payload().report,undefined);
});

test('ten-minute minimum persists across reopening and fetches never overlap',async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = fixture({query:async () => {
    calls++;
    await wait;
    return {naturalCycle:'exclude',generatedAt:new Date(NOW).toISOString(),platforms:[{id:'codex',probability:37}]};
  }});
  const first = f.data.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const second = f.data.refresh();
  release();
  await Promise.all([first,second]);
  assert.equal(calls,1);
  await f.data.refresh();
  assert.equal(calls,1);
  const reopened = new OverlayData(configuration,f.deps);
  await reopened.refresh();
  assert.equal(calls,1);
  assert.equal(reopened.payload().status,'loading');
  f.setNow(NOW+600000);
  await reopened.refresh();
  assert.equal(calls,2);
});

test('429 respects server response time plus Retry-After even after reopening',async () => {
  const f = fixture({query:async () => {
    f.setNow(NOW+20000);
    throw new RadarApiError(429,900);
  }});
  await f.data.refresh();
  assert.equal(f.data.payload().status,'error');
  assert.equal(f.data.nextRefreshAt,NOW+920000);
  const reopened = new OverlayData(configuration,f.deps);
  await reopened.initialize();
  assert.equal(reopened.nextRefreshAt,NOW+920000);
  assert.ok(![...f.files.values()].join('').includes(configuration.apiKey));
});

test('401 and 403 clear the number and stop further polling; error text cannot leak secrets',async () => {
  for (const status of [401,403]) {
    let calls = 0;
    const f = fixture({query:async () => {
      calls++;
      throw Object.assign(new Error(configuration.apiKey),{status});
    }});
    await f.data.refresh();
    f.setNow(NOW+3600000);
    await f.data.refresh();
    assert.equal(calls,1);
    assert.equal(f.data.payload().report,undefined);
    assert.ok(!JSON.stringify(f.data.payload()).includes(configuration.apiKey));
  }
});

test('mixed-cycle, stale radar, missing weekly quota, and unsafe local storage fail explicitly',async () => {
  const mixed = fixture({query:async () => ({naturalCycle:'include'})});
  await mixed.data.refresh();
  assert.equal(mixed.data.payload().status,'error');
  const missing = fixture({readLimits:async () => { throw new Error('local auth'); }});
  await missing.data.refresh();
  assert.equal(missing.data.payload().report.personalProbability,null);
  assert.equal(missing.data.payload().report.baseProbability,37);
  const invalid = fixture({readFile:async () => 'not json'});
  await assert.rejects(invalid.data.refresh(),/cooldown safely/);
  assert.equal(invalid.calls.length,0);
});

test('safe payload allows only finite nonnegative usage and strips identities and unknown properties',() => {
  const cases = [[0,0],[37.5,37.5],[100,100],[125.25,125.25],[null,null],[undefined,null],
    ['50',null],[-1,null],[NaN,null],[Infinity,null],[{},null],[true,null]];
  for (const [usedPercent,expected] of cases) {
    const output = safePayload({baseProbability:12,personalProbability:null,reason:'weekly_window_unavailable',
      radarGeneratedAt:new Date(NOW).toISOString(),calculatedAt:new Date(NOW).toISOString(),
      accountEmail:'private',apiKey:'secret',weeklyWindows:[{limitId:'codex',window:'secondary',resetAt:null,
        usedPercent,remainingCredits:50,token:'private',personalProbability:null,reason:'weekly_reset_unavailable'}]},NOW);
    assert.equal(output.report.weeklyWindows[0].usedPercent,expected);
    assert.ok(!JSON.stringify(output).match(/private|secret|apiKey|accountEmail|remainingCredits|token/));
    assert.deepEqual(Object.keys(output.report.weeklyWindows[0]).sort(),
      ['limitId','window','resetAt','usedPercent','personalProbability','reason'].sort());
  }
});

test('refresh exposes only general weekly usage locally, never sends it to radar or persists it',async () => {
  const local = limits(NOW+3600000);
  local.rateLimitsByLimitId.codex.primary.usedPercent = 99;
  local.rateLimitsByLimitId.codex.secondary.usedPercent = 37.5;
  local.rateLimitsByLimitId.codex_bengalfox = {
    secondary:{windowDurationMins:10080,resetsAt:(NOW+3600000)/1000,usedPercent:88},
  };
  local.accountEmail = 'private-account';
  const f = fixture({readLimits:async () => local});
  await f.data.refresh();
  const payload = f.data.payload();
  assert.equal(payload.status,'ready');
  assert.deepEqual(payload.report.weeklyWindows.map(row => [row.limitId,row.window,row.usedPercent]),
    [['codex','secondary',37.5]]);
  assert.doesNotMatch(JSON.stringify(payload),/codex_bengalfox|private-account|accountEmail/);
  assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0],{...configuration,target:'/overview?naturalCycle=exclude',signal:undefined});
  assert.ok(f.files.size > 0);
  for (const saved of f.files.values()) {
    assert.deepEqual(JSON.parse(saved),{nextRefreshAt:NOW+600000});
  }
});

test('refresh preserves unknown and excess usage without substituting a model-only quota',async () => {
  const cases = [[0,0],[100,100],[125.25,125.25],[null,null],[undefined,null],['37',null],[-1,null],[Infinity,null]];
  for (const [usedPercent,expected] of cases) {
    const local = limits(NOW+3600000);
    local.rateLimitsByLimitId.codex.secondary.usedPercent = usedPercent;
    const f = fixture({readLimits:async () => local});
    await f.data.refresh();
    assert.equal(f.data.payload().report.weeklyWindows[0].usedPercent,expected);
  }
  const local = limits(NOW+3600000);
  local.rateLimitsByLimitId.codex.secondary.usedPercent = 50;
  local.rateLimitsByLimitId.codex_bengalfox = local.rateLimitsByLimitId.codex;
  delete local.rateLimitsByLimitId.codex;
  const f = fixture({readLimits:async () => local});
  await f.data.refresh();
  assert.deepEqual(f.data.payload().report.weeklyWindows,[]);
  assert.equal(f.data.payload().report.personalProbability,null);
});

test('concurrent instances atomically claim one shared request before the API starts',async () => {
  const f = fixture();
  const second = new OverlayData(configuration,f.deps);
  await Promise.all([f.data.refresh(),second.refresh()]);
  assert.equal(f.calls.length,1);
  assert.equal(f.data.nextRefreshAt,NOW+600000);
  assert.equal(second.nextRefreshAt,NOW+600000);
});

test('same-instance in-flight guard is established before initialization awaits',async () => {
  const f = fixture();
  let initialized = 0;
  const original = f.data.initialize.bind(f.data);
  f.data.initialize = async () => { initialized++; await original(); };
  await Promise.all([f.data.refresh(),f.data.refresh(),f.data.refresh()]);
  assert.equal(initialized,1);
  assert.equal(f.calls.length,1);
});

test('a stale instance rereads an extended 429 deadline and cannot shorten it',async () => {
  const f = fixture({query:async () => { throw new RadarApiError(429,1800); }});
  const second = new OverlayData(configuration,f.deps);
  await second.initialize();
  await f.data.refresh();
  await second.reserve(NOW+600000);
  assert.equal(second.nextRefreshAt,NOW+1800000);
  assert.equal(JSON.parse(f.files.get(f.data.path)).nextRefreshAt,NOW+1800000);
  f.setNow(NOW+600000);
  let attempted = false;
  second.query = async () => { attempted = true; };
  await second.refresh();
  assert.equal(attempted,false);
});

test('concurrent 429 extensions preserve the longest deadline in either ordering',async () => {
  for (const reversed of [false,true]) {
    const f = fixture();
    const second = new OverlayData(configuration,f.deps);
    const calls = [() => f.data.reserve(NOW+1800000),() => second.reserve(NOW+600000)];
    if (reversed) calls.reverse();
    await Promise.all(calls.map(call => call()));
    assert.equal(JSON.parse(f.files.get(f.data.path)).nextRefreshAt,NOW+1800000);
  }
});

test('lock, storage and release errors clear prior probability and never issue another API request',async () => {
  for (const fault of ['lock','read','write','release']) {
    const f = fixture();
    await f.data.refresh();
    assert.equal(f.data.payload().status,'ready');
    f.setNow(NOW+600000);
    if (fault === 'lock') f.data.withLock = async () => { throw new Error('locked'); };
    if (fault === 'read') f.data.readFile = async () => 'invalid';
    if (fault === 'write') f.data.writeFile = async () => { throw new Error('denied'); };
    if (fault === 'release') f.data.withLock = async (path,operation) => { await operation(); throw new Error('release failed'); };
    await assert.rejects(f.data.refresh(),/cooldown safely/);
    assert.equal(f.calls.length,1);
    assert.equal(f.data.payload().status,'error');
    assert.equal(f.data.payload().report,undefined);
    f.setNow(NOW+3600000);
    await f.data.refresh();
    assert.equal(f.calls.length,1);
  }
});

test('real file-backed instances serialize claims and leave no lock after both finish',async (t) => {
  const directory = await mkdtemp(join(tmpdir(),'reset-radar-cooldown-data-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  let calls = 0;
  const dependencies = {directory,clock:() => NOW,readLimits:async () => limits(NOW+3600000),
    query:async () => {
      calls++;
      return {naturalCycle:'exclude',generatedAt:new Date(NOW).toISOString(),platforms:[{id:'codex',probability:37}]};
    }};
  const first = new OverlayData(configuration,dependencies);
  const second = new OverlayData(configuration,dependencies);
  await Promise.all([first.refresh(),second.refresh()]);
  assert.equal(calls,1);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.lock')),false);
});

test('manual refresh reads radar and weekly quota immediately then restarts the automatic interval',async () => {
  let localReads = 0;
  const f = fixture({readLimits:async () => { localReads++; return limits(NOW+3600000); }});
  await f.data.refresh();
  f.setNow(NOW+60000);
  await f.data.refresh();
  assert.equal(f.calls.length,1);
  await f.data.refresh(undefined,{manual:true});
  assert.equal(f.calls.length,2);
  assert.equal(localReads,2);
  assert.equal(f.data.nextRefreshAt,NOW+660000);
  assert.equal(f.data.retryAfterAt,0);
  assert.deepEqual(f.calls[1],{...configuration,target:'/overview?naturalCycle=exclude',signal:undefined});
  f.setNow(NOW+659999);
  await f.data.refresh();
  assert.equal(f.calls.length,2);
  f.setNow(NOW+660000);
  await f.data.refresh();
  assert.equal(f.calls.length,3);
  f.setNow(NOW+660001);
  await f.data.refresh();
  assert.equal(f.calls.length,3);
  assert.equal(localReads,3);
});

test('duplicate manual clicks and an automatic tick share the same in-flight request',async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let requests = 0;
  let localReads = 0;
  const f = fixture({query:async () => {
    requests++;
    if (requests === 2) await pending;
    return {naturalCycle:'exclude',generatedAt:new Date(NOW).toISOString(),platforms:[{id:'codex',probability:37}]};
  },readLimits:async () => { localReads++; return limits(NOW+3600000); }});
  await f.data.refresh();
  f.setNow(NOW+1000);
  const first = f.data.refresh(undefined,{manual:true});
  await new Promise(resolve => setImmediate(resolve));
  const second = f.data.refresh(undefined,{manual:true});
  const automatic = f.data.refresh();
  assert.equal(requests,2);
  assert.equal(localReads,1);
  assert.equal(f.data.payload().status,'loading');
  release();
  await Promise.all([first,second,automatic]);
  assert.equal(requests,2);
  assert.equal(localReads,2);
  assert.equal(f.data.payload().status,'ready');
  await f.data.refresh(undefined,{manual:true});
  assert.equal(requests,3);
});

test('manual refresh respects persisted 429 retry deadlines before, at, and after expiry',async () => {
  let requests = 0;
  const f = fixture({query:async () => {
    requests++;
    f.setNow(NOW+20000);
    throw new RadarApiError(429,900);
  }});
  const stale = new OverlayData(configuration,f.deps);
  await stale.initialize();
  await f.data.refresh(undefined,{manual:true});
  const deadline = NOW+920000;
  assert.equal(f.data.retryAfterAt,deadline);
  assert.deepEqual(JSON.parse(f.files.get(f.data.path)),{nextRefreshAt:deadline,retryAfterAt:deadline});
  const success = async () => {
    requests++;
    return {naturalCycle:'exclude',generatedAt:new Date(deadline).toISOString(),platforms:[{id:'codex',probability:37}]};
  };
  f.data.query = success;
  stale.query = success;
  const reopened = new OverlayData(configuration,{...f.deps,query:success});
  f.setNow(deadline-1);
  await f.data.refresh(undefined,{manual:true});
  await reopened.refresh(undefined,{manual:true});
  await stale.refresh(undefined,{manual:true});
  assert.equal(requests,1);
  assert.equal(reopened.retryAfterAt,deadline);
  assert.equal(stale.retryAfterAt,deadline);
  f.setNow(deadline);
  await reopened.refresh(undefined,{manual:true});
  assert.equal(requests,2);
  assert.equal(reopened.nextRefreshAt,deadline+600000);
  f.setNow(deadline+1);
  await stale.refresh(undefined,{manual:true});
  assert.equal(requests,3);
  assert.equal(stale.nextRefreshAt,deadline+600001);
  assert.equal(stale.retryAfterAt,deadline);
});

test('automatic refresh waits for 429 expiry and ordinary reservations cannot shorten it',async () => {
  let requests = 0;
  const f = fixture({query:async () => {
    requests++;
    if (requests === 1) throw new RadarApiError(429,1200);
    return {naturalCycle:'exclude',generatedAt:new Date(NOW+1200000).toISOString(),platforms:[{id:'codex',probability:37}]};
  }});
  await f.data.refresh();
  await f.data.reserve(NOW+600000);
  assert.equal(f.data.nextRefreshAt,NOW+1200000);
  assert.equal(f.data.retryAfterAt,NOW+1200000);
  f.setNow(NOW+1199999);
  await f.data.refresh();
  assert.equal(requests,1);
  f.setNow(NOW+1200000);
  await f.data.refresh();
  assert.equal(requests,2);
  assert.equal(f.data.nextRefreshAt,NOW+1800000);
});

test('legacy ordinary cooldown stays automatic-only and malformed retry deadlines fail closed',async () => {
  const f = fixture();
  f.files.set(f.data.path,JSON.stringify({nextRefreshAt:NOW+600000}));
  await f.data.refresh();
  assert.equal(f.calls.length,0);
  assert.equal(f.data.retryAfterAt,0);
  await f.data.refresh(undefined,{manual:true});
  assert.equal(f.calls.length,1);
  assert.deepEqual(JSON.parse(f.files.get(f.data.path)),{nextRefreshAt:NOW+600000});
  for (const retryAfterAt of [null,-1,'600000',1e20]) {
    const invalid = fixture();
    invalid.files.set(invalid.data.path,JSON.stringify({nextRefreshAt:NOW+600000,retryAfterAt}));
    await assert.rejects(invalid.data.refresh(undefined,{manual:true}),/cooldown safely/);
    assert.equal(invalid.calls.length,0);
    assert.equal(invalid.data.terminal,true);
  }
});

test('concurrent retry reservations persist the longest server deadline in either order',async () => {
  for (const reversed of [false,true]) {
    const f = fixture();
    const second = new OverlayData(configuration,f.deps);
    const operations = [() => f.data.reserve(NOW+1800000,{retryAfterAt:NOW+1800000}),
      () => second.reserve(NOW+900000,{retryAfterAt:NOW+900000})];
    if (reversed) operations.reverse();
    await Promise.all(operations.map(operation => operation()));
    assert.deepEqual(JSON.parse(f.files.get(f.data.path)),{
      nextRefreshAt:NOW+1800000,retryAfterAt:NOW+1800000,
    });
  }
});

test('manual refresh never bypasses authorization failure or cancellation',async () => {
  for (const status of [401,403]) {
    let requests = 0;
    const f = fixture({query:async () => { requests++; throw new RadarApiError(status); }});
    await f.data.refresh(undefined,{manual:true});
    f.setNow(NOW+3600000);
    await f.data.refresh(undefined,{manual:true});
    assert.equal(requests,1);
    assert.equal(f.data.terminal,true);
  }
  const cancelled = new AbortController();
  cancelled.abort();
  const f = fixture();
  await f.data.refresh(cancelled.signal,{manual:true});
  assert.equal(f.calls.length,0);
  assert.equal(f.files.size,0);
  const during = new AbortController();
  let localReads = 0;
  const interrupted = fixture({query:async () => {
    during.abort();
    return {naturalCycle:'exclude',generatedAt:new Date(NOW).toISOString(),platforms:[{id:'codex',probability:37}]};
  },readLimits:async ({signal}) => {
    localReads++;
    signal.throwIfAborted();
  }});
  await interrupted.data.refresh(during.signal,{manual:true});
  assert.equal(interrupted.data.payload().status,'loading');
  assert.equal(interrupted.data.terminal,false);
  assert.equal(localReads,1);
});
