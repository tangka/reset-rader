import assert from 'node:assert/strict';
import test from 'node:test';
import { checkChanges, MIN_POLL_INTERVAL_MS, runWatch } from './monitor.mjs';

const now = Date.parse('2026-09-08T10:00:00Z');
const resetAt = '2026-09-10T10:00:00.000Z';
const weekly = (personalProbability, overrides = {}) => ({
  limitId: 'codex', window: 'secondary', resetAt,
  personalProbability, reason: 'extra_reset_probability', ...overrides,
});
const report = (...weeklyWindows) => ({ platform: 'codex', weeklyWindows });

test('alerts on first high probability or the first later threshold crossing, only once per week', () => {
  const before = checkChanges({ report: report(weekly(79)), now });
  assert.deepEqual(before.notifications, []);
  const at = checkChanges({ report: report(weekly(80)), previousState: before.state, now: now + 1000 });
  assert.equal(at.notifications.length, 1);
  assert.equal(at.notifications[0].personalProbability, 80);
  const belowAgain = checkChanges({ report: report(weekly(70)), previousState: at.state, now: now + 2000 });
  const aboveAgain = checkChanges({ report: report(weekly(91)), previousState: belowAgain.state, now: now + 3000 });
  assert.deepEqual(aboveAgain.notifications, []);
  assert.equal(checkChanges({ report: report(weekly(91)), now }).notifications.length, 1);
});

test('a newly observed weekly reset timestamp can produce a new high alert, not a reset confirmation', () => {
  const initial = checkChanges({ report: report(weekly(100)), now });
  const next = checkChanges({
    report: report(weekly(100, { resetAt: '2026-09-15T10:00:00Z', reason: 'weekly_reset_within_24h' })),
    previousState: initial.state, now: now + 1000,
  });
  assert.equal(next.notifications.length, 1);
  assert.equal(next.notifications[0].type, 'personal_probability_high');
  assert.equal(next.notifications[0].reason, 'weekly_reset_within_24h');
  assert.equal(next.notifications[0].resetAt, '2026-09-15T10:00:00.000Z');
});

test('changing the threshold starts a fresh gate without re-alerting under the same threshold', () => {
  const first = checkChanges({ report: report(weekly(85)), threshold: 80, now });
  assert.equal(first.notifications.length, 1);
  const higherGate = checkChanges({
    report: report(weekly(98)), threshold: 99, previousState: first.state, now: now + 1000,
  });
  assert.equal(higherGate.state.threshold, 99);
  assert.deepEqual(higherGate.notifications, []);
  const reached = checkChanges({
    report: report(weekly(99)), threshold: 99, previousState: higherGate.state, now: now + 2000,
  });
  assert.equal(reached.notifications.length, 1);
  const sameGate = checkChanges({
    report: report(weekly(100)), threshold: 99, previousState: reached.state, now: now + 3000,
  });
  assert.deepEqual(sameGate.notifications, []);
  const lowerGate = checkChanges({
    report: report(weekly(100)), threshold: 80, previousState: sameGate.state, now: now + 4000,
  });
  assert.equal(lowerGate.notifications.length, 1);
});

test('missing, invalid or expired weekly windows never cause an alert or fabricate a reset', () => {
  const initial = checkChanges({ report: report(weekly(99)), now });
  const missing = checkChanges({ report: { personalProbability: 100 }, previousState: initial.state, now: now + 1000 });
  assert.deepEqual(missing.notifications, []);
  assert.equal(missing.state.windows.length, 1);
  const restored = checkChanges({ report: report(weekly(100)), previousState: missing.state, now: now + 2000 });
  assert.deepEqual(restored.notifications, []);
  const malformed = checkChanges({
    report: report(weekly(null), weekly('100'), weekly(101), weekly(NaN),
      weekly(100, { window: 'five_hour' }), weekly(100, { resetAt: 'invalid' }),
      weekly(100, { resetAt: new Date(now).toISOString() })), now,
  });
  assert.deepEqual(malformed.notifications, []);
  const expired = checkChanges({ report: report(weekly(100)), previousState: initial.state, now: Date.parse(resetAt) });
  assert.deepEqual(expired.notifications, []);
  assert.deepEqual(expired.state.windows, []);
});

test('separate model windows and duplicate equivalent timestamps are deduplicated by identity', () => {
  const result = checkChanges({ report: report(
    weekly(90), weekly(90, { resetAt: '2026-09-10T18:00:00+08:00' }),
    weekly(90, { limitId: 'codex-other' }),
  ), now });
  assert.equal(result.notifications.length, 2);
  assert.equal(result.state.windows.length, 2);
  const next = checkChanges({ report: report(weekly(95, { limitId: 'codex-other' })), previousState: result.state, now });
  assert.deepEqual(next.notifications, []);
});

test('persisted state contains only deduplication data, not complete reports or keys', () => {
  const result = checkChanges({ report: {
    ...report(weekly(80, { accessToken: 'not-a-real-token', reason: 'weekly_reset_within_24h' })),
    apiKey: 'not-a-real-key', serverResponse: { secret: 'not-a-real-secret' },
  }, now });
  assert.deepEqual(Object.keys(result.state), ['version', 'threshold', 'checkedAt', 'windows']);
  assert.deepEqual(Object.keys(result.state.windows[0]), ['limitId', 'window', 'resetAt', 'personalProbability', 'notified']);
  assert.doesNotMatch(JSON.stringify(result.state), /not-a-real|serverResponse|apiKey|accessToken|reason/);
});

test('rejects invalid thresholds and current times instead of guessing', () => {
  for (const threshold of [NaN, -1, 101, '80', null]) {
    assert.throws(() => checkChanges({ report: report(), threshold, now }), /阈值/);
  }
  assert.throws(() => checkChanges({ report: report(), now: NaN }), /时间/);
});

test('watch uses at least ten minutes between sequential completed queries', async () => {
  const controller = new AbortController();
  const events = [];
  let active = 0;
  let samples = 0;
  const result = await runWatch({
    intervalMs: 1, signal: controller.signal,
    sample: async ({ signal }) => {
      assert.equal(signal, controller.signal);
      assert.equal(active++, 0);
      await Promise.resolve();
      samples += 1;
      active -= 1;
      return { value: samples };
    },
    emit: async (event) => events.push(event),
    sleepImpl: async (duration, { signal }) => {
      assert.equal(duration, MIN_POLL_INTERVAL_MS);
      assert.equal(active, 0);
      assert.equal(signal, controller.signal);
      if (samples === 3) controller.abort();
    },
  });
  assert.deepEqual(result, { reason: 'aborted' });
  assert.equal(samples, 3);
  assert.deepEqual(events.map((event) => event.result.value), [1, 2, 3]);
});

test('429 honors the larger of Retry-After and ten minutes, without leaking error contents', async () => {
  for (const [retryAfterSeconds, expectedMs] of [[120, 600000], [900, 900000], [undefined, 600000]]) {
    const controller = new AbortController();
    const events = [];
    await runWatch({
      signal: controller.signal,
      sample: async () => { throw Object.assign(new Error('API key is not-a-real-key'), { status: 429, retryAfterSeconds }); },
      emit: async (event) => events.push(event),
      sleepImpl: async (duration) => { assert.equal(duration, expectedMs); controller.abort(); },
    });
    assert.equal(events[0].code, 'rate_limited');
    assert.equal(events[0].retryAfterSeconds, expectedMs / 1000);
    assert.doesNotMatch(JSON.stringify(events), /not-a-real-key|API key/);
  }
});

test('authorization errors stop monitoring without another query or sleep', async () => {
  for (const status of [401, 403]) {
    const events = [];
    const result = await runWatch({
      sample: async () => { throw Object.assign(new Error('secret'), { status }); },
      emit: async (event) => events.push(event),
      sleepImpl: async () => assert.fail('authorization failures must not retry'),
    });
    assert.deepEqual(result, { reason: 'authorization_failed', status });
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'authorization_failed');
    assert.doesNotMatch(JSON.stringify(events), /secret/);
  }
});

test('temporary server and transport failures are safely reported then retried', async () => {
  const controller = new AbortController();
  const events = [];
  let attempts = 0;
  await runWatch({
    signal: controller.signal,
    sample: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('private server output'), { statusCode: 503 });
      if (attempts === 2) throw new Error('private transport output');
      return { notifications: [] };
    },
    emit: async (event) => events.push(event),
    sleepImpl: async (duration) => {
      assert.equal(duration, MIN_POLL_INTERVAL_MS);
      if (attempts === 3) controller.abort();
    },
  });
  assert.deepEqual(events.map((event) => event.code ?? event.type), ['service_unavailable', 'query_failed', 'sample']);
  assert.doesNotMatch(JSON.stringify(events), /private/);
});

test('abort before a query, during a query or during sleep ends quietly', async () => {
  const before = new AbortController();
  before.abort();
  await runWatch({ sample: () => assert.fail('already aborted'), emit: () => assert.fail('no output'), signal: before.signal });

  const duringQuery = new AbortController();
  await runWatch({
    signal: duringQuery.signal,
    sample: async () => { duringQuery.abort(); throw new Error('interrupted'); },
    emit: () => assert.fail('aborted queries must not emit an error'),
  });

  const duringSleep = new AbortController();
  let calls = 0;
  const result = await runWatch({
    signal: duringSleep.signal,
    sample: async () => { calls += 1; return {}; },
    emit: async () => setImmediate(() => duringSleep.abort()),
  });
  assert.deepEqual(result, { reason: 'aborted' });
  assert.equal(calls, 1);
});

test('a caller output failure stops watch rather than silently repeatedly querying', async () => {
  await assert.rejects(runWatch({ sample: async () => ({}), emit: async () => { throw new Error('closed output'); } }), /closed output/);
});
