import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CdpPage, findDesktopTarget, validPort } from './overlay-cdp.mjs';
import { loadConfiguration, stateDirectory } from './configuration.mjs';
import { OverlayData } from './overlay-data.mjs';
import { saveOverlayKey } from './overlay-configuration.mjs';
import { buildInstallExpression, buildUpdateExpression,
  buildStatusExpression } from './overlay-card.mjs';

export function parseOverlayArguments(args) {
  const command = args[0] || 'start';
  if (!['start','doctor','launch'].includes(command)) throw new Error('Use overlay start, doctor or launch.');
  const options = {command};
  for (let index = 1; index < args.length; index += 2) {
    const [name,value] = args.slice(index,index+2);
    if (!value || command === 'launch') throw new Error('Invalid overlay arguments.');
    if (name === '--port' && options.port === undefined) options.port = validPort(value);
    else if (name === '--target' && !options.targetId && /^[\w-]{1,128}$/.test(value)) options.targetId = value;
    else throw new Error('Use --port <local-port> and optional --target <window-id>.');
  }
  return options;
}

/** One explicitly selected desktop page, no browser tabs, no renderer scraping or auto-restart. */
export async function runOverlay({target,environment = process.env,signal,sessionId = randomUUID(),
  Page = CdpPage,Data = OverlayData,load = loadConfiguration,save = saveOverlayKey,emit = () => {},
  sleep = (ms,options) => delay(ms,undefined,options),intervalMs = 1_000} = {}) {
  const page = new Page(target);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  let data;
  let failure;
  let mounted = false;
  let refresh;
  let dataController = new AbortController();
  let configurationResult = null;
  let lastConfigurationRequest = 0;
  let lastRefreshRequest = 0;
  let activeConfiguration;
  const configurationLocked = Object.hasOwn(environment,'RESET_RADAR_API_KEY');
  try {
    combined.throwIfAborted();
    await page.open();
    combined.throwIfAborted();
    const result = await page.evaluate(buildInstallExpression({sessionId,
      payload:{status:'loading',message:'正在连接本机重置雷达…'}}));
    if (!result?.installed || result.owner !== sessionId) {
      throw new Error(result?.unsupported ? 'This Codex renderer is not compatible; nothing was injected.'
        : 'This Codex window already has a radar session, or the card was closed.');
    }
    mounted = true;
    emit({type:'overlay_attached',targetId:target.id});
    combined.throwIfAborted();
    try {
      const configuration = await load(environment);
      data = new Data(configuration,{directory:stateDirectory(environment)});
      activeConfiguration = configuration;
    } catch { failure = '请先配置长期会员 API Key，即可查看个人重置概率。'; }
    while (!combined.aborted) {
      const state = await page.evaluate(buildStatusExpression({sessionId}));
      if (combined.aborted) break;
      if (state?.unsupported) return {reason:'renderer_changed'};
      if (state?.closed || state?.owner !== sessionId) return {reason:'closed'};
      if (!state?.installed) return {reason:'renderer_changed'};
      if (state.configurationPending) {
        const request = await page.takeConfiguration(sessionId);
        combined.throwIfAborted();
        if (request && Number.isSafeInteger(request.requestId) && request.requestId > lastConfigurationRequest) {
          lastConfigurationRequest = request.requestId;
          try {
            const configuration = await save(request.key,environment);
            combined.throwIfAborted();
            if (!data || activeConfiguration?.apiKey !== configuration.apiKey
                || activeConfiguration?.apiBase !== configuration.apiBase) {
              // Finish cancellation before switching data owners; late old responses cannot render.
              dataController.abort();
              await refresh;
              refresh = null;
              dataController = new AbortController();
              data = new Data(configuration,{directory:stateDirectory(environment)});
              activeConfiguration = configuration;
              failure = null;
            }
            configurationResult = {requestId:request.requestId,saved:true,message:'已保存，正在连接雷达。'};
          } catch (error) {
            if (combined.aborted) throw error;
            const message = {
              OVERLAY_KEY_ENV_OVERRIDE:'Key 由环境变量提供，需先移除该变量再在这里配置。',
              OVERLAY_KEY_INVALID:'API Key 格式不正确，请重新粘贴完整 Key。',
            }[error.code] || '保存失败，请检查本机配置目录权限后重试。';
            configurationResult = {requestId:request.requestId,saved:false,message};
          } finally { request.key = ''; }
        } else if (request) { request.key = ''; }
      }
      const manualRequested = Number.isSafeInteger(state.refreshRequestId)
        && state.refreshRequestId > lastRefreshRequest;
      if (manualRequested) lastRefreshRequest = state.refreshRequestId;
      const canRefresh = Boolean(data && !data.terminal && !failure);
      // A click joins the current request instead of queuing a second fetch. Do not
      // carry a click made with the old Key across a configuration replacement.
      const manual = manualRequested && canRefresh && !state.configurationPending;
      if (data && !refresh && !data.inFlight) {
        const dataSignal = AbortSignal.any([combined,dataController.signal]);
        refresh = (manual ? data.refresh(dataSignal,{manual:true}) : data.refresh(dataSignal)).catch(() => {
          if (dataSignal.aborted) return;
          failure = '无法安全读写本机雷达状态，请检查权限后重新打开。';
        }).finally(() => { refresh = null; });
      }
      const payload = {...(failure ? {status:'error',message:failure} : data.payload()),
        configurationRequired:!data,configurationLocked,configurationResult,
        refreshRequestId:lastRefreshRequest,refreshing:Boolean(data?.inFlight),canRefresh,
        refreshBlockedUntil:data?.retryAfterAt || 0};
      await page.evaluate(buildUpdateExpression({sessionId,payload}));
      try { await sleep(intervalMs,{signal:combined}); } catch (error) {
        if (!combined.aborted) throw error;
      }
    }
    return {reason:'stopped'};
  } finally {
    controller.abort();
    dataController.abort();
    if (mounted) {
      try { await page.removeOverlay(sessionId); } catch { /* Host TTL makes disconnection explicit. */ }
    }
    page.close();
    await refresh;
  }
}

export async function waitForDesktop({port,signal,find = findDesktopTarget,
  clock = Date.now,sleep = (ms,options) => delay(ms,undefined,options)} = {}) {
  const deadline = clock()+25000;
  while (clock() < deadline) {
    signal?.throwIfAborted();
    try { return await find({port,signal}); } catch (error) {
      if (error.targets) throw error;
    }
    await sleep(1000,{signal});
  }
  throw new Error('已请求启动客户端，但未验证到安全的 Codex 调试入口。未注入卡片，也未扩大监听范围。');
}

export async function overlayMain(args,environment = process.env) {
  const {command,...options} = parseOverlayArguments(args);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    if (command === 'launch') {
      const {launchDebuggingDesktop} = await import('./overlay-launch.mjs');
      const result = await launchDebuggingDesktop({signal:controller.signal});
      const target = await waitForDesktop({port:result.port,signal:controller.signal});
      const page = new CdpPage(target);
      try {
        await page.open();
        const check = await page.evaluate('({compatible:true})');
        if (!check?.compatible) throw new Error('The launched desktop renderer is not compatible; nothing was injected.');
      } finally { page.close(); }
      process.stdout.write(`${JSON.stringify({...result,debuggingReady:true,targetId:target.id})}\n`
        +`Next: overlay start --port ${result.port} --target ${target.id}\n`);
      return;
    }
    let target;
    try { target = await findDesktopTarget({...options,signal:controller.signal}); } catch (error) {
      if (command === 'doctor' && error.targets) {
        process.stdout.write(`${JSON.stringify({available:true,windows:error.targets})}\n`);
        return;
      }
      throw error;
    }
    if (command === 'doctor') {
      const page = new CdpPage(target);
      try {
        await page.open();
        const result = await page.evaluate('({compatible:true})');
        process.stdout.write(`${JSON.stringify({available:result?.compatible === true,
          port:target.port,targetId:target.id,pid:target.pid})}\n`);
      } finally { page.close(); }
    } else {
      const result = await runOverlay({target,environment,signal:controller.signal,
        emit:value => process.stdout.write(`${JSON.stringify(value)}\n`)});
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop);
  }
}
