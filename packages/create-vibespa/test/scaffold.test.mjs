import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyTemplate, createApplication, createModule, resolveTemplateRoot } from '../src/scaffold.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vibespa-scaffold-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  const write = async (path, contents) => {
    const parts = path.split('/');
    await mkdir(join(source, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(source, ...parts), typeof contents === 'string' ? contents : JSON.stringify(contents));
  };
  await write('package.json', {
    name: 'vibespa',
    scripts: {
      dev: 'pnpm --filter @vibespa/playground dev',
      build: 'node scripts/build.mjs && node scripts/prepare-template.mjs',
      test: 'vitest run && node --test packages/create-vibespa/test/*.test.mjs',
      'create:app': 'node packages/create-vibespa/bin/create-vibespa.mjs',
      'create:module': 'node packages/create-vibespa/bin/create-vibespa.mjs module',
    },
    devDependencies: { '@vibespa/eslint-plugin': 'workspace:*' },
  });
  await write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'apps/*'\n");
  await write('tsconfig.base.json', {});
  await write('.gitignore', '**/node_modules/\n**/dist/\n');
  await write('LICENSE', 'ISC license fixture.\n');
  for (const name of ['contracts', 'core', 'solid', 'local-first', 'supabase', 'settings', 'interaction', 'eslint-plugin']) {
    await write(`packages/${name}/package.json`, { name: `@vibespa/${name}`, dependencies: name === 'contracts' ? {} : { '@vibespa/contracts': 'workspace:*' } });
    await write(`packages/${name}/src/index.ts`, `export const packageName = '${name}';\n`);
  }
  await write('packages/core/dist/index.js', 'export const built = true;\n');
  await write('packages/core/node_modules/ignored/secret', 'Do not copy.');
  await write('packages/create-vibespa/template/recursive', 'Do not copy.');
  await write('packages/create-vibespa/package.json', { name: 'create-vibespa' });
  await write('apps/playground/package.json', { name: '@vibespa/playground', dependencies: { '@vibespa/core': 'workspace:*' } });
  await write('apps/playground/src/main.ts', 'export {};\n');
  await write('apps/playground/dist/ignored', 'Do not copy.');
  await write('scripts/build.mjs', 'console.log("build");\n');
  await write('scripts/prepare-template.mjs', 'throw new Error("not a standalone helper");\n');
  return { directory, source, write };
}

test('application includes every framework dependency and built package, without source paths or CLI recursion', async (t) => {
  const { directory, source } = await fixture(t);
  const destination = join(directory, 'example');
  await createApplication({ templateRoot: source, destination, name: 'quiet-space' });
  const root = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
  assert.equal(root.name, 'quiet-space');
  assert.equal(root.private, true);
  assert.equal(root.scripts.build, 'node scripts/build.mjs');
  assert.equal(root.scripts.dev, 'pnpm --filter @vibespa/playground dev');
  assert.equal(root.scripts.test, 'vitest run');
  assert.equal(root.scripts['create:app'], undefined);
  assert.equal(root.scripts['create:module'], undefined);
  assert.equal(await readFile(join(destination, 'LICENSE'), 'utf8'), 'ISC license fixture.\n');
  assert.equal(await readFile(join(destination, '.gitignore'), 'utf8'), '**/node_modules/\n**/dist/\n');
  const packages = await readdir(join(destination, 'packages'));
  assert.equal(packages.length, 8);
  const manifests = await Promise.all(packages.map(async (name) => JSON.parse(await readFile(join(destination, 'packages', name, 'package.json'), 'utf8'))));
  const names = new Set(manifests.map((manifest) => manifest.name));
  for (const manifest of [root, ...manifests]) {
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (version.startsWith('workspace:')) assert.ok(names.has(name), `Missing workspace dependency: ${name}`);
    }
    assert.ok(!JSON.stringify(manifest).includes(source));
  }
  assert.equal(await readFile(join(destination, 'packages', 'core', 'dist', 'index.js'), 'utf8'), 'export const built = true;\n');
  await assert.rejects(readFile(join(destination, 'packages', 'core', 'node_modules', 'ignored', 'secret')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(destination, 'packages', 'create-vibespa', 'template', 'recursive')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(destination, 'apps', 'playground', 'dist', 'ignored')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(destination, 'scripts', 'prepare-template.mjs')), { code: 'ENOENT' });
});

test('a packaged template restores its encoded gitignore asset', async (t) => {
  const { directory, source } = await fixture(t);
  await rename(join(source, '.gitignore'), join(source, '_gitignore'));
  const destination = join(directory, 'from-package');
  await createApplication({ templateRoot: source, destination, name: 'from-package' });
  assert.equal(await readFile(join(destination, '.gitignore'), 'utf8'), '**/node_modules/\n**/dist/\n');
  await assert.rejects(readFile(join(destination, '_gitignore')), { code: 'ENOENT' });
});

test('an installed CLI uses its embedded template inside an unrelated monorepo', async (t) => {
  const { directory, source } = await fixture(t);
  const unrelated = join(directory, 'other-monorepo');
  const installed = join(unrelated, 'node_modules', 'create-vibespa');
  const embedded = join(installed, 'template');
  await copyTemplate({ templateRoot: source, destination: embedded, name: 'bundled-seed' });
  await mkdir(join(unrelated, 'packages', 'core'), { recursive: true });
  await writeFile(join(unrelated, 'package.json'), JSON.stringify({ name: 'other-monorepo' }));
  await writeFile(join(unrelated, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await writeFile(join(unrelated, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@unrelated/core' }));
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'create-vibespa' }));
  assert.equal(await resolveTemplateRoot(installed), embedded);
});

test('a valid source CLI uses current sources even when an embedded seed exists', async (t) => {
  const { source } = await fixture(t);
  const local = join(source, 'packages', 'create-vibespa');
  await rm(join(local, 'template'), { recursive: true, force: true });
  await copyTemplate({ templateRoot: source, destination: join(local, 'template'), name: 'bundled-seed' });
  assert.equal(await resolveTemplateRoot(local), source);
  await writeFile(join(source, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@unrelated/core' }));
  assert.equal(await resolveTemplateRoot(local), join(local, 'template'));
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

test('an unresolved workspace dependency fails before creating an incomplete app', async (t) => {
  const { directory, source, write } = await fixture(t);
  await write('packages/core/package.json', { name: '@vibespa/core', dependencies: { '@vibespa/missing': 'workspace:*' } });
  const destination = join(directory, 'example');
  await assert.rejects(createApplication({ templateRoot: source, destination, name: 'example' }), /missing workspace package @vibespa\/missing/);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
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
  await symlink(outside, join(source, 'packages', 'core', 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const destination = join(directory, 'example');
  await assert.rejects(createApplication({ templateRoot: source, destination, name: 'example' }), /symbolic link/);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('module scaffold has an enumerable kind, documented typed contract, and lazy read-only runtime', async (t) => {
  const { directory } = await fixture(t);
  const application = join(directory, 'application');
  await mkdir(join(application, 'src'), { recursive: true });
  await writeFile(join(application, 'package.json'), '{}');
  const module = await createModule({ application, name: 'daily-intention' });
  assert.match(await readFile(join(module, 'contract.ts'), 'utf8'), /readonly message: Readable<string>/);
  const definition = await readFile(join(module, 'definition.ts'), 'utf8');
  assert.match(definition, /import \{ FeatureType \} from '@vibespa\/contracts'/);
  assert.match(definition, /defineFeatureModule<FeatureType.Feature, DailyIntentionInputs, DailyIntentionExports>/);
  assert.match(definition, /kind: FeatureType.Feature/);
  assert.match(definition, /title: 'Daily Intention'/);
  assert.match(definition, /description: 'Provides the daily-intention message capability\.'/);
  assert.match(definition, /inputs: \{ message: 'The initial message supplied by the owning composition\.' \}/);
  assert.match(definition, /exports: \{ message: 'Read the current message and subscribe to subsequent changes\.' \}/);
  assert.match(definition, /load: \(\) => import\('\.\/internal\/runtime\.js'\)/);
  const runtime = await readFile(join(module, 'internal', 'runtime.ts'), 'utf8');
  assert.match(runtime, /constantReadable\(inputs\.message\)/);
  assert.ok(!runtime.includes('set('));
  await assert.rejects(createModule({ application, name: 'daily-intention' }), /already exists/);
  for (const name of ['../escape', 'foo/bar', 'with space', '0name', 'foo-0bar', 'UpperCase', 'foo--bar', 'trailing-', '']) {
    await assert.rejects(createModule({ application, name }), /Module name/);
  }
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
