import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  buildInstallExpression, buildUpdateExpression, buildRemoveExpression, buildStatusExpression,
  buildTakeConfigurationExpression,
} from './overlay-card.mjs';

const START = Date.parse('2026-09-08T10:00:00Z');

// A small DOM with real listener bubbling and a controllable clock. It deliberately
// rejects innerHTML and networking so executable renderer expressions exercise the
// display/lifecycle contract without touching a running Codex instance.
function renderer() {
  let now = START;
  let document;
  const targets = [];
  const intervals = new Map();
  class Target {
    constructor() { this.listeners = new Map(); targets.push(this); }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? new Set();
      list.add(fn);
      this.listeners.set(type, list);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatch(type, values = {}) {
      const event = { type, target: this, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
      let target = this;
      while (target) {
        for (const fn of [...(target.listeners?.get(type) ?? [])]) fn(event);
        if (event.stopped) break;
        target = target.parentNode;
      }
      return event;
    }
  }
  class Element extends Target {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = new Map();
      this.style = {};
      this.hidden = false;
      this._text = '';
      this.id = '';
      this.className = '';
      this.activeElement = null;
    }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map((node) => node.textContent).join(''); }
    set innerHTML(_) { throw new Error('HTML insertion is forbidden'); }
    get isConnected() {
      return this === document?.body || this === document?.head || Boolean((this.parentNode ?? this.host)?.isConnected);
    }
    append(...nodes) {
      for (const node of nodes) {
        node.remove();
        node.parentNode = this;
        this.children.push(node);
      }
    }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
      this.parentNode = null;
    }
    replaceChildren(...nodes) {
      for (const node of [...this.children]) node.remove();
      this._text = '';
      this.append(...nodes);
    }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    attachShadow() { this.shadowRoot = new Element('#shadow-root'); this.shadowRoot.host = this; return this.shadowRoot; }
    focus() {
      if (document.activeElement?.shadowRoot) document.activeElement.shadowRoot.activeElement = null;
      let root = this;
      while (root.parentNode) root = root.parentNode;
      if (root.host) { root.activeElement = this; document.activeElement = root.host; }
      else document.activeElement = this;
    }
    setPointerCapture() {}
    getBoundingClientRect() {
      const width = Math.min(250, window.innerWidth - 16);
      const height = find(this.shadowRoot, '.body')?.hidden ? 52 : Math.min(330, window.innerHeight - 16);
      const left = this.style.left ? parseFloat(this.style.left) : window.innerWidth - width - 24;
      const top = this.style.top ? parseFloat(this.style.top) : window.innerHeight - height - 24;
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
  }
  function find(root, selector) {
    if (!root) return null;
    const matches = selector.startsWith('#') ? root.id === selector.slice(1)
      : root.className.split(' ').includes(selector.slice(1));
    if (matches) return root;
    for (const child of root.children) { const result = find(child, selector); if (result) return result; }
    return null;
  }
  const window = new Target();
  window.innerWidth = 1100;
  window.innerHeight = 800;
  document = { body: new Element('body'), head: new Element('head'), activeElement: null,
    createElement: (tag) => new Element(tag),
    getElementById: (id) => find(document.body, `#${id}`) ?? find(document.head, `#${id}`) };
  const unrelated = new Element('div');
  unrelated.id = 'codex-main-content';
  unrelated.textContent = 'Keep this Codex conversation';
  unrelated.style.color = 'red';
  document.body.append(unrelated);
  const context = vm.createContext({ window, document,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    setInterval(fn, duration) { const id = Symbol(); intervals.set(id, { fn, duration }); return id; },
    clearInterval: (id) => intervals.delete(id),
    fetch() { throw new Error('Network access is forbidden'); } });
  return {
    window, document, unrelated, intervals,
    run: (expression) => JSON.parse(JSON.stringify(vm.runInContext(expression, context))),
    host: () => document.getElementById('reset-radar-overlay-v1'),
    node: (selector) => find(document.getElementById('reset-radar-overlay-v1')?.shadowRoot, selector),
    advance(ms) { now += ms; for (const { fn } of intervals.values()) fn(); },
    listenerCount: () => targets.reduce((sum, target) => sum + [...target.listeners.values()].reduce((n, set) => n + set.size, 0), 0),
  };
}

function ready(overrides = {}) {
  return { status: 'ready', canRefresh: true, nextRefreshAt: START + 15000, report: {
    baseProbability: 36.25, personalProbability: 100, reason: 'weekly_reset_within_24h',
    radarGeneratedAt: new Date(START).toISOString(), calculatedAt: new Date(START).toISOString(),
    weeklyWindows: [{ limitId: 'codex', window: 'secondary', resetAt: new Date(START + 3600000).toISOString(),
      usedPercent: 14, personalProbability: 100, reason: 'weekly_reset_within_24h' }], ...overrides,
  } };
}

function install(env, payload = ready(), sessionId = 'first') {
  return env.run(buildInstallExpression({ sessionId, payload }));
}
function update(env, payload = ready(), sessionId = 'first') {
  return env.run(buildUpdateExpression({ sessionId, payload }));
}

test('renderer expressions install loading, update real fields and preserve unrelated DOM', () => {
  const env = renderer();
  assert.deepEqual(install(env, { status: 'loading' }), { installed: true, closed: false, owner: 'first' });
  assert.equal(env.node('.personal').textContent, '--');
  assert.match(env.node('.status').textContent, /正在读取/);
  update(env);
  assert.equal(env.node('.personal').textContent, '100%');
  assert.equal(env.node('.number').textContent, '36.3%');
  assert.equal(env.node('.countdown').textContent, '01:00:00');
  assert.match(env.node('.updated').textContent, /雷达 \d\d:\d\d:\d\d/);
  assert.equal(env.node('.window-name').textContent, 'Codex 周额度');
  assert.equal(env.node('.usage').textContent, '已用 14% · 剩余 86%');
  assert.equal(env.node('.refresh').textContent, '15秒后刷新');
  assert.equal(env.unrelated.textContent, 'Keep this Codex conversation');
  assert.deepEqual(env.unrelated.style, { color: 'red' });
  assert.equal(env.document.head.children.length, 0);
  assert.equal(env.intervals.size, 1);
  assert.equal([...env.intervals.values()][0].duration, 1000);
  assert.deepEqual(env.run(buildStatusExpression({ sessionId: 'first' })), { installed: true, closed: false, owner: 'first' });
});

test('refresh icon sits before collapse and one click stays pending until the bridge finishes', () => {
  const env = renderer();
  install(env);
  const button = env.node('.refresh-button');
  const header = env.node('.header').children;
  assert.equal(header[1], button);
  assert.equal(header[2].textContent, '−');
  assert.equal(button.getAttribute('aria-label'), '刷新雷达和周额度');
  assert.equal(button.disabled, false);
  assert.equal(button.dispatch('click').stopped, true);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(env.run(buildStatusExpression({sessionId:'first'})).refreshRequestId, 1);
  button.dispatch('click');
  update(env, ready()); // The previous heartbeat cannot acknowledge this click.
  assert.equal(button.disabled, true);
  assert.equal(env.run(buildStatusExpression({sessionId:'first'})).refreshRequestId, 1);
  update(env, {...ready(), refreshRequestId:1, refreshing:true});
  assert.equal(button.disabled, true);
  assert.equal(button.title, '正在刷新…');
  update(env, {...ready(), refreshRequestId:1});
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), 'false');
  button.dispatch('click');
  assert.equal(env.run(buildStatusExpression({sessionId:'first'})).refreshRequestId, 2);
  update(env, {...ready(), refreshRequestId:2}, 'intruder');
  assert.equal(button.disabled, true);
  update(env, {...ready(), status:'error', message:'暂时不可用', refreshRequestId:2});
  assert.equal(button.disabled, false); // A completed failed attempt can be retried.
});

test('refresh cannot run without configuration, during a save, after disconnect or close', () => {
  const env = renderer();
  install(env, {status:'loading',configurationRequired:true});
  const button = env.node('.refresh-button');
  const requestId = () => env.run(buildStatusExpression({sessionId:'first'})).refreshRequestId;
  button.dispatch('click');
  assert.equal(requestId(), undefined);
  update(env, ready());
  env.node('.key-cancel').dispatch('click');
  env.node('.configure').dispatch('click');
  env.node('.key-input').value = 'test-only-key';
  env.node('.configuration').dispatch('submit');
  button.dispatch('click');
  assert.equal(requestId(), undefined);
  update(env, {...ready(),configurationResult:{requestId:1,saved:true}});
  env.advance(90001);
  button.dispatch('click');
  assert.equal(button.disabled, true);
  assert.equal(requestId(), undefined);
  update(env, ready());
  env.run(buildRemoveExpression({sessionId:'first'}));
  button.dispatch('click');
  assert.equal(requestId(), undefined);
});

test('server retry deadline blocks manual refresh before but not at or after expiry', () => {
  const env = renderer();
  install(env, {...ready(), refreshBlockedUntil:START+1000});
  const button = env.node('.refresh-button');
  assert.equal(button.disabled, true);
  assert.match(button.title, /1秒后/);
  env.advance(999);
  button.dispatch('click');
  assert.equal(env.run(buildStatusExpression({sessionId:'first'})).refreshRequestId, undefined);
  env.advance(1);
  assert.equal(button.disabled, false);
  env.advance(1);
  button.dispatch('click');
  assert.equal(env.run(buildStatusExpression({sessionId:'first'})).refreshRequestId, 1);
});

test('untrusted payload fields remain text and loading or error never retains a probability', () => {
  const env = renderer();
  const html = '<img src=x onerror=alert(1)>';
  install(env, ready({ weeklyWindows: [{ limitId: html, window: 'secondary', resetAt: '', personalProbability: 100 }] }));
  assert.equal(env.node('.window-name').textContent, `${html} 周额度`);
  assert.equal(env.node('.window-name').children.length, 0);
  update(env, { ...ready(), status: 'error', message: html });
  assert.equal(env.node('.status').textContent, html);
  assert.equal(env.node('.status').children.length, 0);
  assert.equal(env.node('.personal').textContent, '--');
  assert.equal(env.node('.number').textContent, '--');
  assert.equal(env.node('.window-probability').textContent, '--');
  assert.equal(env.node('.usage').textContent, '使用率暂不可用');
  update(env, { ...ready(), status: 'loading' });
  assert.equal(env.node('.number').textContent, '--');
});

test('weekly usage shows used and remaining without converting unavailable values to zero', () => {
  const env = renderer();
  install(env);
  for (const [usedPercent, expected] of [
    [0, '已用 0% · 剩余 100%'], [100, '已用 100% · 剩余 0%'],
    [105, '已用 105% · 剩余 0%'], [14.25, '已用 14.3% · 剩余 85.8%'],
    [null, '使用率暂不可用'], [undefined, '使用率暂不可用'],
    [-1, '使用率暂不可用'], [NaN, '使用率暂不可用'],
    [Infinity, '使用率暂不可用'], ['14', '使用率暂不可用'],
  ]) {
    const payload = ready();
    payload.report.weeklyWindows[0].usedPercent = usedPercent;
    update(env, payload);
    assert.equal(env.node('.usage').textContent, expected);
    assert.equal(env.node('.personal').textContent, '100%');
    assert.equal(env.node('.countdown').textContent, '01:00:00');
  }
});

test('weekly usage clears before stale values can outlive their reset or bridge', () => {
  for (const boundary of ['reset', 'bridge']) {
    const env = renderer();
    const payload = ready();
    if (boundary === 'reset') payload.report.weeklyWindows[0].resetAt = new Date(START + 1000).toISOString();
    install(env, payload);
    const duration = boundary === 'reset' ? 1000 : 90001;
    env.advance(duration - 1);
    assert.equal(env.node('.usage').textContent, '已用 14% · 剩余 86%');
    env.advance(1);
    assert.equal(env.node('.usage').textContent, '使用率暂不可用');
    env.advance(1);
    assert.equal(env.node('.usage').textContent, '使用率暂不可用');
    const refreshed = ready();
    refreshed.report.weeklyWindows[0].usedPercent = 0;
    update(env, refreshed);
    assert.equal(env.node('.usage').textContent, '已用 0% · 剩余 100%');
  }
});

test('heartbeat expires after 90 seconds and only an owner update revives the display', () => {
  const env = renderer();
  install(env);
  env.advance(89999);
  assert.equal(env.node('.personal').textContent, '100%');
  env.advance(1);
  assert.equal(env.node('.personal').textContent, '100%');
  env.advance(1);
  assert.equal(env.node('.personal').textContent, '--');
  assert.equal(env.node('.number').textContent, '--');
  assert.match(env.node('.status').textContent, /连接已暂停/);
  update(env, ready(), 'intruder');
  assert.equal(env.node('.personal').textContent, '--');
  update(env);
  assert.equal(env.node('.personal').textContent, '100%');
});

test('radar freshness boundary is two hours regardless of a fresh host heartbeat', () => {
  const env = renderer();
  const payload = ready({ radarGeneratedAt: new Date(START - 7200000 + 1000).toISOString() });
  install(env, payload);
  assert.equal(env.node('.number').textContent, '36.3%');
  env.advance(1000);
  assert.equal(env.node('.number').textContent, '36.3%');
  env.advance(1);
  assert.equal(env.node('.number').textContent, '--');
  assert.equal(env.node('.personal').textContent, '--');
  assert.match(env.node('.status').textContent, /雷达数据已过期/);
  assert.equal(env.node('.usage').textContent, '使用率暂不可用');
  update(env, payload);
  assert.equal(env.node('.number').textContent, '--');
  update(env, ready());
  assert.equal(env.node('.number').textContent, '36.3%');
});

test('weekly expiry clears the personal probability at the boundary but keeps fresh extra-reset data', () => {
  const env = renderer();
  install(env, ready({ weeklyWindows: [{ limitId: 'codex', window: 'secondary', resetAt: new Date(START + 1000).toISOString(), personalProbability: 100 }] }));
  assert.equal(env.node('.personal').textContent, '100%');
  assert.equal(env.node('.countdown').textContent, '00:00:01');
  env.advance(1000);
  assert.equal(env.node('.personal').textContent, '--');
  assert.equal(env.node('.window-probability').textContent, '--');
  assert.equal(env.node('.number').textContent, '36.3%');
  assert.match(env.node('.countdown').textContent, /已到期/);
  env.advance(1000);
  assert.equal(env.node('.personal').textContent, '--');
});

test('multiple weekly windows stay distinct and expiry affects only the matching row', () => {
  const env = renderer();
  install(env, ready({ personalProbability: null, reason: 'multiple_weekly_windows', weeklyWindows: [
    { limitId: 'codex-a', window: 'primary', resetAt: new Date(START + 1000).toISOString(), personalProbability: 100 },
    { limitId: 'codex-b', window: 'secondary', resetAt: new Date(START + 172800000).toISOString(), personalProbability: 36.25 },
  ] }));
  assert.equal(env.node('.personal').textContent, '--');
  const rows = env.node('.windows').children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /codex-a 周额度100%00:00:01/);
  assert.match(rows[1].textContent, /codex-b 周额度36.3%2天/);
  env.advance(1000);
  assert.match(rows[0].textContent, /周额度--已到期/);
  assert.match(rows[1].textContent, /周额度36.3%1天/);
});

test('radar update label follows the radar snapshot rather than each fresh calculation', () => {
  const env = renderer();
  const radarGeneratedAt = new Date(START - 600000).toISOString();
  install(env, ready({ radarGeneratedAt }));
  const label = env.node('.updated').textContent;
  assert.equal(label, `雷达 ${new Date(radarGeneratedAt).toLocaleTimeString('zh-CN', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })}`);
  env.advance(15000);
  update(env, ready({ radarGeneratedAt, calculatedAt: new Date(START + 15000).toISOString() }));
  assert.equal(env.node('.updated').textContent, label);
  update(env, ready({ radarGeneratedAt: new Date(START).toISOString() }));
  assert.notEqual(env.node('.updated').textContent, label);
});

test('missing, invalid or future times and non-numeric probabilities never produce a valid number', () => {
  const env = renderer();
  install(env, ready({ radarGeneratedAt: 'invalid' }));
  assert.equal(env.node('.number').textContent, '--');
  update(env, ready({ radarGeneratedAt: new Date(START + 300001).toISOString() }));
  assert.equal(env.node('.number').textContent, '--');
  update(env, ready({ calculatedAt: '' }));
  assert.equal(env.node('.personal').textContent, '--');
  update(env, ready({ baseProbability: '100', personalProbability: Infinity }));
  assert.equal(env.node('.personal').textContent, '--');
  assert.equal(env.node('.number').textContent, '--');
});

test('collapse expands with native button semantics and drag/keyboard movement clamps to viewport', () => {
  const env = renderer();
  install(env);
  const collapse = env.node('.collapse');
  collapse.dispatch('click');
  assert.equal(env.node('.body').hidden, true);
  assert.equal(collapse.getAttribute('aria-expanded'), 'false');
  update(env);
  assert.equal(env.node('.body').hidden, true);
  collapse.dispatch('click');
  assert.equal(env.node('.body').hidden, false);
  const handle = env.node('.drag');
  const rect = env.host().getBoundingClientRect();
  handle.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: rect.left + 5, clientY: rect.top + 5 });
  env.window.dispatch('pointermove', { pointerId: 1, clientX: -100, clientY: -100 });
  assert.equal(env.host().style.left, '8px');
  assert.equal(env.host().style.top, '8px');
  env.window.dispatch('pointermove', { pointerId: 1, clientX: 9999, clientY: 9999 });
  assert.equal(env.host().style.left, '842px');
  assert.equal(env.host().style.top, '462px');
  env.window.dispatch('pointerup', { pointerId: 1 });
  env.window.dispatch('pointermove', { pointerId: 1, clientX: 0, clientY: 0 });
  assert.equal(env.host().style.left, '842px');
  handle.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(env.host().style.left, '826px');
  env.window.innerWidth = 320;
  env.window.innerHeight = 400;
  env.window.dispatch('resize');
  assert.equal(env.host().style.left, '62px');
  assert.equal(env.host().style.top, '62px');
});

test('Escape only closes while focused inside the card and cleanup releases every resource', () => {
  const env = renderer();
  install(env);
  assert.ok(env.listenerCount() > 0);
  env.unrelated.focus();
  const shadow = env.host().shadowRoot;
  shadow.dispatch('keydown', { key: 'Escape' });
  assert.ok(env.host());
  env.node('.drag').focus();
  const event = shadow.dispatch('keydown', { key: 'Escape' });
  assert.equal(event.prevented, true);
  assert.equal(env.host(), null);
  assert.equal(env.listenerCount(), 0);
  assert.equal(env.intervals.size, 0);
  assert.deepEqual(update(env), { installed: false, closed: true, owner: 'first' });
  assert.deepEqual(install(env), { installed: false, closed: true, owner: 'first' });
});

test('owner isolation prevents old sessions from updating, removing or reinstalling over a new card', () => {
  const env = renderer();
  install(env);
  assert.equal(install(env, ready(), 'second').owner, 'first');
  assert.equal(env.run(buildRemoveExpression({ sessionId: 'second' })).installed, true);
  env.node('.close').dispatch('click');
  assert.equal(env.host(), null);
  assert.equal(install(env, ready(), 'second').owner, 'second');
  update(env, { status: 'error', message: 'old state' });
  assert.equal(env.node('.personal').textContent, '100%');
  assert.equal(env.run(buildRemoveExpression({ sessionId: 'first' })).owner, 'second');
  assert.equal(install(env).owner, 'second');
  env.run(buildRemoveExpression({ sessionId: 'second' }));
  assert.equal(env.host(), null);
  assert.deepEqual(install(env), { installed: false, closed: true, owner: 'second' });
  assert.equal(env.listenerCount(), 0);
});

test('update/status/remove without installation do not touch the page', () => {
  const env = renderer();
  for (const expression of [buildStatusExpression({ sessionId: 'first' }),
    buildUpdateExpression({ sessionId: 'first', payload: ready() }), buildRemoveExpression({ sessionId: 'first' })]) {
    assert.deepEqual(env.run(expression), { installed: false, closed: false, owner: null });
  }
  assert.equal(env.document.body.children.length, 1);
  assert.equal(env.intervals.size, 0);
  assert.throws(() => buildInstallExpression({ sessionId: '', payload: ready() }), /session ID/);
});

test('missing Key opens private input; explicit submit clears it and only owner can consume once', () => {
  const env = renderer();
  install(env, {status:'error', configurationRequired:true});
  assert.equal(env.node('.configuration').hidden, false);
  const input = env.node('.key-input');
  assert.equal(input.type, 'password');
  assert.equal(input.autocomplete, 'off');
  env.node('.configuration').dispatch('submit');
  assert.match(env.node('.key-feedback').textContent, /完整/);
  assert.equal(env.run(buildTakeConfigurationExpression({sessionId:'first'})), null);
  input.value = 'test-only-private-value';
  assert.equal(input.dispatch('paste').stopped, true);
  env.node('.configuration').dispatch('submit');
  assert.equal(input.value, '');
  assert.equal(env.node('.key-save').disabled, true);
  const status = env.run(buildStatusExpression({sessionId:'first'}));
  assert.equal(status.configurationPending, true);
  assert.ok(!JSON.stringify(status).includes('test-only-private-value'));
  assert.equal(env.run(buildTakeConfigurationExpression({sessionId:'intruder'})), null);
  assert.deepEqual(env.run(buildTakeConfigurationExpression({sessionId:'first'})),
    {requestId:1,key:'test-only-private-value'});
  assert.equal(env.run(buildTakeConfigurationExpression({sessionId:'first'})), null);
  update(env, {...ready(), configurationResult:{requestId:1,saved:true,message:'已保存'}});
  assert.equal(env.node('.configuration').hidden, true);
  assert.equal(env.node('.key-save').disabled, false);
  assert.equal(env.node('.personal').textContent, '100%');
  env.node('.configure').dispatch('click');
  assert.equal(env.node('.configuration').hidden, false);
  assert.equal(input.value, '');
});

test('failed saves retry without reusing secrets; stale acknowledgements cannot close a newer attempt', () => {
  const env = renderer();
  install(env, {status:'error',configurationRequired:true});
  const input = env.node('.key-input');
  input.value = 'bad-key';
  env.node('.configuration').dispatch('submit');
  env.run(buildTakeConfigurationExpression({sessionId:'first'}));
  update(env, {status:'error',configurationRequired:true,
    configurationResult:{requestId:1,saved:false,message:'请重新粘贴'}});
  assert.equal(input.value, '');
  assert.equal(env.node('.key-save').disabled, false);
  assert.equal(env.node('.key-feedback').textContent, '请重新粘贴');
  input.value = 'next-key';
  env.node('.configuration').dispatch('submit');
  update(env, {status:'error',configurationRequired:true,
    configurationResult:{requestId:1,saved:true,message:'旧结果'}});
  assert.equal(env.node('.key-save').disabled, true);
  assert.deepEqual(env.run(buildTakeConfigurationExpression({sessionId:'first'})),{requestId:2,key:'next-key'});
  update(env, {...ready(),configurationResult:{requestId:2,saved:true}});
  env.node('.configure').dispatch('click');
  input.value = 'discard-me';
  env.node('.key-cancel').dispatch('click');
  assert.equal(input.value, '');
  assert.equal(env.node('.configuration').hidden, true);
});

test('closing, collapse and bridge expiry clear unsubmitted credentials; closed queues cannot be read', () => {
  const env = renderer();
  install(env, {status:'error',configurationRequired:true});
  const input = env.node('.key-input');
  input.value = 'discard-on-collapse';
  env.node('.collapse').dispatch('click');
  assert.equal(input.value, '');
  env.node('.collapse').dispatch('click');
  input.value = 'discard-on-disconnect';
  env.advance(90001);
  assert.equal(input.value, '');
  assert.equal(env.node('.key-save').disabled, true);
  update(env, {status:'error',configurationRequired:true});
  input.value = 'discard-on-close';
  env.node('.configuration').dispatch('submit');
  env.node('.close').dispatch('click');
  assert.equal(env.run(buildTakeConfigurationExpression({sessionId:'first'})), null);
  assert.equal(env.listenerCount(), 0);
});
