import { spawn } from 'node:child_process';
import { resolveCodexRuntime } from './codex-runtime.mjs';

const MAX_OUTPUT_BYTES = 1024 * 1024;

function localError(code) {
  const messages = {
    aborted: 'Local Codex quota lookup was cancelled.',
    timeout: 'Local Codex quota lookup timed out.',
    unavailable: 'Local Codex quota lookup is unavailable; check the selected desktop or CLI runtime and its signed-in account.',
    protocol: 'Local Codex quota lookup returned an invalid response.',
    too_large: 'Local Codex quota lookup returned too much output.',
  };
  const error = new Error(messages[code]);
  error.code = `local_codex_${code}`;
  return error;
}

/** Read local account quotas without opening a session, model turn, or authentication flow. */
export async function readLocalCodexRateLimits({
  codexCommand, timeoutMs = 15000, signal, spawnImpl = spawn,
  resolveImpl = resolveCodexRuntime, environment = process.env,
} = {}) {
  if (signal?.aborted) return Promise.reject(localError('aborted'));
  if ((codexCommand !== undefined && (typeof codexCommand !== 'string' || !codexCommand))
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(localError('unavailable'));
  }
  const startedAt = Date.now();
  if (codexCommand === undefined) {
    const timeout = AbortSignal.timeout(Math.ceil(timeoutMs));
    try {
      const discoverySignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      ({ command: codexCommand } = await resolveImpl({ environment, signal: discoverySignal }));
      discoverySignal.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) throw localError('aborted');
      if (timeout.aborted) throw localError('timeout');
      if (/^local_codex_runtime_(?:invalid|ambiguous)$/.test(error.code)) throw error;
      throw localError('unavailable');
    }
  }
  if (signal?.aborted) throw localError('aborted');
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw localError('timeout');
  return new Promise((resolve, reject) => {
    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH');
    const env = { ...environment, PATH: pathKey ? environment[pathKey] : undefined };
    if (pathKey && pathKey !== 'PATH') delete env[pathKey];
    delete env.RESET_RADAR_API_KEY;
    delete env.RESET_RADAR_API_KEY_FILE;
    let child;
    try {
      child = spawnImpl(codexCommand, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'], env, shell: false,
      });
    } catch {
      reject(localError('unavailable'));
      return;
    }
    let settled = false;
    let buffer = '';
    let outputBytes = 0;
    let stage = 'initialize';
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Destroy pipes and terminate the short-lived reader on every outcome.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      try { child.kill(); } catch { /* The process may already have exited. */ }
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(localError('aborted'));
    const write = (message) => {
      if (settled) return;
      if (!child.stdin?.writable || child.stdin.destroyed) {
        finish(localError('unavailable'));
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) finish(localError('unavailable'));
        });
      } catch {
        finish(localError('unavailable'));
      }
    };
    const countOutput = (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) finish(localError('too_large'));
    };
    const acceptMessage = (message) => {
      if (!message || typeof message !== 'object') {
        finish(localError('protocol'));
        return;
      }
      if (message.id === 1 && stage === 'initialize') {
        if (message.error || !Object.hasOwn(message, 'result')) {
          finish(localError('unavailable'));
          return;
        }
        stage = 'quotas';
        write({ method: 'initialized', params: {} });
        write({ id: 2, method: 'account/rateLimits/read' });
      } else if (message.id === 2 && stage === 'quotas') {
        if (message.error) {
          finish(localError('unavailable'));
        } else if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
          finish(localError('protocol'));
        } else {
          finish(null, message.result);
        }
      }
    };
    timer = setTimeout(() => finish(localError('timeout')), remainingMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => finish(localError('unavailable')));
    child.on('exit', () => finish(localError('unavailable')));
    child.stdin?.on('error', () => finish(localError('unavailable')));
    child.stdout?.on('error', () => finish(localError('unavailable')));
    child.stderr?.on('error', () => finish(localError('unavailable')));
    child.stderr?.on('data', countOutput); // Drain but never retain or disclose stderr.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      countOutput(chunk);
      if (settled) return;
      buffer += chunk;
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch {
          finish(localError('protocol'));
          return;
        }
        acceptMessage(message);
      }
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    write({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'reset-radar', title: 'Reset Radar', version: '1.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
  });
}
