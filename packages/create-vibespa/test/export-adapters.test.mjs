import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { exportAdapters } from '../../../scripts/export-adapters.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vibespa-export-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'checkout');
  const write = async (path, value) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  await write('LICENSE', 'ISC license fixture.\n');
  for (const name of ['contracts', 'solid', 'local-first']) {
    await write(`packages/${name}/package.json`, {
      name: `@vibespa/${name}`, version: '0.1.0', type: 'module',
      files: ['dist', 'src'], exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      ...(name === 'contracts' ? {} : { dependencies: { '@vibespa/contracts': 'workspace:*' } }),
      devDependencies: { '@vibespa/development-only': 'workspace:*' },
      scripts: { prepack: 'node ../../not-shipped.mjs' },
    });
    const code = name === 'contracts' ? 'export const sharedValue = 42;\n' : "export { sharedValue } from '@vibespa/contracts';\n";
    await write(`packages/${name}/src/index.ts`, code);
    await write(`packages/${name}/dist/index.js`, code);
    await write(`packages/${name}/dist/index.d.ts`, name === 'contracts' ? 'export declare const sharedValue = 42;\n' : code);
  }
  return { root, directory, write };
}

// These fixtures have short regular-file names, so no extended tar headers are
// needed. Inspect the actual archive instead of trusting the staging directory.
function archiveFiles(bytes) {
  const tar = gunzipSync(bytes);
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
    const type = header[156];
    assert.notEqual(type, 49, `Hard link in portable archive: ${name}`);
    assert.notEqual(type, 50, `Symbolic link in portable archive: ${name}`);
    if (type === 0 || type === 48) files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('adapter archives include compiled exports and bundled exact-version contracts, and run outside the checkout', async t => {
  const { root, directory } = await fixture(t);
  // Shell metacharacters in the destination must remain literal path text.
  const destination = join(directory, 'portable output & keep');
  const exported = await exportAdapters({ root, destination });
  assert.deepEqual(exported.map(item => item.package), ['@vibespa/solid', '@vibespa/local-first']);
  for (const item of exported) {
    const bytes = await readFile(item.path);
    assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(item.path.endsWith(`-${item.sha256}.tgz`));
    const files = archiveFiles(bytes);
    const manifest = JSON.parse(files.get('package/package.json'));
    assert.equal(manifest.dependencies['@vibespa/contracts'], '0.1.0');
    assert.deepEqual(manifest.bundledDependencies, ['@vibespa/contracts']);
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.scripts, undefined);
    assert.ok(files.has('package/dist/index.js'));
    assert.ok(files.has('package/dist/index.d.ts'));
    assert.ok(files.has('package/src/index.ts'));
    assert.ok(files.has('package/LICENSE'));
    assert.ok(files.has('package/node_modules/@vibespa/contracts/dist/index.js'));
    assert.ok(files.has('package/node_modules/@vibespa/contracts/dist/index.d.ts'));
    const contracts = JSON.parse(files.get('package/node_modules/@vibespa/contracts/package.json'));
    assert.equal(contracts.name, '@vibespa/contracts');
    for (const [name, contents] of files) {
      if (name.endsWith('/package.json')) assert.doesNotMatch(contents.toString(), /workspace:|link:|file:/);
    }
    const extracted = join(directory, item.package.split('/')[1]);
    for (const [name, contents] of files) {
      assert.ok(name.startsWith('package/'));
      assert.ok(!name.split('/').includes('..'));
      const target = join(extracted, ...name.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    const imported = await import(pathToFileURL(join(extracted, 'package', 'dist', 'index.js')).href);
    assert.equal(imported.sharedValue, 42);
  }
});

test('a fresh export preserves previous artifacts and names changed content differently', async t => {
  const { root, directory, write } = await fixture(t);
  const destination = join(directory, 'artifacts');
  const before = await exportAdapters({ root, destination });
  const original = await readFile(before[0].path);
  await write('packages/solid/dist/index.js', "export { sharedValue } from '@vibespa/contracts';\nexport const changed = true;\n");
  const after = await exportAdapters({ root, destination });
  assert.notEqual(before[0].path, after[0].path);
  assert.deepEqual(await readFile(before[0].path), original);
  assert.equal(before[1].path, after[1].path);
  assert.ok((await readdir(destination)).length >= 3);
});

test('an adapter with missing compiled exports fails before creating output', async t => {
  const { root, directory } = await fixture(t);
  await rm(join(root, 'packages', 'local-first', 'dist', 'index.d.ts'));
  const destination = join(directory, 'artifacts');
  await assert.rejects(exportAdapters({ root, destination }), /@vibespa\/local-first needs compiled exports/);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('missing compiled contracts also fail before creating output', async t => {
  const { root, directory } = await fixture(t);
  await rm(join(root, 'packages', 'contracts', 'dist'), { recursive: true });
  const destination = join(directory, 'artifacts');
  await assert.rejects(exportAdapters({ root, destination }), /@vibespa\/contracts needs compiled exports/);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});
