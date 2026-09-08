import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsSystemEnvironment } from '../plugins/reset-radar/skills/reset-radar/scripts/windows-environment.mjs';

const directory = fileURLToPath(new URL('../plugins/reset-radar/skills/reset-radar/scripts/', import.meta.url));
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const script = [
  "$ErrorActionPreference = 'Stop'",
  "$watch = [System.Diagnostics.Stopwatch]::StartNew()",
  "[Console]::Out.WriteLine('BOOT')",
  `. ${literal(win32.join(directory, 'windows-powershell-bootstrap.ps1'))}`,
  "[Console]::Out.WriteLine('MODULES ' + $watch.ElapsedMilliseconds)",
  `. ${literal(win32.join(directory, 'windows-private-file-library.ps1'))}`,
  "[Console]::Out.WriteLine('COMPILED ' + $watch.ElapsedMilliseconds)",
  "try { [void][RadarPrivateFile]::Read([IO.Path]::Combine([IO.Path]::GetTempPath(), [Guid]::NewGuid().ToString('N'), 'missing')) } catch {}",
  "[Console]::Out.WriteLine('READ ' + $watch.ElapsedMilliseconds)",
].join('\n');
const env = windowsSystemEnvironment();
const executable = win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const started = Date.now();
const child = spawn(executable, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],
  {env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data', chunk => console.log(Date.now()-started, chunk.toString().trim()));
child.stderr.on('data', chunk => console.error(chunk.toString()));
const timer = setTimeout(() => child.kill(), 60000);
child.on('close', (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });
