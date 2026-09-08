import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { queryRadar, commandTarget } from './api-client.mjs';
import { readLocalCodexRateLimits } from './local-codex.mjs';
import { buildPersonalProbability } from './personal-probability.mjs';
import { readPrivateFile, writePrivateFile } from './configuration.mjs';
import { MIN_POLL_INTERVAL_MS } from './monitor.mjs';
import { withCooldownLock } from './overlay-cooldown.mjs';

const messages = {
  401:'API Key 已失效，请在小程序中更新后点击“修改 Key”。',
  403:'此功能需要有效的长期会员。',
  429:'请求受限，等待冷却后自动更新。',
  503:'雷达数据暂不可用，稍后自动更新。',
};

export function safePayload(report, nextRefreshAt) {
  // Do not forward arbitrary API or account fields to the renderer.
  return {status:'ready',nextRefreshAt,report:{
    baseProbability:report.baseProbability,personalProbability:report.personalProbability,
    reason:report.reason,radarGeneratedAt:report.radarGeneratedAt,calculatedAt:report.calculatedAt,
    weeklyWindows:report.weeklyWindows.slice(0,16).map((window) => ({
      limitId:window.limitId,window:window.window,resetAt:window.resetAt,
      usedPercent:typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
        && window.usedPercent >= 0 ? window.usedPercent : null,
      personalProbability:window.personalProbability,reason:window.reason,
    })),
  }};
}

/** Auto-fetch every ten minutes; explicit refreshes still respect server retry deadlines. */
export class OverlayData {
  constructor(configuration,{directory,query = queryRadar,readLimits = readLocalCodexRateLimits,
    clock = Date.now,readFile = readPrivateFile,writeFile = writePrivateFile,
    withLock = withCooldownLock} = {}) {
    this.configuration = configuration;
    this.query = query;
    this.readLimits = readLimits;
    this.clock = clock;
    this.readFile = readFile;
    this.writeFile = writeFile;
    this.withLock = withLock;
    const identity = createHash('sha256').update(`${configuration.apiBase}\n${configuration.apiKey}`).digest('hex').slice(0,24);
    this.path = join(directory,`overlay-cooldown-${identity}.json`);
    this.nextRefreshAt = 0;
    this.retryAfterAt = 0;
    this.inputs = null;
    this.failure = null;
    this.terminal = false;
    this.initialized = false;
  }

  async readCooldown() {
    try {
      const value = JSON.parse(await this.readFile(this.path));
      if (!Number.isFinite(value.nextRefreshAt) || value.nextRefreshAt < 0 || value.nextRefreshAt > 8.64e15) throw new Error();
      const retryAfterAt = value.retryAfterAt === undefined ? 0 : value.retryAfterAt;
      if (!Number.isFinite(retryAfterAt) || retryAfterAt < 0 || retryAfterAt > 8.64e15) throw new Error();
      return {nextRefreshAt:value.nextRefreshAt,retryAfterAt};
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read overlay cooldown safely.');
      return {nextRefreshAt:0,retryAfterAt:0};
    }
  }

  async initialize() {
    const saved = await this.readCooldown();
    this.retryAfterAt = Math.max(this.retryAfterAt,saved.retryAfterAt);
    this.nextRefreshAt = Math.max(this.nextRefreshAt,saved.nextRefreshAt,this.retryAfterAt);
    this.initialized = true;
  }

  async reserve(nextRefreshAt,{signal,onlyIfDue = false,manual = false,retryAfterAt = 0} = {}) {
    return this.withLock(this.path,async () => {
      signal?.throwIfAborted();
      const saved = await this.readCooldown();
      this.retryAfterAt = Math.max(this.retryAfterAt,saved.retryAfterAt);
      this.nextRefreshAt = Math.max(this.nextRefreshAt,saved.nextRefreshAt,this.retryAfterAt);
      const now = this.clock();
      if (onlyIfDue && (now < this.retryAfterAt || (!manual && now < this.nextRefreshAt))) return false;
      const proposed = onlyIfDue ? Math.min(8.64e15,now+MIN_POLL_INTERVAL_MS) : nextRefreshAt;
      if (!Number.isFinite(proposed) || proposed < 0 || proposed > 8.64e15) throw new Error('Invalid overlay cooldown.');
      if (!Number.isFinite(retryAfterAt) || retryAfterAt < 0 || retryAfterAt > 8.64e15) throw new Error('Invalid overlay retry deadline.');
      const retryDeadline = Math.max(this.retryAfterAt,retryAfterAt);
      const reserved = Math.max(this.nextRefreshAt,proposed,retryDeadline);
      signal?.throwIfAborted();
      await this.writeFile(this.path,JSON.stringify({nextRefreshAt:reserved,
        ...(retryDeadline > 0 ? {retryAfterAt:retryDeadline} : {})}));
      this.nextRefreshAt = reserved;
      this.retryAfterAt = retryDeadline;
      return true;
    },{signal});
  }

  async refresh(signal,{manual = false} = {}) {
    if (this.inFlight) return this.inFlight;
    if (this.terminal || signal?.aborted || this.clock() < this.retryAfterAt
      || (!manual && this.clock() < this.nextRefreshAt)) return;
    // Assign before any asynchronous initialization, so same-instance calls share one attempt.
    this.inFlight = Promise.resolve().then(async () => {
      if (!this.initialized) await this.initialize();
      if (signal?.aborted) return;
      if (!await this.reserve(undefined,{signal,onlyIfDue:true,manual})) return;
      signal?.throwIfAborted();
      await this.fetchInputs(signal);
    }).catch(() => {
      if (signal?.aborted) return;
      this.inputs = null;
      this.terminal = true;
      this.failure = '无法安全读写雷达冷却状态或锁，请检查后重新打开。';
      throw new Error('Cannot update overlay cooldown safely; check private state and its lock before reopening.');
    });
    try { await this.inFlight; } finally { this.inFlight = null; }
  }

  async fetchInputs(signal) {
    this.inputs = null;
    this.failure = null;
    try {
      const overview = await this.query({...this.configuration,
        target:commandTarget(['overview']),signal});
      let rateLimits;
      try { rateLimits = await this.readLimits({signal}); } catch {
        if (signal?.aborted) return;
        rateLimits = null;
      }
      if (signal?.aborted) return;
      // Validate before retaining, then recompute from the same inputs on each heartbeat.
      buildPersonalProbability(overview,rateLimits,{now:this.clock()});
      this.inputs = {overview,rateLimits};
    } catch (error) {
      if (signal?.aborted) return;
      this.failure = messages[error.status] || '数据未就绪，请检查会员 API 与本机额度。';
      this.terminal = error.status === 401 || error.status === 403;
      if (error.status === 429) {
        const retry = Number.isFinite(error.retryAfterSeconds) ? Math.max(600,error.retryAfterSeconds) : 600;
        const retryAfterAt = Math.min(8.64e15,this.clock()+retry*1000);
        await this.reserve(retryAfterAt,{signal,retryAfterAt});
      }
    }
  }

  payload() {
    if (this.failure) return {status:'error',message:this.failure,nextRefreshAt:this.nextRefreshAt};
    if (!this.inputs) return {status:'loading',message:this.inFlight ? '正在读取雷达与周额度…'
      : '等待下次数据更新',nextRefreshAt:this.nextRefreshAt};
    try {
      return safePayload(buildPersonalProbability(this.inputs.overview,this.inputs.rateLimits,
        {now:this.clock()}),this.nextRefreshAt);
    } catch { return {status:'error',message:'雷达快照已过期，等待更新。',nextRefreshAt:this.nextRefreshAt}; }
  }
}
