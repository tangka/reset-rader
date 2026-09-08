const HOUR_MS = 60 * 60 * 1000;
const WEEK_MINUTES = 7 * 24 * 60;
const MAX_RADAR_AGE_MS = 2 * HOUR_MS;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function validProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function readRadar(overview, now) {
  if (overview?.naturalCycle !== 'exclude') {
    throw new Error('Radar must provide naturalCycle=exclude; personal probability was not calculated.');
  }
  const codex = overview.platforms?.find?.((platform) => platform?.id === 'codex');
  if (!validProbability(codex?.probability)) {
    throw new Error('Radar Codex probability is unavailable; personal probability was not calculated.');
  }
  const generatedAt = typeof overview.generatedAt === 'string' ? Date.parse(overview.generatedAt) : NaN;
  if (!Number.isFinite(generatedAt) || generatedAt > now + MAX_FUTURE_SKEW_MS
      || now - generatedAt > MAX_RADAR_AGE_MS) {
    throw new Error('Radar snapshot is missing, stale, or future-dated; refresh it before calculating.');
  }
  return { baseProbability: codex.probability, radarGeneratedAt: new Date(generatedAt).toISOString() };
}

function isCodexBucket(id) {
  return typeof id === 'string' && id.toLowerCase() === 'codex';
}

function readBuckets(rateLimits) {
  const map = rateLimits?.rateLimitsByLimitId;
  if (map !== undefined && map !== null) {
    if (typeof map !== 'object' || Array.isArray(map)) return [];
    return Object.entries(map)
      .filter(([id, bucket]) => isCodexBucket(id) && bucket && typeof bucket === 'object')
      .map(([limitId, bucket]) => ({ limitId, bucket }));
  }
  const legacy = rateLimits?.rateLimits;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return [];
  // Older Codex clients omit limitId. An explicitly different product is not Codex.
  if (legacy.limitId !== undefined && legacy.limitId !== null && !isCodexBucket(legacy.limitId)) return [];
  return [{ limitId: legacy.limitId || 'codex', bucket: legacy }];
}

function weeklyResult(limitId, window, value, baseProbability, now) {
  const resetMs = typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt)
    ? value.resetsAt * 1000 : NaN;
  const validReset = Number.isFinite(resetMs) && resetMs > 0 && resetMs <= 8.64e15;
  const resetAt = validReset ? new Date(resetMs).toISOString() : null;
  const usedPercent = typeof value.usedPercent === 'number' && Number.isFinite(value.usedPercent)
    && value.usedPercent >= 0 ? value.usedPercent : null;
  let personalProbability = null;
  let reason = 'weekly_reset_unavailable';
  if (validReset && resetMs <= now) {
    reason = 'weekly_reset_elapsed';
  } else if (validReset && resetMs <= now + 24 * HOUR_MS) {
    personalProbability = 100;
    reason = 'weekly_reset_within_24h';
  } else if (validReset) {
    personalProbability = baseProbability;
    reason = 'extra_reset_only';
  }
  return { limitId, window, resetAt, usedPercent, personalProbability, reason };
}

/** Combine extra-reset probability with this account's scheduled weekly renewal only. */
export function buildPersonalProbability(overview, rateLimits, { now = Date.now() } = {}) {
  if (typeof now !== 'number' || !Number.isFinite(now) || Math.abs(now) > 8.64e15) {
    throw new Error('A valid calculation time is required.');
  }
  const radar = readRadar(overview, now);
  const weeklyWindows = readBuckets(rateLimits).flatMap(({ limitId, bucket }) => (
    ['primary', 'secondary'].flatMap((window) => {
      const value = bucket[window];
      return value?.windowDurationMins === WEEK_MINUTES
        ? [weeklyResult(limitId, window, value, radar.baseProbability, now)] : [];
    })
  ));
  const codexWindows = weeklyWindows.filter((window) => window.limitId.toLowerCase() === 'codex');
  const candidates = codexWindows.length ? codexWindows : weeklyWindows;
  const selected = candidates.length === 1 ? candidates[0] : null;
  return {
    platform: 'codex',
    ...radar,
    calculatedAt: new Date(now).toISOString(),
    horizonHours: 24,
    personalProbability: selected?.personalProbability ?? null,
    reason: selected?.reason ?? (candidates.length ? 'multiple_weekly_windows' : 'weekly_window_unavailable'),
    weeklyWindows,
  };
}
