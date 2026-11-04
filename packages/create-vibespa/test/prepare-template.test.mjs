import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applicationWorkspace, copyDesignSystemPackage } from '../../../scripts/prepare-template.mjs';

// Shaped like the checkout's pnpm-workspace.yaml.
const checkout = [
  'packages:', '  - packages/*', '  - apps/*', '',
  'autoInstallPeers: false', '',
  'overrides:', "  '@solidjs/signals': 2.0.0-rc.14", "  '@solidjs/compiler': 2.0.0-rc.14", '',
  'allowBuilds:', '  esbuild: true', '',
  'minimumReleaseAgeExclude:', '  - fake-indexeddb@6.2.6', '',
].join('\n');
const archives = new Map([
  ['@vibespa/core', 'file:./vendor/vibespa-core-0.1.0-aaa.tgz'],
  ['@vibespa/solid', 'file:./vendor/vibespa-solid-0.1.0-bbb.tgz'],
]);
const expected = [
  'autoInstallPeers: false', '',
  'overrides:', '  # One instance of each framework package across the dependency graph.',
  "  '@vibespa/core': file:./vendor/vibespa-core-0.1.0-aaa.tgz",
  "  '@vibespa/solid': file:./vendor/vibespa-solid-0.1.0-bbb.tgz",
  "  '@solidjs/signals': 2.0.0-rc.14", "  '@solidjs/compiler': 2.0.0-rc.14", '',
  'allowBuilds:', '  esbuild: true', '',
  'minimumReleaseAgeExclude:', '  - fake-indexeddb@6.2.6', '',
].join('\n');

test('application workspace settings are identical for LF and CRLF checkouts', () => {
  for (const [label, text] of [['LF', checkout], ['CRLF', checkout.replaceAll('\n', '\r\n')]]) {
    const result = applicationWorkspace(text, archives);
    assert.equal(result, expected, label);
    assert.doesNotMatch(result, /packages:|packages\/\*|apps\/\*|\r/, `${label}: workspace package list removed`);
  }
});

test('application workspace settings require an overrides section', () => {
  assert.throws(() => applicationWorkspace('packages:\r\n  - packages/*\r\n', archives), /Expected an overrides section/);
});

test('templates copy the exact pinned Haku design-system bytes into their own vendor directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vibespa-design-system-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = Buffer.from('shared Haku package fixture');
  const digest = createHash('sha256').update(contents).digest('hex');
  const archive = `ui-kit-core-0.1.0-${digest}.tgz`;
  await mkdir(join(root, 'vendor'));
  await writeFile(join(root, 'vendor', archive), contents);
  await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@ui-kit/core': `file:vendor/${archive}` } }));
  const destination = join(root, 'generated', 'vendor');
  assert.deepEqual(await copyDesignSystemPackage({ root, destination }), {
    package: '@ui-kit/core', specifier: `file:./vendor/${archive}`,
  });
  assert.deepEqual(await readFile(join(destination, archive)), contents);
});

test('a tampered design-system pin fails before writing a generated vendor directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vibespa-design-system-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = `ui-kit-core-0.1.0-${'a'.repeat(64)}.tgz`;
  await mkdir(join(root, 'vendor'));
  await writeFile(join(root, 'vendor', archive), 'not the pinned bytes');
  await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@ui-kit/core': `file:vendor/${archive}` } }));
  const destination = join(root, 'generated', 'vendor');
  await assert.rejects(copyDesignSystemPackage({ root, destination }), /does not match its pinned SHA-256/);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});
