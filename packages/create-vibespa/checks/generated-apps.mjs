// Acceptance check for generated applications (run by `pnpm build` after the
// template is prepared). Creates one application with the checkout CLI and one
// with a packed CLI outside the checkout, installs each from its own vendor
// archives, and runs lint, typecheck, tests and a production build. Needs the
// package registry (or a warm pnpm store) for third-party dependencies.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPnpm } from '../../../scripts/export-adapters.mjs';
import { assertNoSymlink } from '../src/scaffold.mjs';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkout = resolve(cliRoot, '../..');
const temporary = await mkdtemp(join(tmpdir(), 'vibespa-apps-'));

function within(directory, path) {
  const location = relative(directory, path);
  return location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location);
}

function node(args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (!allowFailure) assert.equal(result.status, 0, `node ${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result;
}

async function listFiles(root, path = '') {
  const entries = await readdir(join(root, path), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const child = path ? `${path}/${entry.name}` : entry.name;
    files.push(...(entry.isDirectory() ? await listFiles(root, child) : [child]));
  }
  return files;
}

/** Application code, its configuration and pinned archives; no framework sources, tests or build scripts. */
async function checkContents(app, label) {
  const files = await listFiles(app);
  const configuration = new Set(['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'eslint.config.js', 'index.html',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts',
    'test-support/solid-diagnostics.ts']);
  for (const file of files) {
    assert.ok(configuration.has(file) || file.startsWith('src/') || /^vendor\/(?:vibespa-|ui-kit-core-)[\w.-]+\.tgz$/.test(file),
      `${label}: unexpected file ${file}`);
    if (!file.endsWith('.tgz')) {
      const text = await readFile(join(app, file), 'utf8');
      assert.ok(!text.includes(checkout) && !text.includes(checkout.replaceAll('\\', '/')), `${label}: ${file} names the checkout`);
      assert.ok(!/workspace:[*^~\d]|link:\.|\.\.\/\.\.\/packages\//.test(text), `${label}: ${file} has a workspace reference`);
    }
  }
  for (const name of ['contracts', 'core', 'solid', 'local-first', 'interaction', 'eslint-plugin']) {
    assert.equal(files.filter(file => file.startsWith(`vendor/vibespa-${name}-0`)).length, 1, `${label}: one ${name} archive`);
  }
  const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
  assert.match(manifest.dependencies['@ui-kit/core'], /^file:\.\/vendor\/ui-kit-core-[\w.-]+\.tgz$/, `${label}: pinned Haku design system`);
  assert.equal(files.filter(file => /^vendor\/ui-kit-core-[\w.-]+\.tgz$/.test(file)).length, 1, `${label}: one design-system archive`);
  for (const [name, specifier] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (name.startsWith('@vibespa/')) assert.match(specifier, /^file:\.\/vendor\/vibespa-[\w.-]+\.tgz$/, `${label}: ${name}`);
  }
  assert.match(await readFile(join(app, 'eslint.config.js'), 'utf8'), /from '@vibespa\/eslint-plugin'/);
  assert.match(await readFile(join(app, 'vitest.config.ts'), 'utf8'), /setupFiles: \['\.\/test-support\/solid-diagnostics\.ts'\]/);
}

/** One installed instance of each framework package and of Solid; exports resolve to shipped files. */
async function checkInstall(app, label) {
  const store = await readdir(join(app, 'node_modules', '.pnpm'));
  for (const prefix of ['@vibespa+contracts@', '@vibespa+core@', '@vibespa+solid@', '@vibespa+local-first@', '@vibespa+interaction@',
    '@vibespa+eslint-plugin@', '@ui-kit+core@', 'solid-js@', '@solidjs+signals@']) {
    assert.equal(store.filter(entry => entry.startsWith(prefix)).length, 1, `${label}: ${prefix} installed once`);
  }
  for (const name of ['contracts', 'core', 'solid', 'local-first', 'interaction', 'eslint-plugin']) {
    const directory = join(app, 'node_modules', '@vibespa', name);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const targets = [];
    const visit = (value, conditions = []) => {
      if (typeof value === 'string') targets.push([conditions, value]);
      else for (const [key, child] of Object.entries(value)) visit(child, [...conditions, key]);
    };
    visit(manifest.exports);
    for (const [conditions, target] of targets) {
      assert.ok(!conditions.includes('development'), `${label}: @vibespa/${name} keeps a development condition`);
      await readFile(join(directory, target));
    }
    assert.ok(!(await readdir(directory)).some(entry => ['test', 'tests'].includes(entry)), `${label}: @vibespa/${name} ships tests`);
  }
}

const smokeTest = `import { createMemo, createSignal, flush, type Accessor } from 'solid-js';
import { createSource, defineFeatureModule, external, FeatureType, from } from '@vibespa/core';
import { dataPort, defineDataContract } from '@vibespa/core/data';
import type { Readable } from '@vibespa/contracts';
import { createSolidSystem, moduleAccessor } from '@vibespa/solid/module';
import { describe, expect, it, vi } from 'vitest';
import { smokeGreetingModule } from './definition.js';

const prefixContract = defineDataContract<Accessor<string>>({ id: 'smoke-prefix', version: 1 });
function makePrefixProvider(capabilities: readonly string[], loaded: () => void = () => {}) {
  return defineFeatureModule<FeatureType.Data, Record<string, never>, { prefix: Accessor<string> }>({
    id: 'smoke-prefix', kind: FeatureType.Data, title: 'Prefix', description: 'Provides a private reactive prefix.',
    contract: { inputs: {}, exports: { prefix: 'The readonly prefix accessor.' } },
    data: { provides: { prefix: dataPort(prefixContract, capabilities) } },
    load: async () => {
      loaded();
      return () => { const [prefix] = createSignal(() => ''); return { prefix }; };
    },
  });
}

interface BannerInputs { readonly message: Accessor<string>; readonly suffix: Readable<string>; readonly prefix: Accessor<string> }
interface Banner { readonly text: Accessor<string>; readonly commands: { shout(): Promise<string> } }

const banner = defineFeatureModule<FeatureType.Feature, BannerInputs, Banner>({
  id: 'banner', kind: FeatureType.Feature, title: 'Banner', description: 'Derives a banner from the greeting.',
  contract: { inputs: { message: 'The greeting accessor.', suffix: 'A neutral suffix read.', prefix: 'The declared prefix data.' }, exports: { text: 'The banner.', commands: 'Banner commands.' } },
  data: { requires: { prefix: dataPort(prefixContract, ['read', 'live']) } },
  load: async () => (inputs, scope) => {
    const suffix = moduleAccessor(scope, inputs.suffix);
    const text = createMemo(() => inputs.prefix() + inputs.message() + suffix());
    return { text, commands: scope.commands({ async shout() { return text().toUpperCase(); } }) };
  },
});

describe('generated module', () => {
  it('refuses missing or insufficient Data providers before their loaders run', () => {
    const loaded = vi.fn();
    expect(() => createSolidSystem({ id: 'missing-data', modules: [banner] })).toThrow(/Missing provider.*smoke-prefix/);
    expect(() => createSolidSystem({ id: 'weak-data', modules: [makePrefixProvider(['read'], loaded), banner] }))
      .toThrow(/lacks live/);
    expect(loaded).not.toHaveBeenCalled();
  });

  it('wires through from(), Solid accessors and registered commands', async () => {
    const prefixModule = makePrefixProvider(['read', 'live']);
    const system = createSolidSystem({ id: 'smoke', modules: [prefixModule, banner] });
    try {
      const suffix = createSource('!');
      const prefix = await system.start(prefixModule, {});
      const greeting = await system.start(smokeGreetingModule, { message: external('Hello') });
      const shown = await system.start(banner, { message: from(greeting, 'message'), suffix: external(suffix.source), prefix: from(prefix, 'prefix') });
      expect(shown.exports.text()).toBe('Hello!');
      suffix.set('?');
      await Promise.resolve();
      flush();
      expect(shown.exports.text()).toBe('Hello?');
      expect(await shown.exports.commands.shout()).toBe('HELLO?');
      const snapshot = system.snapshot.read();
      expect(snapshot.modules.find(module => module.id === 'banner')?.dependencies).toEqual(['smoke-greeting', 'smoke-prefix']);
      expect(snapshot.data).toEqual([{
        id: 'smoke-prefix', version: 1,
        provider: { definitionId: 'smoke-prefix', port: 'prefix', capabilities: ['read', 'live'] },
        consumers: [{ definitionId: 'banner', port: 'prefix', capabilities: ['read', 'live'] }], relations: [],
      }]);
      expect(snapshot.events.filter(event => event.operation === 'shout').map(event => event.type))
        .toEqual(['operation-started', 'operation-completed']);
    } finally {
      await system.dispose();
    }
  });
});
`;

const leakTest = `import { createEffect } from 'solid-js';
import { it } from 'vitest';

it('creates an effect without an owner', async () => {
  await Promise.resolve();
  createEffect(() => 1, () => {});
});
`;

async function checkApplication(app, cli, label) {
  await checkContents(app, label);
  runPnpm(['install', '--prefer-offline'], app);
  await checkInstall(app, label);

  // A generated module compiles, lints and runs against the installed packages.
  node([cli, 'module', 'smoke-greeting', '--cwd', app], app);
  await writeFile(join(app, 'src', 'modules', 'smoke-greeting', 'smoke.test.ts'), smokeTest);
  for (const script of ['lint', 'typecheck', 'test', 'build']) runPnpm(['run', script], app);

  // The architecture and ownership lint rules are active through the packaged plugin.
  const probe = join(app, 'src', 'modules', 'smoke-greeting', 'internal', 'probe.ts');
  await writeFile(probe, "import { createEffect } from 'solid-js';\nimport '../../focus/internal/runtime.js';\nexport const effect = createEffect;\n");
  const lint = runPnpm(['exec', 'eslint', 'src/modules/smoke-greeting/internal/probe.ts'], app, { allowFailure: true });
  assert.notEqual(lint.status, 0, `${label}: lint accepted a raw effect and a private import`);
  assert.match(lint.stdout, /no-restricted-imports/);
  assert.match(lint.stdout, /vibespa\/no-private-imports/);
  await rm(probe);

  // The diagnostics setup is active: an unowned effect fails its test.
  const leak = join(app, 'src', 'leak.test.ts');
  await writeFile(leak, leakTest);
  const run = runPnpm(['exec', 'vitest', 'run', 'src/leak.test.ts'], app, { allowFailure: true });
  assert.notEqual(run.status, 0, `${label}: an unowned effect passed`);
  assert.match(run.stdout + run.stderr, /NO_OWNER_EFFECT/);
  await rm(leak);
  console.log(`${label}: generated, installed from vendor archives, lint/typecheck/test/build passed; module, lint policy and diagnostics verified.`);
}

try {
  // Checkout CLI (uses the template prepared by scripts/prepare-template.mjs).
  const checkoutCli = join(cliRoot, 'bin', 'create-vibespa.mjs');
  const fromCheckout = join(temporary, 'checkout-app');
  node([checkoutCli, fromCheckout, '--name', 'checkout-app'], temporary);
  await checkApplication(fromCheckout, checkoutCli, 'checkout CLI');

  // Packed CLI, extracted and run outside the checkout.
  const packing = join(temporary, 'cli-source');
  for (const entry of ['bin', 'src', 'template', 'LICENSE', 'package.json']) await cp(join(cliRoot, entry), join(packing, entry), { recursive: true });
  const manifest = JSON.parse(await readFile(join(packing, 'package.json'), 'utf8'));
  delete manifest.scripts; // the template is already prepared
  await writeFile(join(packing, 'package.json'), JSON.stringify(manifest));
  runPnpm(['pack', '--pack-destination', 'packed'], packing);
  const [archive] = await readdir(join(packing, 'packed'));
  const installed = join(temporary, 'installed-cli');
  await mkdir(installed);
  const extracted = spawnSync('tar', ['-xzf', join(packing, 'packed', archive), '-C', installed], { encoding: 'utf8', windowsHide: true });
  assert.equal(extracted.status, 0, extracted.stderr);
  const packedCli = join(installed, 'package', 'bin', 'create-vibespa.mjs');
  const outside = join(temporary, 'outside');
  await mkdir(outside);
  node([packedCli, 'packed-app'], outside);
  const fromPackage = join(outside, 'packed-app');
  assert.ok(!within(checkout, fromPackage));
  await checkApplication(fromPackage, packedCli, 'packed CLI');

  // Destination protection: existing contents are refused and preserved.
  const occupied = join(temporary, 'occupied');
  await mkdir(occupied);
  await writeFile(join(occupied, 'keep.txt'), 'Keep me.');
  const refused = node([packedCli, occupied], outside, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.deepEqual(await readdir(occupied), ['keep.txt']);
} finally {
  // This is the unique scratch directory returned by mkdtemp, never a checkout.
  assert.ok(within(tmpdir(), temporary) && temporary !== resolve(tmpdir()));
  await assertNoSymlink(temporary);
  await rm(temporary, { recursive: true, force: true });
}
