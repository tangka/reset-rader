import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, chmod, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { configureKey, loadConfiguration, writePrivateFile } from './configuration.mjs';
import { checkOnce, personal } from './reset-radar.mjs';
import { RadarApiError } from './api-client.mjs';

const key = `rr_live_${'a'.repeat(12)}_${'B'.repeat(43)}`;
const configuration = {apiBase:'https://example.test/member/v1',apiKey:key};
const now = Date.parse('2026-09-08T00:00:00Z');
const overview = {naturalCycle:'exclude',generatedAt:new Date(now).toISOString(),
  platforms:[{id:'codex',probability:62,resetAt:'2026-09-08T01:00:00Z'}]};
const limits = (hours) => ({rateLimits:{primary:{windowDurationMins:300,resetsAt:now/1000+3600},
  secondary:{windowDurationMins:10080,resetsAt:now/1000+hours*3600}}});

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(),'radar-plugin-test-'));
  try { await callback(directory); } finally { await rm(directory,{recursive:true,force:true}); }
}

test('configuration is explicit, private, and reusable without exporting a Key', async () => {
  await temporary(async (directory) => {
    const env = {RESET_RADAR_STATE_DIR:directory};
    await assert.rejects(loadConfiguration(env), /Set up/);
    await configureKey(Readable.from([key]),env);
    assert.equal((await stat(join(directory,'api-key'))).mode & 0o777,0o600);
    assert.equal((await loadConfiguration(env)).apiKey,key);
    await chmod(join(directory,'api-key'),0o644);
    await assert.rejects(loadConfiguration(env), /private radar/);
    await assert.rejects(configureKey(Readable.from(['bad']),env),/Invalid/);
  });
});

test('private key reads reject symlinks and permissive files', async () => {
  await temporary(async (directory) => {
    const target = join(directory,'actual');
    await writePrivateFile(target,key);
    const link = join(directory,'api-key');
    await symlink(target,link);
    await assert.rejects(loadConfiguration({RESET_RADAR_STATE_DIR:directory}),/private radar/);
  });
});

test('personal performs exactly one excluded API query and one local read, not two analyses', async () => {
  let calls = 0;
  let localCalls = 0;
  const result = await personal(configuration,{now,query:async (options) => {
    calls += 1;
    assert.equal(options.target,'/overview?naturalCycle=exclude');
    assert.equal(Object.hasOwn(options,'rateLimits'),false);
    return overview;
  },readLimits:async () => { localCalls += 1; return limits(48); }});
  assert.equal(calls,1);
  assert.equal(localCalls,1);
  assert.equal(result.personalProbability,62);
  assert.equal(result.baseProbability,62);
});

test('a unavailable local reader does not invent a personal reset or reuse public countdown', async () => {
  const result = await personal(configuration,{now,query:async () => overview,
    readLimits:async () => { throw new Error('local unavailable'); }});
  assert.equal(result.personalProbability,null);
  assert.equal(result.baseProbability,62);
  assert.deepEqual(result.weeklyWindows,[]);
});

test('personal surfaces invalid and ambiguous runtime settings without raw error text', async () => {
  for (const code of ['local_codex_runtime_invalid', 'local_codex_runtime_ambiguous']) {
    await assert.rejects(personal(configuration, {now, query:async () => overview,
      readLimits:async () => { throw Object.assign(new Error('private raw diagnostic'), {code}); },
    }), (error) => {
      assert.equal(error.code, code);
      assert.match(error.message, /RESET_RADAR_CODEX_APP/);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  }
});

test('independent checks persist deduplication without storing the Key or raw account data', async () => {
  await temporary(async (directory) => {
    const sample = async () => personal(configuration,{now,query:async () => overview,
      readLimits:async () => limits(12)});
    const first = await checkOnce(configuration,{directory,sample,now});
    assert.equal(first.notifications.length,1);
    assert.equal(first.report.personalProbability,100);
    const again = await checkOnce(configuration,{directory,sample,now:now+1000});
    assert.equal(again.notifications.length,0);
    const {readdir} = await import('node:fs/promises');
    for (const filename of await readdir(directory)) {
      const saved = await readFile(join(directory,filename),'utf8');
      assert.equal(saved.includes(key),false);
      assert.equal(saved.includes('baseProbability'),false);
    }
  });
});

test('saved 429 cooldown prevents another request before deadline, then permits a check', async () => {
  await temporary(async (directory) => {
    let calls = 0;
    await assert.rejects(checkOnce(configuration,{directory,now,clock:()=>now+20000,sample:async () => {
      calls += 1; throw new RadarApiError(429,900);
    }}),/Rate limit/);
    const sample = async () => { calls += 1; return {weeklyWindows:[]}; };
    const wait = await checkOnce(configuration,{directory,now:now+919000,sample});
    assert.equal(wait.skipped,'retry_after');
    assert.equal(calls,1);
    await checkOnce(configuration,{directory,now:now+920000,sample});
    assert.equal(calls,2);
  });
});
