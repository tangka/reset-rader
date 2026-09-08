import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsSystemEnvironment } from '../../plugins/reset-radar/skills/reset-radar/scripts/windows-environment.mjs';

const executable = win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const minimal = windowsSystemEnvironment();
const standard = { ...minimal };
for (const [name, value] of Object.entries(process.env)) {
  if (/^(APPDATA|ALLUSERSPROFILE|SystemDrive|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramFiles\(x86\)|CommonProgramW6432|COMSPEC|COMPUTERNAME|USERNAME|USERDOMAIN|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name)) standard[name] = value;
}
const withProgramFiles = { ...minimal };
for (const [name, value] of Object.entries(process.env)) {
  if (/^ProgramFiles(\(x86\))?$/i.test(name)) withProgramFiles[name] = value;
}
const script = fileURLToPath(new URL('./windows-startup-probe.ps1', import.meta.url));
const systemPath = win32.join(process.env.SystemRoot, 'System32');
const modulePath = win32.join(systemPath, 'WindowsPowerShell', 'v1.0', 'Modules');
const safeFull = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/key|token|secret|password|credential|cookie|authorization/i.test(name)));
console.log(JSON.stringify({systemModules: modulePath, moduleDirectories: process.env.PSModulePath?.split(';')}));
const moduleInfo = spawnSync(executable, ['-NoLogo','-NoProfile','-NonInteractive','-Command',
  '[Console]::Out.WriteLine($PSHOME); [Console]::Out.WriteLine((Get-Command Join-Path).Module.Path); [Console]::Out.WriteLine((Get-Command Add-Type).Module.Path)'],
{env:safeFull, shell:false, windowsHide:true, encoding:'utf8', timeout:5000, maxBuffer:65536});
console.log(JSON.stringify({moduleInfo:moduleInfo.stdout?.trim().split(/\r?\n/), status:moduleInfo.status}));
for (const [name, env] of [
  ['standard-full-modules-file', { ...standard, PATH: systemPath, PSModulePath: process.env.PSModulePath, PATHEXT: '.COM;.EXE;.BAT;.CMD' }],
  ...process.env.PSModulePath.split(';').filter(Boolean).map((path, index) => [`module-${index}`, {
    ...standard, PATH: systemPath, PSModulePath: path, PATHEXT: '.COM;.EXE;.BAT;.CMD',
  }]),
  ['scrubbed-file', safeFull],
]) {
  const start = Date.now();
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { env, input: '', shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  console.log(JSON.stringify({ name, milliseconds: Date.now() - start, status: result.status, error: result.error?.code,
    markers: result.stdout?.split(/\r?\n/).filter((line) => ['BOOT','PATH','JSON','COMPILED'].includes(line)), stderrBytes: result.stderr?.length }));
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
