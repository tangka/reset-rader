import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

async function check(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const path = join(directory,entry.name);
    if (entry.isDirectory()) { await check(path); continue; }
    if (!entry.name.endsWith('.mjs')) continue;
    const lines = (await readFile(path,'utf8')).trimEnd().split('\n').length;
    if (lines > 600) throw new Error(`Source exceeds 600 lines: ${entry.name}`);
    const result = spawnSync(process.execPath,['--check',path],{stdio:'inherit'});
    if (result.status !== 0) throw new Error(`Syntax check failed: ${entry.name}`);
  }
}
await check(fileURLToPath(new URL('.',import.meta.url)));
process.stdout.write('Plugin source checks passed.\n');
