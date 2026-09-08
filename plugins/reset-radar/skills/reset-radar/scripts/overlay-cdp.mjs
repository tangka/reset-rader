import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRemoveExpression, buildTakeConfigurationExpression } from './overlay-card.mjs';

const execute = promisify(execFile);
const MAX_BYTES = 256 * 1024;
const APP_EXECUTABLE = /^\/Applications\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/;

export function validPort(value) {
  const port = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('CDP port must be an integer from 1024 to 65535.');
  }
  return port;
}

export function mainPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'app:' && Boolean(parsed.hostname)
      && !parsed.username && !parsed.password && !parsed.port
      && !/avatar-overlay|devtools/i.test(parsed.href);
  } catch { return false; }
}

export function filterTargets(input, port) {
  port = validPort(port);
  if (!Array.isArray(input)) return [];
  return input.filter((target) => {
    if (target?.type !== 'page' || !mainPage(target.url)
        || typeof target.id !== 'string' || !/^[\w-]{1,128}$/.test(target.id)) return false;
    try {
      const ws = new URL(target.webSocketDebuggerUrl);
      return ws.protocol === 'ws:' && ws.hostname === '127.0.0.1'
        && Number(ws.port) === port && !ws.username && !ws.password && !ws.search && !ws.hash
        && ws.pathname === `/devtools/page/${target.id}`;
    } catch { return false; }
  }).map(({id,url,webSocketDebuggerUrl}) => ({id,url,webSocketDebuggerUrl}));
}

export async function discoverTargets(port, {fetchImpl = fetch, signal, timeoutMs = 2000} = {}) {
  port = validPort(port);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal,timeout]) : timeout;
  let reader;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
      redirect:'error', signal:combined, headers:{accept:'application/json'},
    });
    if (!response.ok || !response.body) throw new Error();
    reader = response.body.getReader();
    let length = 0;
    const chunks = [];
    while (true) {
      combined.throwIfAborted();
      const {done,value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error();
      chunks.push(Buffer.from(value));
    }
    return filterTargets(JSON.parse(Buffer.concat(chunks).toString('utf8')),port);
  } catch { throw new Error('No compatible Codex debugging page on the verified local port.'); }
  finally { await reader?.cancel().catch(() => {}); }
}

/** Only inspect listeners owned by a known running desktop executable; never scan arbitrary ports. */
export async function desktopListeners({executeImpl = execute, platform = process.platform} = {}) {
  if (platform !== 'darwin') throw new Error('Automatic Codex desktop verification currently supports macOS only.');
  const {stdout} = await executeImpl('/bin/ps',['-axo','pid=,comm='],{timeout:3000,maxBuffer:1024*1024});
  const processes = stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && APP_EXECUTABLE.test(match[2]) ? [{pid:Number(match[1]),path:match[2]}] : [];
  });
  const listeners = [];
  for (const app of processes) {
    let output;
    try {
      output = (await executeImpl('/usr/sbin/lsof',
        ['-nP','-a','-p',String(app.pid),'-iTCP','-sTCP:LISTEN','-F','n'],
        {timeout:3000,maxBuffer:65536})).stdout;
    } catch (error) {
      if (error.code === 1) continue;
      throw new Error('Cannot verify the Codex desktop listening ports.');
    }
    const exposed = new Set();
    const local = new Set();
    for (const line of output.split('\n')) {
      const match = line.match(/^n(.+):(\d+)$/);
      if (!match) continue;
      const port = Number(match[2]);
      if (match[1] === '127.0.0.1') local.add(port);
      else if (match[1] !== '[::1]') exposed.add(port);
    }
    for (const port of local) if (!exposed.has(port)) listeners.push({...app,port});
  }
  return {processes,listeners};
}

export async function findDesktopTarget({port,targetId,signal,listenersImpl = desktopListeners,
  discover = discoverTargets} = {}) {
  if (port !== undefined) port = validPort(port);
  const {processes,listeners} = await listenersImpl();
  if (!processes.length) throw new Error('Codex desktop is not running. No application was launched or modified.');
  const candidates = listeners.filter((item) => port === undefined || item.port === port).slice(0,10);
  const matches = [];
  for (const item of candidates) {
    let targets;
    try { targets = await discover(item.port,{signal}); } catch { continue; }
    for (const target of targets) if (!targetId || target.id === targetId) matches.push({...target,port:item.port,pid:item.pid});
  }
  if (!matches.length) throw new Error('当前 Codex 未提供兼容的本机 CDP 主界面。未重启或修改应用；需先确认客户端支持调试启动。');
  if (matches.length > 1) {
    const error = new Error('More than one Codex window is available. Select --target from overlay doctor.');
    error.targets = matches.map(({id,port,pid}) => ({id,port,pid}));
    throw error;
  }
  return matches[0];
}

export class CdpPage {
  constructor(target, {WebSocketImpl = WebSocket, timeoutMs = 5000} = {}) {
    if (!filterTargets([{...target,type:'page'}],target.port).length) throw new Error('Unsafe CDP target rejected.');
    this.target = target;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
  }

  async open() {
    const socket = new this.WebSocketImpl(this.target.webSocketDebuggerUrl);
    this.socket = socket;
    socket.addEventListener('message',(event) => {
      if (typeof event.data !== 'string' || event.data.length > MAX_BYTES) { this.close(); return; }
      let message;
      try { message = JSON.parse(event.data); } catch { this.close(); return; }
      const job = this.pending.get(message.id);
      if (!job) return;
      clearTimeout(job.timer);
      this.pending.delete(message.id);
      if (message.error || message.result?.exceptionDetails) job.reject(new Error('Codex overlay evaluation failed.'));
      else job.resolve(message.result?.result?.value);
    });
    socket.addEventListener('error',() => this.close());
    socket.addEventListener('close',() => this.close());
    await new Promise((resolve,reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.removeEventListener('open',onOpen);
        socket.removeEventListener('error',onFailure);
        socket.removeEventListener('close',onFailure);
        if (error) { this.close(); reject(error); } else resolve();
      };
      const onOpen = () => finish();
      const onFailure = () => finish(new Error('Codex local debugging connection failed.'));
      const timer = setTimeout(onFailure,this.timeoutMs);
      socket.addEventListener('open',onOpen);
      socket.addEventListener('error',onFailure);
      socket.addEventListener('close',onFailure);
    });
  }

  evaluate(expression) {
    return this.#evaluate(expression, true);
  }

  takeConfiguration(sessionId) {
    // Private Node-only result; never forward to stdout, an agent or display payloads.
    return this.#evaluate(buildTakeConfigurationExpression({sessionId}), true);
  }

  removeOverlay(sessionId) {
    // Only fixed, session-owned cleanup may run after the main shell disappears.
    return this.#evaluate(buildRemoveExpression({sessionId}), false);
  }

  #evaluate(expression, requireShell) {
    if (this.socket?.readyState !== 1) return Promise.reject(new Error('Codex debugging connection is closed.'));
    // Guard each operation against navigation to a browser tab or the Pets renderer.
    const guarded = `(() => { if (location.protocol !== 'app:' ||
      location.host !== ${JSON.stringify(new URL(this.target.url).host)} ||
      (${requireShell} && (/avatar-overlay|devtools/i.test(location.href) ||
      !(document.querySelector('.main-surface, .browser-main-surface') ||
        (document.querySelector('#root main') &&
         document.querySelector('[data-testid="app-shell-header-context-menu-surface"]')))))) return {unsupported:true};
      return (${expression}); })()`;
    return new Promise((resolve,reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex overlay response timed out.'));
      },this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try { this.socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{
        expression:guarded,awaitPromise:true,returnByValue:true,
      }})); } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Codex overlay request failed.'));
      }
    });
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error('Codex debugging connection is closed.'));
    }
    this.pending.clear();
    if (socket && socket.readyState < 2) socket.close();
  }
}
