function session(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) {
    throw new TypeError('A non-empty overlay session ID is required.');
  }
  return value;
}

function text(value, length = 240) {
  return typeof value === 'string' ? value.slice(0, length) : '';
}

function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function cleanPayload(value = {}) {
  const report = value.report;
  return {
    status: ['loading', 'ready', 'error'].includes(value.status) ? value.status : 'error',
    message: text(value.message),
    canRefresh: value.canRefresh === true,
    refreshing: value.refreshing === true,
    refreshRequestId: Number.isSafeInteger(value.refreshRequestId) && value.refreshRequestId >= 0
      ? value.refreshRequestId : 0,
    refreshBlockedUntil: Number.isFinite(value.refreshBlockedUntil) && value.refreshBlockedUntil >= 0
      ? value.refreshBlockedUntil : 0,
    configurationRequired: value.configurationRequired === true,
    configurationLocked: value.configurationLocked === true,
    configurationResult: Number.isSafeInteger(value.configurationResult?.requestId)
      && value.configurationResult.requestId > 0 ? {
        requestId: value.configurationResult.requestId,
        saved: value.configurationResult.saved === true,
        message: text(value.configurationResult.message),
      } : null,
    nextRefreshAt: Number.isFinite(value.nextRefreshAt) ? value.nextRefreshAt : null,
    report: report && typeof report === 'object' ? {
      baseProbability: probability(report.baseProbability),
      personalProbability: probability(report.personalProbability),
      reason: text(report.reason, 80),
      radarGeneratedAt: text(report.radarGeneratedAt, 40),
      calculatedAt: text(report.calculatedAt, 40),
      weeklyWindows: Array.isArray(report.weeklyWindows) ? report.weeklyWindows.slice(0, 32).map((row) => ({
        limitId: text(row?.limitId, 100), window: text(row?.window, 40),
        resetAt: text(row?.resetAt, 40), personalProbability: probability(row?.personalProbability),
        usedPercent: typeof row?.usedPercent === 'number' && Number.isFinite(row.usedPercent)
          && row.usedPercent >= 0 ? row.usedPercent : null,
        reason: text(row?.reason, 80),
      })) : [],
    } : null,
  };
}

// This function runs only inside the selected Codex main renderer.
function installCard(owner, initialPayload) {
  const key = '__resetRadarOverlayV1';
  const hostId = 'reset-radar-overlay-v1';
  const previous = window[key];
  if (previous) {
    if (previous.owner === owner) return previous.status();
    if (!previous.closed || previous.retired?.includes(owner)) return previous.status();
  }
  if (document.getElementById(hostId)) return { installed: false, closed: false, owner: previous?.owner ?? null };

  const host = document.createElement('div');
  host.id = hostId;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; position: fixed !important; right: 24px; bottom: 24px;
      z-index: 2147483000 !important; width: min(250px, calc(100vw - 16px));
      display: block !important; color-scheme: light dark; pointer-events: auto; -webkit-app-region: no-drag;
      --rr-paper: #fff; --rr-tint: #f5f2fc; --rr-ink: #292239; --rr-muted: #776f88;
      --rr-purple: #7557d6; --rr-line: #e5dff2; --rr-shadow: #21143d24;
      font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      color: var(--rr-ink); font-size: 12px; line-height: 1.45; text-align: left; }
    @media (prefers-color-scheme: dark) { :host { --rr-paper: #24202f; --rr-tint: #2e273d;
      --rr-ink: #f0eafb; --rr-muted: #b6aacb; --rr-purple: #ba9af5;
      --rr-line: #453a56; --rr-shadow: #0006; } }
    *, *::before, *::after { box-sizing: border-box; }
    button { font: inherit; color: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--rr-purple); outline-offset: -3px; }
    [hidden] { display: none !important; }
    .card { overflow: auto; max-height: calc(100vh - 16px); border: 1px solid var(--rr-line);
      border-radius: 15px; background: var(--rr-paper); box-shadow: 0 9px 35px var(--rr-shadow); }
    .header { display: flex; align-items: center; gap: 1px; padding: 8px 7px 8px 11px;
      border-bottom: 1px solid var(--rr-line); }
    .drag { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;
      padding: 4px 0; border: 0; background: none; text-align: left; cursor: grab; touch-action: none; }
    .drag:active { cursor: grabbing; }
    .brand { font-size: 12px; font-weight: 750; letter-spacing: .3px; }
    .radar { position: relative; width: 19px; height: 19px; flex-shrink: 0;
      border: 1px solid var(--rr-purple); border-radius: 50%; }
    .radar::before { content: ''; position: absolute; inset: 4px; border: 1px solid var(--rr-purple); border-radius: 50%; opacity: .55; }
    .radar::after { content: ''; position: absolute; width: 8px; height: 1px; left: 9px; top: 8px;
      background: var(--rr-purple); transform: rotate(-45deg); transform-origin: left; }
    .icon { width: 27px; height: 27px; border: 0; border-radius: 7px; background: none; font-size: 17px; }
    .icon:hover { background: var(--rr-tint); }
    .refresh-symbol { display: inline-block; font-size: 20px; line-height: 1; }
    .refresh-button[aria-busy="true"] .refresh-symbol { animation: radar-refresh-spin 1s linear infinite; }
    @keyframes radar-refresh-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .refresh-button[aria-busy="true"] .refresh-symbol { animation: none; } }
    .body { padding: 13px 14px 10px; }
    .headline { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .label { color: var(--rr-muted); font-size: 11px; }
    .personal { color: var(--rr-purple); font-family: ui-rounded, 'SF Pro Display', -apple-system, sans-serif;
      font-size: 35px; font-weight: 700; line-height: 1.12; letter-spacing: -1.4px;
      font-variant-numeric: tabular-nums; }
    .base { display: flex; align-items: center; justify-content: space-between; margin-top: 10px;
      padding: 7px 9px; border-radius: 7px; background: var(--rr-tint); }
    .number { font-weight: 650; font-variant-numeric: tabular-nums; }
    .status { margin: 9px 0 10px; color: var(--rr-muted); font-size: 11px; overflow-wrap: anywhere; }
    .windows { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
    .window { padding-top: 8px; border-top: 1px solid var(--rr-line); }
    .window-head { display: flex; justify-content: space-between; gap: 6px; font-size: 10px; }
    .window-name { overflow-wrap: anywhere; color: var(--rr-muted); }
    .window-probability { flex-shrink: 0; color: var(--rr-purple); font-weight: 650; }
    .countdown { display: block; margin-top: 2px; font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
      font-size: 13px; font-variant-numeric: tabular-nums; }
    .usage { display: block; margin-top: 5px; color: var(--rr-muted); font-size: 11px;
      font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .empty { color: var(--rr-muted); font-size: 11px; }
    .footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 3px 8px;
      padding: 8px 14px; border-top: 1px solid var(--rr-line); color: var(--rr-muted); font-size: 10px; }
    .configure { border: 0; padding: 0; background: none; color: var(--rr-purple); font-size: 11px; }
    .configuration { margin: 12px 0; padding-top: 10px; border-top: 1px solid var(--rr-line); }
    .key-label { display: block; margin-bottom: 6px; font-weight: 650; }
    .key-input { width: 100%; min-width: 0; height: 34px; padding: 7px 9px; border-radius: 7px;
      border: 1px solid var(--rr-line); background: var(--rr-tint); color: var(--rr-ink); font: inherit; }
    .key-input:focus-visible { outline: 2px solid var(--rr-purple); outline-offset: 1px; }
    .key-hint, .key-feedback { margin: 6px 0; font-size: 10px; color: var(--rr-muted); overflow-wrap: anywhere; }
    .key-actions { display: flex; gap: 7px; margin-top: 9px; }
    .key-save { flex: 1; padding: 7px 9px; border: 1px solid var(--rr-purple); border-radius: 7px;
      background: var(--rr-purple); color: var(--rr-paper); font-weight: 650; }
    .key-cancel { border: 0; background: none; padding: 7px; }
    button:disabled { cursor: default; opacity: .55; }
  `;
  shadow.append(style);
  function element(tag, className, content, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content;
    parent?.append(node);
    return node;
  }
  const card = element('section', 'card', '', shadow);
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Reset Radar 重置雷达');
  const header = element('header', 'header', '', card);
  const handle = element('button', 'drag', '', header);
  handle.type = 'button';
  handle.setAttribute('aria-label', '移动雷达卡片，使用方向键调整位置');
  handle.title = '拖动移动 · 方向键微调';
  element('span', 'radar', '', handle).setAttribute('aria-hidden', 'true');
  element('span', 'brand', 'Reset Radar', handle);
  const refreshButton = element('button', 'icon refresh-button', '', header);
  refreshButton.type = 'button';
  element('span', 'refresh-symbol', '↻', refreshButton).setAttribute('aria-hidden', 'true');
  const collapse = element('button', 'icon collapse', '−', header);
  collapse.type = 'button';
  collapse.setAttribute('aria-label', '收起雷达卡片');
  collapse.setAttribute('aria-expanded', 'true');
  collapse.setAttribute('aria-controls', 'radar-body');
  const close = element('button', 'icon close', '×', header);
  close.type = 'button';
  close.setAttribute('aria-label', '关闭雷达卡片');
  const body = element('div', 'body', '', card);
  body.id = 'radar-body';
  const headline = element('div', 'headline', '', body);
  const labels = element('div', '', '', headline);
  element('div', '', '个人重置概率', labels);
  element('div', 'label', '未来 24 小时', labels);
  const personal = element('strong', 'personal', '--', headline);
  personal.setAttribute('aria-label', '个人未来 24 小时重置概率');
  const baseRow = element('div', 'base', '', body);
  element('span', 'label', '额外重置概率', baseRow);
  const base = element('span', 'number', '--', baseRow);
  const message = element('p', 'status', '', body);
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  const configuration = element('form', 'configuration', '', body);
  configuration.hidden = true;
  const keyLabel = element('label', 'key-label', '长期会员 API Key', configuration);
  keyLabel.setAttribute('for', 'radar-key');
  const keyInput = element('input', 'key-input', '', configuration);
  keyInput.id = 'radar-key';
  keyInput.type = 'password';
  keyInput.value = '';
  keyInput.maxLength = 512;
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = '粘贴 API Key';
  keyInput.setAttribute('aria-describedby', 'radar-key-hint');
  element('p', 'key-hint', '仅保存到本机，用于连接重置雷达。', configuration).id = 'radar-key-hint';
  const keyFeedback = element('p', 'key-feedback', '', configuration);
  keyFeedback.setAttribute('role', 'status');
  const keyActions = element('div', 'key-actions', '', configuration);
  const keySave = element('button', 'key-save', '保存并连接', keyActions);
  keySave.type = 'submit';
  const keyCancel = element('button', 'key-cancel', '取消', keyActions);
  keyCancel.type = 'button';
  const windows = element('ul', 'windows', '', body);
  windows.setAttribute('aria-label', '周额度恢复倒计时');
  const footer = element('footer', 'footer', '', card);
  const updated = element('span', 'updated', '', footer);
  const refresh = element('span', 'refresh', '', footer);
  const configure = element('button', 'configure', '配置 Key', footer);
  configure.type = 'button';
  document.body.append(host);

  let payload = initialPayload;
  let heartbeatAt = Date.now();
  let timer;
  let drag = null;
  let positioned = false;
  let rows = [];
  let requestSequence = 0;
  let refreshRequestSequence = 0;
  let pendingConfiguration = null;
  let savingConfiguration = false;
  let appliedResult = 0;
  let configurationOpen = initialPayload.configurationRequired === true;
  const listeners = [];
  const state = {
    owner, closed: false, retired: [...(previous?.retired ?? []), ...(previous ? [previous.owner] : [])],
    status: () => ({ installed: host.isConnected && document.getElementById(hostId) === host,
      closed: state.closed, owner, ...(pendingConfiguration ? {configurationPending:true} : {}),
      ...(refreshRequestSequence ? {refreshRequestId:refreshRequestSequence} : {}) }),
    takeConfiguration() {
      if (window[key] !== state || state.closed || !host.isConnected) return null;
      const request = pendingConfiguration;
      pendingConfiguration = null;
      return request;
    },
    update(next) {
      if (window[key] !== state || state.closed) return state.status();
      payload = next;
      heartbeatAt = Date.now();
      const result = payload.configurationResult;
      if (result && result.requestId === requestSequence && result.requestId > appliedResult) {
        appliedResult = result.requestId;
        savingConfiguration = false;
        keyInput.value = '';
        keyFeedback.textContent = result.message;
        configurationOpen = !result.saved;
      }
      buildRows();
      render();
      clamp();
      return state.status();
    },
    remove() {
      if (window[key] !== state) return window[key]?.status() ?? { installed: false, closed: false, owner: null };
      state.closed = true;
      clearInterval(timer);
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
      listeners.length = 0;
      drag = null;
      pendingConfiguration = null;
      keyInput.value = '';
      savingConfiguration = false;
      host.remove();
      return state.status();
    },
  };
  window[key] = state;
  function listen(target, type, listener) {
    target.addEventListener(type, listener);
    listeners.push([target, type, listener]);
  }
  function place(left, top) {
    const rect = host.getBoundingClientRect();
    const width = Math.max(0, window.innerWidth);
    const height = Math.max(0, window.innerHeight);
    const insetX = width > rect.width + 16 ? 8 : 0;
    const insetY = height > rect.height + 16 ? 8 : 0;
    host.style.left = `${Math.max(insetX, Math.min(left, width - rect.width - insetX))}px`;
    host.style.top = `${Math.max(insetY, Math.min(top, height - rect.height - insetY))}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    positioned = true;
  }
  function clamp() {
    const rect = host.getBoundingClientRect();
    if (positioned || rect.left < 8 || rect.top < 8) place(rect.left, rect.top);
  }
  const timestamp = (value) => typeof value === 'string' && value ? Date.parse(value) : NaN;
  const percent = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${Math.round(value * 10) / 10}%` : '--';
  const localTime = (value) => Number.isFinite(value)
    ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--';
  function countdown(reset, now) {
    if (!Number.isFinite(reset)) return '时间暂不可用';
    if (reset <= now) return '已到期 · 等待更新';
    const seconds = Math.ceil((reset - now) / 1000);
    const days = Math.floor(seconds / 86400);
    const hour = Math.floor(seconds % 86400 / 3600);
    const minute = Math.floor(seconds % 3600 / 60);
    return `${days ? `${days}天 ` : ''}${[hour, minute, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':')}`;
  }
  function buildRows() {
    windows.replaceChildren();
    rows = (payload.report?.weeklyWindows ?? []).map((row) => {
      const item = element('li', 'window', '', windows);
      const heading = element('div', 'window-head', '', item);
      const bucket = row.limitId.toLowerCase() === 'codex' ? 'Codex' : row.limitId || 'Codex';
      element('span', 'window-name', `${bucket} 周额度`, heading);
      const value = element('span', 'window-probability', '--', heading);
      value.setAttribute('aria-label', '该周额度未来 24 小时重置概率');
      const clock = element('span', 'countdown', '', item);
      const usage = element('span', 'usage', '', item);
      return { row, value, clock, usage };
    });
    if (!rows.length) element('li', 'empty', '周额度时间暂不可用', windows);
  }
  function render() {
    const now = Date.now();
    const report = payload.report;
    const generated = timestamp(report?.radarGeneratedAt);
    const calculated = timestamp(report?.calculatedAt);
    const freshRadar = Number.isFinite(generated) && generated <= now + 300000 && now - generated <= 7200000;
    const freshHost = now - heartbeatAt <= 90000;
    const refreshing = payload.refreshing || refreshRequestSequence > payload.refreshRequestId;
    const blockedSeconds = Math.max(0, Math.ceil((payload.refreshBlockedUntil - now) / 1000));
    refreshButton.disabled = !payload.canRefresh || refreshing || blockedSeconds > 0 || !freshHost
      || savingConfiguration || configurationOpen || payload.configurationRequired;
    refreshButton.setAttribute('aria-busy', String(Boolean(refreshing && freshHost)));
    refreshButton.title = !freshHost ? '连接已暂停' : refreshing ? '正在刷新…'
      : blockedSeconds > 0 ? `请求受限，${blockedSeconds}秒后可刷新` : '刷新雷达和周额度';
    refreshButton.setAttribute('aria-label', refreshButton.title);
    if (!freshHost) {
      pendingConfiguration = null;
      keyInput.value = '';
      savingConfiguration = false;
      keyFeedback.textContent = '连接已暂停，请重新打开雷达后配置。';
    }
    configuration.hidden = !(configurationOpen || payload.configurationRequired);
    configure.textContent = payload.configurationRequired ? '配置 Key' : '修改 Key';
    configure.disabled = savingConfiguration || payload.configurationLocked || !freshHost;
    keyInput.disabled = savingConfiguration || payload.configurationLocked || !freshHost;
    keySave.disabled = keyInput.disabled;
    keySave.textContent = savingConfiguration ? '正在保存…' : '保存并连接';
    keyCancel.hidden = payload.configurationRequired === true;
    keyCancel.disabled = savingConfiguration;
    if (payload.configurationLocked) keyFeedback.textContent = 'Key 由环境变量提供，需先移除该变量再在这里配置。';
    const valid = payload.status === 'ready' && freshRadar && freshHost && Number.isFinite(calculated)
      && calculated <= now + 300000 && percent(report?.baseProbability) !== '--';
    const allWindows = report?.weeklyWindows ?? [];
    const codexWindows = allWindows.filter((row) => row.limitId.toLowerCase() === 'codex');
    const candidates = codexWindows.length ? codexWindows : allWindows;
    const selected = candidates.length === 1 ? candidates[0] : null;
    const selectedReset = timestamp(selected?.resetAt);
    const personalValid = valid && selected && Number.isFinite(selectedReset) && selectedReset > now;
    personal.textContent = personalValid ? percent(report.personalProbability) : '--';
    base.textContent = valid ? percent(report.baseProbability) : '--';
    let status = {
      weekly_reset_within_24h: '周额度将在 24 小时内恢复',
      extra_reset_only: '24 小时内仅计额外重置',
      multiple_weekly_windows: '多个周额度，请分别查看',
    }[report?.reason] ?? '周额度时间暂不可用';
    if (selected && Number.isFinite(selectedReset) && selectedReset <= now) status = '周额度已到期，等待更新';
    if (payload.status === 'loading') status = payload.message || '正在读取雷达与周额度…';
    else if (payload.status === 'error') status = payload.message || '暂时无法读取数据';
    else if (!freshHost) status = '连接已暂停，等待更新';
    else if (!freshRadar) status = '雷达数据已过期，等待更新';
    else if (!Number.isFinite(calculated) || calculated > now + 300000) status = '计算时间不可用，等待更新';
    if (message.textContent !== status) message.textContent = status;
    for (const { row, value, clock, usage } of rows) {
      const reset = timestamp(row.resetAt);
      value.textContent = valid && reset > now ? percent(row.personalProbability) : '--';
      clock.textContent = countdown(reset, now);
      const hasUsage = valid && reset > now && row.usedPercent !== null;
      const formatUsage = (value) => value.toLocaleString('zh-CN', { maximumFractionDigits: 1, useGrouping: false });
      usage.textContent = hasUsage
        ? `已用 ${formatUsage(row.usedPercent)}% · 剩余 ${formatUsage(Math.max(0, 100 - row.usedPercent))}%`
        : '使用率暂不可用';
    }
    updated.textContent = `雷达 ${localTime(generated)}`;
    const refreshAt = payload.nextRefreshAt;
    refresh.textContent = !freshHost ? '等待连接' : Number.isFinite(refreshAt)
      ? refreshAt > now ? `${Math.ceil((refreshAt - now) / 1000)}秒后刷新` : '等待刷新' : '';
  }
  listen(refreshButton, 'click', (event) => {
    event.stopPropagation();
    render();
    if (refreshButton.disabled || state.closed || !host.isConnected || window[key] !== state) return;
    refreshRequestSequence += 1;
    render();
  });
  listen(collapse, 'click', () => {
    keyInput.value = '';
    body.hidden = !body.hidden;
    footer.hidden = body.hidden;
    collapse.textContent = body.hidden ? '+' : '−';
    collapse.setAttribute('aria-expanded', String(!body.hidden));
    collapse.setAttribute('aria-label', body.hidden ? '展开雷达卡片' : '收起雷达卡片');
    clamp();
  });
  listen(close, 'click', () => state.remove());
  listen(configure, 'click', () => {
    if (configure.disabled) return;
    configurationOpen = true;
    keyFeedback.textContent = '';
    render();
    clamp();
    keyInput.focus();
  });
  listen(keyCancel, 'click', () => {
    if (savingConfiguration) return;
    keyInput.value = '';
    keyFeedback.textContent = '';
    configurationOpen = false;
    render();
    clamp();
  });
  listen(configuration, 'submit', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (keySave.disabled || savingConfiguration || state.closed) return;
    const apiKey = keyInput.value.trim();
    keyInput.value = '';
    if (!apiKey || apiKey.length > 512) {
      keyFeedback.textContent = '请粘贴完整的 API Key。';
      keyInput.focus();
      return;
    }
    pendingConfiguration = {requestId:++requestSequence, key:apiKey};
    savingConfiguration = true;
    keyFeedback.textContent = '正在安全保存到本机…';
    render();
  });
  // Do not bubble typed/pasted credentials to the surrounding conversation UI.
  for (const type of ['input','change','paste','copy','cut','keydown','keyup']) {
    listen(keyInput, type, (event) => event.stopPropagation());
  }
  listen(shadow, 'keydown', (event) => {
    if (event.key !== 'Escape' || (!shadow.activeElement && document.activeElement !== host)) return;
    event.preventDefault();
    event.stopPropagation();
    state.remove();
  });
  listen(handle, 'keydown', (event) => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = host.getBoundingClientRect();
    const step = event.shiftKey ? 48 : 16;
    place(rect.left + direction[0] * step, rect.top + direction[1] * step);
  });
  listen(handle, 'pointerdown', (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const rect = host.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    handle.focus();
  });
  listen(window, 'pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    place(event.clientX - drag.x, event.clientY - drag.y);
  });
  const stopDrag = (event) => { if (event.pointerId === drag?.id) drag = null; };
  listen(window, 'pointerup', stopDrag);
  listen(window, 'pointercancel', stopDrag);
  listen(window, 'resize', clamp);
  buildRows();
  render();
  clamp();
  timer = setInterval(render, 1000);
  return state.status();
}

export function buildInstallExpression({ sessionId, payload }) {
  return `(${installCard.toString()})(${JSON.stringify(session(sessionId))},${JSON.stringify(cleanPayload(payload))})`;
}

export function buildUpdateExpression({ sessionId, payload }) {
  return `(() => { const state = window.__resetRadarOverlayV1;
    if (!state) return { installed: false, closed: false, owner: null };
    return state.owner === ${JSON.stringify(session(sessionId))}
      ? state.update(${JSON.stringify(cleanPayload(payload))}) : state.status(); })()`;
}

export function buildRemoveExpression({ sessionId }) {
  return `(() => { const state = window.__resetRadarOverlayV1;
    if (!state) return { installed: false, closed: false, owner: null };
    return state.owner === ${JSON.stringify(session(sessionId))} ? state.remove() : state.status(); })()`;
}

export function buildStatusExpression({ sessionId }) {
  session(sessionId);
  return `(() => { const state = window.__resetRadarOverlayV1;
    return state ? state.status() : { installed: false, closed: false, owner: null }; })()`;
}

// Read once from this card's explicit submit queue. Never log this return value.
export function buildTakeConfigurationExpression({ sessionId }) {
  return `(() => { const state = window.__resetRadarOverlayV1;
    return state && state.owner === ${JSON.stringify(session(sessionId))}
      ? state.takeConfiguration?.() ?? null : null; })()`;
}
