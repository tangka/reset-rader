import { setTimeout as delay } from 'node:timers/promises';

export const MIN_POLL_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;

function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function normalizeWindow(value, now) {
  if (!value || typeof value.limitId !== 'string' || !value.limitId.trim()
    || value.limitId.length > 200 || !['primary', 'secondary'].includes(value.window)) return null;
  if (typeof value.resetAt !== 'string') return null;
  const resetTime = Date.parse(value.resetAt);
  if (!Number.isFinite(resetTime) || resetTime <= now) return null;
  return { limitId: value.limitId, window: value.window, resetAt: new Date(resetTime).toISOString() };
}

function windowKey(value) {
  return JSON.stringify([value.limitId, value.window, value.resetAt]);
}

/** Alert once per observed weekly window; an expired timer never proves a reset. */
export function checkChanges({ report, threshold = 80, previousState = null, now = Date.now() }) {
  if (probability(threshold) === null) throw new Error('提醒阈值必须是 0 至 100 之间的数字。');
  if (!Number.isFinite(now)) throw new Error('当前时间无效。');
  const windows = new Map();
  if (previousState?.version === 1 && Array.isArray(previousState.windows)) {
    for (const value of previousState.windows) {
      const identity = normalizeWindow(value, now);
      if (!identity) continue;
      windows.set(windowKey(identity), {
        ...identity,
        personalProbability: probability(value.personalProbability),
        notified: previousState.threshold === threshold && value.notified === true,
      });
    }
  }

  const notifications = [];
  for (const value of Array.isArray(report?.weeklyWindows) ? report.weeklyWindows : []) {
    const identity = normalizeWindow(value, now);
    const currentProbability = probability(value?.personalProbability);
    if (!identity || currentProbability === null) continue;
    const key = windowKey(identity);
    const previous = windows.get(key);
    const notify = !previous?.notified && currentProbability >= threshold;
    windows.set(key, {
      ...identity,
      personalProbability: currentProbability,
      notified: previous?.notified === true || notify,
    });
    if (notify) {
      notifications.push({
        type: 'personal_probability_high',
        ...identity,
        personalProbability: currentProbability,
        reason: typeof value.reason === 'string' ? value.reason.slice(0, 256) : 'unavailable',
      });
    }
  }

  return {
    state: { version: 1, threshold, checkedAt: new Date(now).toISOString(), windows: [...windows.values()] },
    notifications,
  };
}

async function abortableSleep(milliseconds, { signal } = {}) {
  let remaining = milliseconds;
  while (remaining > 0 && !signal?.aborted) {
    const duration = Math.min(remaining, MAX_TIMER_MS);
    await delay(duration, undefined, { signal });
    remaining -= duration;
  }
}

function safeFailure(error, intervalMs) {
  const candidate = error?.status ?? error?.statusCode;
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : null;
  const requestedRetry = Number(error?.retryAfterSeconds);
  const retryAfterSeconds = status === 429 && Number.isFinite(requestedRetry) && requestedRetry > 0
    ? Math.max(intervalMs / 1000, requestedRetry)
    : intervalMs / 1000;
  const code = status === 401 || status === 403 ? 'authorization_failed'
    : status === 429 ? 'rate_limited'
      : status !== null && status >= 500 ? 'service_unavailable' : 'query_failed';
  return { type: 'error', status, code, retryAfterSeconds };
}

/** Foreground only. Scheduling or user notifications are owned by the caller. */
export async function runWatch({ sample, emit, intervalMs = MIN_POLL_INTERVAL_MS, signal, sleepImpl = abortableSleep }) {
  if (typeof sample !== 'function' || typeof emit !== 'function' || typeof sleepImpl !== 'function') {
    throw new Error('监测需要提供查询、输出和等待函数。');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('检查间隔必须是正数。');
  const pollInterval = Math.max(MIN_POLL_INTERVAL_MS, intervalMs);
  while (!signal?.aborted) {
    let result;
    let failure;
    try {
      result = await sample({ signal });
    } catch (error) {
      if (signal?.aborted) break;
      failure = safeFailure(error, pollInterval);
    }
    if (signal?.aborted) break;
    await emit(failure ?? { type: 'sample', result });
    if (failure?.code === 'authorization_failed') return { reason: 'authorization_failed', status: failure.status };
    if (signal?.aborted) break;
    try {
      await sleepImpl(failure ? failure.retryAfterSeconds * 1000 : pollInterval, { signal });
    } catch (error) {
      if (signal?.aborted) break;
      throw error;
    }
  }
  return { reason: 'aborted' };
}
