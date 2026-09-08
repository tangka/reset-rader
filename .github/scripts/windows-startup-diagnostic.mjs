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
const script = fileURLToPath(new URL('./windows-startup-probe.ps1', import.meta.url));
const systemPath = win32.join(process.env.SystemRoot, 'System32');
const safeEnvironment = { ...standard, PATH: systemPath, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const invoke = "& '" + script.replaceAll("'", "''") + "'";
const snapins = "$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; Add-PSSnapin Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility; ";
for (const [name, env, command] of [
  ['explicit-snapins-minimal', minimal, snapins + invoke],
  ['explicit-snapins-system', safeEnvironment, snapins + invoke],
  ['warmed-cache', { ...safeEnvironment, PSModuleAnalysisCachePath: process.env.PSModuleAnalysisCachePath }, invoke],
  ['cold-native-modules', { ...safeEnvironment, PSModulePath: win32.join(systemPath, 'WindowsPowerShell', 'v1.0', 'Modules') }, invoke],
]) {
  const start = Date.now();
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env, input: '', shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  console.log(JSON.stringify({ name, milliseconds: Date.now() - start, status: result.status, error: result.error?.code,
    markers: result.stdout?.split(/\r?\n/).filter((line) => ['BOOT','PATH','JSON','COMPILED'].includes(line)),
    diagnostic: result.stderr?.slice(0, 2000) }));
}
