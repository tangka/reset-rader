import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPersonalProbability } from './personal-probability.mjs';

const NOW = Date.parse('2026-09-08T04:00:00Z');
const HOUR = 60 * 60 * 1000;

function overview(overrides = {}) {
  return {
    naturalCycle: 'exclude', generatedAt: new Date(NOW).toISOString(),
    platforms: [{ id: 'codex', probability: 37, resetAt: new Date(NOW + HOUR).toISOString() }],
    ...overrides,
  };
}

function weekly(hours = 30, overrides = {}) {
  return { windowDurationMins: 10080, resetsAt: (NOW + hours * HOUR) / 1000, usedPercent: 56, ...overrides };
}

function quotas(hours = 30) {
  return {
    rateLimitsByLimitId: {
      codex: {
        primary: { windowDurationMins: 300, resetsAt: (NOW + HOUR) / 1000, usedPercent: 90 },
        secondary: weekly(hours),
      },
    },
  };
}

const calculate = (radar = overview(), local = quotas(), now = NOW) => (
  buildPersonalProbability(radar, local, { now })
);

test('uses local weekly quota only, never the public radar or five-hour countdown', () => {
  const result = calculate();
  assert.equal(result.baseProbability, 37);
  assert.equal(result.personalProbability, 37);
  assert.equal(result.reason, 'extra_reset_only');
  assert.deepEqual(result.weeklyWindows, [{
    limitId: 'codex', window: 'secondary', resetAt: '2026-09-09T10:00:00.000Z',
    usedPercent: 56, personalProbability: 37, reason: 'extra_reset_only',
  }]);
  assert.equal(result.radarGeneratedAt, '2026-09-08T04:00:00.000Z');
  assert.equal(result.calculatedAt, result.radarGeneratedAt);
  assert.equal(result.horizonHours, 24);
});

test('24-hour weekly boundary is inclusive, but never backdates an elapsed reset', () => {
  assert.equal(calculate(undefined, quotas(24 + 1 / 3600)).personalProbability, 37);
  assert.equal(calculate(undefined, quotas(24)).personalProbability, 100);
  assert.equal(calculate(undefined, quotas(12)).personalProbability, 100);
  assert.equal(calculate(undefined, quotas(1 / 3600)).personalProbability, 100);
  for (const hours of [0, -1 / 3600, -200]) {
    const result = calculate(undefined, quotas(hours));
    assert.equal(result.personalProbability, null);
    assert.equal(result.reason, 'weekly_reset_elapsed');
  }
});

test('same radar evidence produces a different personal value for each account weekly reset', () => {
  const radar = overview();
  assert.equal(calculate(radar, quotas(12)).personalProbability, 100);
  assert.equal(calculate(radar, quotas(36)).personalProbability, 37);
  assert.equal(radar.platforms[0].probability, 37);
});

test('unavailable or five-hour-only local quota never guesses a weekly reset', () => {
  for (const local of [null, {}, { rateLimits: null }, { rateLimitsByLimitId: {} }, {
    rateLimitsByLimitId: { codex: { primary: { windowDurationMins: 300, resetsAt: NOW / 1000 + 60 } } },
  }]) {
    const result = calculate(undefined, local);
    assert.equal(result.baseProbability, 37);
    assert.equal(result.personalProbability, null);
    assert.equal(result.reason, 'weekly_window_unavailable');
    assert.deepEqual(result.weeklyWindows, []);
  }
});

test('invalid weekly timestamps remain unavailable without deriving an offset or period', () => {
  for (const resetsAt of [undefined, null, '', '1789000000', NaN, Infinity, -1, 0, 1e20]) {
    const result = calculate(undefined, { rateLimits: { secondary: weekly(2, { resetsAt }) } });
    assert.equal(result.personalProbability, null);
    assert.equal(result.reason, 'weekly_reset_unavailable');
    assert.equal(result.weeklyWindows[0].resetAt, null);
  }
});

test('supports weekly primary, legacy responses, and unknown usage without treating it as zero', () => {
  const result = calculate(undefined, { rateLimits: { primary: weekly(5, { usedPercent: null }) } });
  assert.equal(result.personalProbability, 100);
  assert.equal(result.weeklyWindows[0].window, 'primary');
  assert.equal(result.weeklyWindows[0].usedPercent, null);
  assert.equal(calculate(undefined, {
    rateLimitsByLimitId: null, rateLimits: { secondary: weekly(5) },
  }).personalProbability, 100);
});

test('map wins over legacy even if its Codex bucket is unavailable', () => {
  const local = { ...quotas(30), rateLimits: { secondary: weekly(2) } };
  assert.equal(calculate(undefined, local).personalProbability, 37);
  local.rateLimitsByLimitId = {};
  assert.equal(calculate(undefined, local).personalProbability, null);
  local.rateLimitsByLimitId = { image: { secondary: weekly(2) } };
  assert.equal(calculate(undefined, local).personalProbability, null);
});

test('only general Codex weekly quota participates; model buckets never display or affect probability', () => {
  const local = quotas(30);
  local.rateLimitsByLimitId['codex-mini'] = { secondary: weekly(2) };
  local.rateLimitsByLimitId.codex_bengalfox = { secondary: weekly(1) };
  local.rateLimitsByLimitId.image = { secondary: weekly(1) };
  local.rateLimitsByLimitId['another-codex-product'] = { secondary: weekly(1) };
  const result = calculate(undefined, local);
  assert.equal(result.personalProbability, 37);
  assert.deepEqual(result.weeklyWindows.map((item) => item.limitId), ['codex']);
});

test('missing general quota never falls back to one or more model quotas', () => {
  const local = { rateLimitsByLimitId: {
    'codex-sol': { secondary: weekly(30) },
    'codex-astra': { secondary: weekly(2) },
  } };
  const result = calculate(undefined, local);
  assert.equal(result.personalProbability, null);
  assert.equal(result.reason, 'weekly_window_unavailable');
  assert.deepEqual(result.weeklyWindows, []);
  delete local.rateLimitsByLimitId['codex-sol'];
  assert.equal(calculate(undefined, local).personalProbability, null);
  assert.deepEqual(calculate(undefined, {rateLimits:{limitId:'codex_bengalfox',secondary:weekly(1)}}).weeklyWindows,[]);
});

test('legacy explicitly different product is rejected', () => {
  assert.equal(calculate(undefined, { rateLimits: {
    limitId: 'image', secondary: weekly(3),
  } }).personalProbability, null);
});

test('requires the excluded natural-cycle variant and a real percentage', () => {
  for (const naturalCycle of [undefined, null, 'include', 'EXCLUDE']) {
    assert.throws(() => calculate(overview({ naturalCycle })), /naturalCycle=exclude/);
  }
  for (const probability of [undefined, null, '', '37', -1, 101, NaN, Infinity]) {
    assert.throws(() => calculate(overview({ platforms: [{ id: 'codex', probability }] })), /probability is unavailable/);
  }
  assert.throws(() => calculate(overview({ platforms: [] })), /probability is unavailable/);
  assert.equal(calculate(overview({ platforms: [{ id: 'codex', probability: 0 }] })).personalProbability, 0);
  assert.equal(calculate(overview({ platforms: [{ id: 'codex', probability: 100 }] })).personalProbability, 100);
});

test('radar freshness checks before, at, and after each expiry boundary', () => {
  const at = (offset) => overview({ generatedAt: new Date(NOW + offset).toISOString() });
  assert.equal(calculate(at(-2 * HOUR)).baseProbability, 37);
  assert.throws(() => calculate(at(-2 * HOUR - 1)), /stale/);
  assert.equal(calculate(at(5 * 60 * 1000)).baseProbability, 37);
  assert.throws(() => calculate(at(5 * 60 * 1000 + 1)), /future-dated/);
  for (const generatedAt of [undefined, null, '', 'not a date', NOW]) {
    assert.throws(() => calculate(overview({ generatedAt })), /snapshot/);
  }
  assert.throws(() => calculate(undefined, undefined, NaN), /calculation time/);
});
