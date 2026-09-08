import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = join(root, 'plugins/reset-radar');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `Unexpected link: ${entry.name}`);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}

test('repository marketplace resolves the packaged plugin and skill', async () => {
  const marketplace = await readJson(join(root, '.agents/plugins/marketplace.json'));
  const manifest = await readJson(join(plugin, '.codex-plugin/plugin.json'));
  assert.equal(marketplace.name, 'reset-radar');
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, manifest.name);
  assert.equal(entry.source.source, 'local');
  assert.equal(resolve(root, entry.source.path), plugin);
  assert.equal(entry.policy.installation, 'AVAILABLE');
  assert.equal(entry.policy.authentication, 'ON_INSTALL');
  assert.equal(manifest.version, (await readJson(join(plugin, 'package.json'))).version);
  const skill = await readFile(join(plugin, manifest.skills, 'reset-radar/SKILL.md'), 'utf8');
  assert.match(skill, /^name: reset-radar$/m);
});

test('all runtime modules stay within the standalone plugin', async () => {
  const paths = await files(plugin);
  for (const path of paths.filter((name) => name.endsWith('.mjs'))) {
    const source = await readFile(path, 'utf8');
    assert.ok(source.trimEnd().split('\n').length <= 600, relative(root, path));
    const imports = source.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g);
    for (const [, specifier] of imports) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('./'), `External import in ${relative(root, path)}: ${specifier}`);
      const target = resolve(dirname(path), specifier);
      assert.ok(target.startsWith(plugin + sep));
      assert.ok((await stat(target)).isFile());
    }
  }
  const manifest = await readJson(join(plugin, 'package.json'));
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test('distributed plugin contains no private directories or owner-specific paths', async () => {
  for (const path of await files(plugin)) {
    const name = relative(plugin, path);
    assert.doesNotMatch(name, /(^|\/)(?:private|node_modules|\.env|\.config|api-key)(\/|$)/);
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /\/Users\/tangka\/|\/opt\/reset-radar/);
    assert.doesNotMatch(source, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  }
});
