import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsSystemEnvironment } from './windows-environment.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./windows-private-file.ps1', import.meta.url));
const MAX_CONTENT_BYTES = 65536;
const MAX_OUTPUT_BYTES = 524288;
const TIMEOUT_MS = 15000;
const FAILURE_MESSAGE = 'Cannot access private radar Key file; check Windows owner and ACL permissions.';

function privateFileError(code = 'EPRIVATE') {
  const error = new Error(FAILURE_MESSAGE);
  error.code = code;
  return error;
}

function powershellLaunch() {
  const environment = windowsSystemEnvironment();
  const root = environment.SystemRoot || environment.windir;
  // Resolve only the Windows system installation, never PATH or a plugin command override.
  if (typeof root !== 'string' || !/^[a-z]:[\\/]/i.test(root)
    || /[\x00-\x1f<>"|?*]/.test(root) || root.slice(2).includes(':')) {
    throw privateFileError();
  }
  return {
    command: win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    environment,
  };
}

async function runPrivateFile(request, { spawnProcess = spawn, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    if (typeof request.path !== 'string' || !request.path || request.path.length > 32767
      || request.path.includes('\0') || !Number.isInteger(timeoutMs) || timeoutMs <= 0
      || timeoutMs > TIMEOUT_MS || (request.operation === 'write'
        && (typeof request.content !== 'string'
          || Buffer.byteLength(request.content, 'utf8') > MAX_CONTENT_BYTES))) {
      throw privateFileError();
    }
    const { command, environment } = powershellLaunch();
    const response = await new Promise((resolve, reject) => {
      let child;
      let timer;
      let settled = false;
      let length = 0;
      const chunks = [];
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chunks.length = 0;
        try { child?.kill(); } catch { /* Never expose process errors or arguments. */ }
        reject(privateFileError());
      };
      try {
        child = spawnProcess(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: environment,
        });
        timer = setTimeout(fail, timeoutMs);
        child.on('error', fail);
        child.stdin.on('error', fail);
        child.stdout.on('error', fail);
        child.stdout.on('data', (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.length;
          if (length > MAX_OUTPUT_BYTES) { fail(); return; }
          chunks.push(bytes);
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          if (code !== 0 || signal) { fail(); return; }
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            chunks.length = 0;
            if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') {
              fail(); return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(value);
          } catch { fail(); }
        });
        // All caller-controlled paths and content travel solely over the private stdin pipe.
        child.stdin.end(JSON.stringify(request), 'utf8');
      } catch { fail(); }
    });
    if (!response.ok) throw privateFileError(response.code === 'ENOENT' ? 'ENOENT' : 'EPRIVATE');
    if (request.operation === 'read') {
      if (typeof response.content !== 'string'
        || Buffer.byteLength(response.content, 'utf8') > MAX_CONTENT_BYTES) throw privateFileError();
      return response.content;
    }
  } catch (error) {
    // No child stderr, stdout, cause, pathname, command, or input belongs in an external error.
    throw privateFileError(error?.code === 'ENOENT' && error.message === FAILURE_MESSAGE ? 'ENOENT' : 'EPRIVATE');
  }
}

export async function readWindowsPrivateFile(path, options) {
  return runPrivateFile({ operation: 'read', path }, options);
}

export async function writeWindowsPrivateFile(path, content, options) {
  await runPrivateFile({ operation: 'write', path, content }, options);
}
