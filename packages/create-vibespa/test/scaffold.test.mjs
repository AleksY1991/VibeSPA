import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplication, createModule, resolveTemplateRoot } from '../src/scaffold.mjs';
import { runCli } from '../src/cli.mjs';

const archive = 'vibespa-core-0.1.0-abc123.tgz';

/** A minimal application template, as scripts/prepare-template.mjs composes it. */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vibespa-scaffold-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'template');
  const write = async (path, contents) => {
    const parts = path.split('/');
    await mkdir(join(source, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(source, ...parts), typeof contents === 'string' ? contents : JSON.stringify(contents));
  };
  await write('package.json', { name: 'vibespa-app', dependencies: { '@vibespa/core': `file:./vendor/${archive}`, 'solid-js': '2.0.0-rc.14' } });
  await write('pnpm-workspace.yaml', `overrides:\n  '@vibespa/core': file:./vendor/${archive}\n`);
  await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  for (const name of ['tsconfig.json', 'eslint.config.js', 'vitest.config.ts', 'vite.config.ts', 'index.html']) await write(name, '\n');
  await write('src/main.ts', 'export {};\n');
  await write('test-support/solid-diagnostics.ts', 'export const diagnosticsSetup = true;\n');
  await write(`vendor/${archive}`, 'archive bytes');
  await write('_gitignore', 'node_modules/\ndist/\n');
  await write('.npmignore', '**/node_modules/\n');
  await write('node_modules/ignored/secret', 'Do not copy.');
  return { directory, source, write };
}

test('application copies the template with its pinned archives and its own name', async (t) => {
  const { directory, source } = await fixture(t);
  const destination = join(directory, 'example');
  await createApplication({ templateRoot: source, destination, name: 'quiet-space' });
  const manifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'quiet-space');
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies['@vibespa/core'], `file:./vendor/${archive}`);
  assert.equal(await readFile(join(destination, 'vendor', archive), 'utf8'), 'archive bytes');
  assert.equal(await readFile(join(destination, 'test-support', 'solid-diagnostics.ts'), 'utf8'), 'export const diagnosticsSetup = true;\n');
  assert.equal(await readFile(join(destination, '.gitignore'), 'utf8'), 'node_modules/\ndist/\n');
  assert.deepEqual((await readdir(destination)).sort(), ['.gitignore', 'eslint.config.js', 'index.html', 'package.json',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'src', 'test-support', 'tsconfig.json', 'vendor', 'vite.config.ts', 'vitest.config.ts']);
});

test('a template without the diagnostics setup is refused before creating an application', async (t) => {
  const { directory, source } = await fixture(t);
  await rm(join(source, 'test-support'), { recursive: true });
  const destination = join(directory, 'incomplete');
  await assert.rejects(createApplication({ templateRoot: source, destination, name: 'incomplete' }), /missing test-support/);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('a template must contain every archive it references and no workspace links', async (t) => {
  const { directory, source, write } = await fixture(t);
  const destination = join(directory, 'example');
  await rm(join(source, 'vendor', archive));
  await assert.rejects(createApplication({ templateRoot: source, destination, name: 'example' }), /archive is missing/);
  await write(`vendor/${archive}`, 'archive bytes');
  await write('pnpm-workspace.yaml', "overrides:\n  '@vibespa/core': file:../VibeSPA/packages/core\n");
  await assert.rejects(createApplication({ templateRoot: source, destination, name: 'example' }), /archive is missing/);
  await write('pnpm-workspace.yaml', '\n');
  await write('package.json', { name: 'vibespa-app', dependencies: { '@vibespa/core': 'workspace:*' } });
  await assert.rejects(createApplication({ templateRoot: source, destination, name: 'example' }), /not portable/);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('the CLI uses only its embedded template and explains a missing one', async (t) => {
  const { directory, source } = await fixture(t);
  const installed = join(directory, 'node_modules', 'create-vibespa');
  await cp(source, join(installed, 'template'), { recursive: true });
  assert.equal(await resolveTemplateRoot(installed), join(installed, 'template'));
  await assert.rejects(resolveTemplateRoot(join(directory, 'empty-cli')), /run pnpm build first/);
});

test('application refuses existing contents and preserves them', async (t) => {
  const { directory, source } = await fixture(t);
  const destination = join(directory, 'existing');
  await mkdir(destination);
  await writeFile(join(destination, 'keep.txt'), 'Keep me.');
  await assert.rejects(createApplication({ templateRoot: source, destination, name: 'example' }), /empty directory/);
  assert.deepEqual(await readdir(destination), ['keep.txt']);
  assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'Keep me.');
});

test('invalid application names cannot create a destination', async (t) => {
  const { directory, source } = await fixture(t);
  const destination = join(directory, 'example');
  for (const name of ['UpperCase', '../escape', 'with space', '-dash', 'trailing-', '']) {
    await assert.rejects(createApplication({ templateRoot: source, destination, name }), /App name/);
  }
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('application refuses a linked destination or any linked ancestor', async (t) => {
  const { directory, source } = await fixture(t);
  const outside = join(directory, 'outside');
  const linked = join(directory, 'linked');
  await mkdir(outside);
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  for (const destination of [linked, join(linked, 'nested', 'app')]) {
    await assert.rejects(createApplication({ templateRoot: source, destination, name: 'example' }), /Symbolic links/);
  }
  assert.deepEqual(await readdir(outside), []);
});

test('template symlinks are rejected before the destination is created', async (t) => {
  const { directory, source } = await fixture(t);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'private.txt'), 'Private.');
  await symlink(outside, join(source, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const destination = join(directory, 'example');
  await assert.rejects(createApplication({ templateRoot: source, destination, name: 'example' }), /symbolic link/);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('module scaffold has an enumerable kind, documented typed contract, and lazy owned accessor runtime', async (t) => {
  const { directory } = await fixture(t);
  const application = join(directory, 'application');
  await mkdir(join(application, 'src'), { recursive: true });
  await writeFile(join(application, 'package.json'), '{}');
  const module = await createModule({ application, name: 'daily-intention' });
  const contract = await readFile(join(module, 'contract.ts'), 'utf8');
  assert.match(contract, /import type \{ Accessor \} from 'solid-js'/);
  assert.match(contract, /readonly message: Accessor<string>/);
  assert.ok(!contract.includes('Readable'));
  const definition = await readFile(join(module, 'definition.ts'), 'utf8');
  assert.match(definition, /import \{ FeatureType \} from '@vibespa\/contracts'/);
  assert.match(definition, /defineFeatureModule<FeatureType.Feature, DailyIntentionInputs, DailyIntentionExports>/);
  assert.match(definition, /kind: FeatureType.Feature/);
  assert.match(definition, /title: 'Daily Intention'/);
  assert.match(definition, /description: 'Provides the daily-intention message capability\.'/);
  assert.match(definition, /inputs: \{ message: 'The initial message supplied by the owning composition\.' \}/);
  assert.match(definition, /exports: \{ message: 'A tracked accessor for the current message\.' \}/);
  assert.match(definition, /load: \(\) => import\('\.\/internal\/runtime\.js'\)/);
  const runtime = await readFile(join(module, 'internal', 'runtime.ts'), 'utf8');
  assert.match(runtime, /import type \{ ModuleContext \} from '@vibespa\/core\/module'/);
  assert.match(runtime, /createDailyIntention\(inputs: DailyIntentionInputs, _scope: ModuleContext\): DailyIntentionExports/);
  for (const operation of ['run', 'task', 'commands', 'acquire', 'defer']) assert.ok(runtime.includes(`_scope.${operation}`));
  assert.match(runtime, /const \[message\] = createSignal\(inputs\.message\);/);
  assert.match(runtime, /return \{ message \};/);
  assert.match(runtime, /moduleAccessor\(_scope, readable\)/);
  // The setter stays private to the runtime; only the accessor is exported.
  assert.ok(!/set[A-Z]\w*\(/.test(runtime));
  await assert.rejects(createModule({ application, name: 'daily-intention' }), /already exists/);
  for (const name of ['../escape', 'foo/bar', 'with space', '0name', 'foo-0bar', 'UpperCase', 'foo--bar', 'trailing-', '']) {
    await assert.rejects(createModule({ application, name }), /Module name/);
  }
});

test('module command explains from() and external() with valid start examples', async (t) => {
  const { directory } = await fixture(t);
  const application = join(directory, 'application');
  await mkdir(join(application, 'src'), { recursive: true });
  await writeFile(join(application, 'package.json'), '{}');
  const lines = [];
  await runCli(['module', 'reminders', '--cwd', application], (line) => { lines.push(line); });
  const hint = lines.join('\n');
  assert.match(hint, /system\.start\(definition, inputs\)/);
  assert.match(hint, /from\(handle, 'key'\) or from\(handle\): a capability exported by a module/);
  assert.match(hint, /external\(value\): configuration or any value no module provides/);
  assert.match(hint, /system\.start\(remindersModule, \{ repository: from\(storage, 'repository'\), limit: external\(20\) \}\)/);
  assert.ok(!hint.includes(' | '), 'The hint must not show a union of expressions as code.');
});

test('module creation cannot traverse a linked modules directory', async (t) => {
  const { directory } = await fixture(t);
  const application = join(directory, 'application');
  const outside = join(directory, 'outside');
  await mkdir(join(application, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(application, 'package.json'), '{}');
  await symlink(outside, join(application, 'src', 'modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createModule({ application, name: 'escape' }), /Symbolic links/);
  assert.deepEqual(await readdir(outside), []);
});
