import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationWorkspace } from '../../../scripts/prepare-template.mjs';

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
