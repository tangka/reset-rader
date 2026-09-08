#!/usr/bin/env node

export const DEFAULT_API_BASE = 'https://api.tangka.online/radar-api/member/v1';
export const API_KEY_PATTERN = /^rr_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/;
const PLATFORM_PATTERN = /^[a-z0-9-]+$/;
const MAX_HISTORY_LIMIT = 14;
const REQUEST_TIMEOUT_MS = 20_000;

function argumentError(message) {
  const error = new Error(message);
  error.kind = 'argument';
  return error;
}

function requireValue(argumentsList, index, option) {
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw argumentError('Option requires a value');
  return value;
}

function historyTarget(argumentsList) {
  const platform = String(argumentsList[1] || '').toLowerCase();
  if (!PLATFORM_PATTERN.test(platform)) {
    throw argumentError('history requires a canonical platform id');
  }
  const query = new URLSearchParams();
  for (let index = 2; index < argumentsList.length; index += 1) {
    const option = argumentsList[index];
    const value = requireValue(argumentsList, index, option);
    index += 1;
    if (option === '--limit') {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
        throw argumentError('--limit must be an integer from 1 to 14');
      }
      query.set('limit', String(limit));
    } else if (option === '--before') {
      if (value.length > 500) throw argumentError('--before cursor is too long');
      query.set('before', value);
    } else if (option === '--date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw argumentError('--date must use YYYY-MM-DD');
      }
      query.set('date', value);
    } else {
      throw argumentError('unknown option; see --help');
    }
  }
  const suffix = query.size ? `?${query}` : '';
  return `/reset-history/${platform}${suffix}`;
}

export function commandTarget(argumentsList) {
  const command = String(argumentsList[0] || 'overview').toLowerCase();
  if (command === 'overview' && argumentsList.length === 1) return '/overview?naturalCycle=exclude';
  if ((command === 'status' || command === 'service-status') && argumentsList.length === 1) {
    return '/service-status';
  }
  if (command === 'history') return historyTarget(argumentsList);
  throw argumentError('unknown command; see --help');
}

function loopbackHost(hostname) {
  return ['127.0.0.1', '[::1]', 'localhost'].includes(hostname);
}

export function readConfiguration(environment) {
  const apiKey = String(environment.RESET_RADAR_API_KEY || '').trim();
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw argumentError('RESET_RADAR_API_KEY is missing or invalid');
  }
  let url;
  try {
    url = new URL(String(environment.RESET_RADAR_API_BASE || DEFAULT_API_BASE).trim());
  } catch {
    throw argumentError('RESET_RADAR_API_BASE is not a valid URL');
  }
  if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHost(url.hostname)))) {
    throw argumentError('RESET_RADAR_API_BASE must use HTTPS');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { apiBase: url.toString().replace(/\/$/, ''), apiKey };
}

function apiError(status, retry) {
  if (status === 401) return 'API Key is invalid or revoked; rotate it in the Mini Program.';
  if (status === 403) return 'An active long-term membership is required; monthly membership does not include API access.';
  if (status === 429) {
    return Number.isFinite(retry) && retry > 0
      ? `Rate limit reached; retry after ${Math.ceil(retry)} seconds.`
      : 'Rate limit reached; retry later.';
  }
  if (status === 503) return 'Reset Radar member API is temporarily unavailable.';
  if (status === 404) return 'The requested radar resource or platform is unavailable.';
  return `Reset Radar request failed (${status}).`;
}

export class RadarApiError extends Error {
  constructor(status, retryAfterSeconds = 0) {
    super(apiError(status, retryAfterSeconds));
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryDelay(response, payload) {
  const header = response.headers?.get('retry-after');
  const seconds = /^\d+$/.test(header || '') ? Number(header)
    : Math.ceil((Date.parse(header) - Date.now()) / 1000);
  return Math.max(0, Number.isFinite(seconds) ? seconds : 0,
    Number.isFinite(Number(payload?.retryAfterSeconds)) ? Number(payload.retryAfterSeconds) : 0);
}

export function safeJson(value, apiKey) {
  return JSON.stringify(value, null, 2).replaceAll(apiKey, '[REDACTED]');
}

async function readPayload(response, signal) {
  if (!response.body) throw new Error('Empty body');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const {done,value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw new Error('Response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function queryRadar({ apiBase, apiKey, fetchImpl = fetch, target, signal,
  timeoutMs = REQUEST_TIMEOUT_MS }) {
  // Commands never follow redirects with credentials or send local account information.
  if (!/^\/(overview\?naturalCycle=exclude|service-status|reset-history\/[a-z0-9-]+(?:\?.*)?)$/.test(target)) {
    throw argumentError('Unsupported read-only radar target');
  }
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(`${apiBase}${target}`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: requestSignal,
    });
    let payload = null;
    try { payload = await readPayload(response,requestSignal); } catch {
      if (!response.ok) throw new RadarApiError(response.status, retryDelay(response, null));
      throw new Error('Reset Radar returned invalid JSON or timed out reading it.');
    }
    if (!response.ok) throw new RadarApiError(response.status, retryDelay(response, payload));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Reset Radar returned an invalid response.');
    }
    if (target.startsWith('/overview') && payload.naturalCycle !== 'exclude') {
      throw new Error('Server did not confirm naturalCycle=exclude; refusing mixed-cycle data.');
    }
    return JSON.parse(safeJson(payload, apiKey));
  } catch (error) {
    if (error instanceof RadarApiError || error.message?.startsWith('Reset Radar returned')
        || error.message?.startsWith('Server did not confirm')) throw error;
    throw new Error('Reset Radar request could not reach the server or was cancelled.');
  }
}
