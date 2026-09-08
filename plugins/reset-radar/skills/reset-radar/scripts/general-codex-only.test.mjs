import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPersonalProbability } from './personal-probability.mjs';
import { checkChanges } from './monitor.mjs';
import { OverlayData } from './overlay-data.mjs';

const START = Date.parse('2026-09-08T04:00:00Z');
const HOUR = 60 * 60 * 1000;
const MODEL_RESET = START + HOUR;
const BOUNDARIES = [MODEL_RESET - 1, MODEL_RESET, MODEL_RESET + 1];
const overview = {
  naturalCycle: 'exclude', generatedAt: new Date(START).toISOString(),
  platforms: [{ id: 'codex', probability: 37 }],
};

function weekly(resetAt) {
  return { windowDurationMins: 10080, resetsAt: resetAt / 1000 };
}

function quotas(generalResetAt) {
  return {
    rateLimitsByLimitId: {
      codex_bengalfox: { secondary: weekly(MODEL_RESET) },
      'codex-astra': { secondary: weekly(MODEL_RESET + 1) },
      ...(generalResetAt === null ? {} : { codex: { secondary: weekly(generalResetAt) } }),
    },
    // A legacy view must not override an authoritative map missing general Codex.
    rateLimits: { secondary: weekly(START + 2 * HOUR) },
  };
}

function previousModelState() {
  return {
    version: 1, threshold: 80,
    windows: [{
      limitId: 'codex_bengalfox', window: 'secondary',
      resetAt: new Date(MODEL_RESET).toISOString(), personalProbability: 37, notified: false,
    }],
  };
}

test('only general Codex can notify before, at, and after a model-specific reset', () => {
  for (const generalHours of [30, 2]) {
    let state = previousModelState();
    const local = quotas(START + generalHours * HOUR);
    for (const [index, now] of BOUNDARIES.entries()) {
      const report = buildPersonalProbability(overview, local, { now });
      const result = checkChanges({ report, previousState: state, now });
      assert.deepEqual(report.weeklyWindows.map(row => row.limitId), ['codex']);
      assert.equal(report.personalProbability, generalHours === 2 ? 100 : 37);
      assert.equal(result.notifications.length, generalHours === 2 && index === 0 ? 1 : 0);
      assert.ok(result.notifications.every(row => row.limitId === 'codex'));
      state = result.state;
    }
  }
});

test('missing general Codex never falls back or alerts from model/legacy windows', () => {
  let state = previousModelState();
  for (const now of BOUNDARIES) {
    const report = buildPersonalProbability(overview, quotas(null), { now });
    const result = checkChanges({ report, previousState: state, now });
    assert.deepEqual(report.weeklyWindows, []);
    assert.equal(report.personalProbability, null);
    assert.equal(report.baseProbability, 37);
    assert.equal(report.reason, 'weekly_window_unavailable');
    assert.deepEqual(result.notifications, []);
    state = result.state;
  }
});

function overlayFixture(local) {
  let now = START;
  let queries = 0;
  let localReads = 0;
  const files = new Map();
  const data = new OverlayData({
    apiBase: 'https://example.test/member/v1', apiKey: 'explicit-test-only-key',
  }, {
    directory: '/memory-only-test-state', clock: () => now,
    query: async () => { queries += 1; return overview; },
    readLimits: async () => { localReads += 1; return local; },
    withLock: async (path, operation) => operation(),
    readFile: async path => {
      if (!files.has(path)) throw Object.assign(new Error(), { code: 'ENOENT' });
      return files.get(path);
    },
    writeFile: async (path, value) => { files.set(path, value); },
  });
  return { data, setNow: value => { now = value; }, counts: () => ({ queries, localReads }) };
}

test('overlay payload never displays model buckets or changes when those windows expire', async () => {
  for (const generalHours of [30, 2, null]) {
    const fixture = overlayFixture(quotas(generalHours === null ? null : START + generalHours * HOUR));
    await fixture.data.refresh();
    for (const now of BOUNDARIES) {
      fixture.setNow(now);
      const payload = fixture.data.payload();
      assert.equal(payload.status, 'ready');
      assert.deepEqual(payload.report.weeklyWindows.map(row => row.limitId),
        generalHours === null ? [] : ['codex']);
      assert.equal(payload.report.personalProbability,
        generalHours === null ? null : generalHours === 2 ? 100 : 37);
      assert.equal(payload.report.baseProbability, 37);
      assert.doesNotMatch(JSON.stringify(payload), /codex_bengalfox|codex-astra/);
    }
    assert.deepEqual(fixture.counts(), { queries: 1, localReads: 1 });
  }
});
