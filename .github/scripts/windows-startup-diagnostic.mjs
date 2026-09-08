import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import { windowsSystemEnvironment } from '../../plugins/reset-radar/skills/reset-radar/scripts/windows-environment.mjs';

const executable = win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const minimal = windowsSystemEnvironment();
const standard = { ...minimal };
for (const [name, value] of Object.entries(process.env)) {
  if (/^(APPDATA|ALLUSERSPROFILE|SystemDrive|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramFiles\(x86\)|CommonProgramW6432|COMSPEC|COMPUTERNAME|USERNAME|USERDOMAIN|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name)) standard[name] = value;
}
const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/key|token|secret|password|credential|cookie|authorization/i.test(name)));
for (const [name, env] of [['minimal', minimal], ['standard', standard], ['standard-path', {
  ...standard, PATH: win32.join(process.env.SystemRoot, 'System32'),
}], ['scrubbed', scrubbed]]) {
  const start = Date.now();
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write("ready")'],
    { env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  console.log(JSON.stringify({ name, milliseconds: Date.now() - start, status: result.status,
    error: result.error?.code, ready: result.stdout === 'ready', stdoutBytes: result.stdout?.length,
    stderrBytes: result.stderr?.length }));
}
