// Compose the create-vibespa application template: the playground's application
// code, application configuration, and one pinned archive per framework package.
// Run after `pnpm build:packages`.
import { cp, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationPackageNames, exportApplicationPackages, runPnpm } from './export-adapters.mjs';
import { assertNoSymlink, collectTemplateFiles } from '../packages/create-vibespa/src/scaffold.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(root, 'packages', 'create-vibespa');
const playground = join(root, 'apps', 'playground');
const destination = join(packageRoot, 'template');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

/** Copy the exact Haku design-system pin, rather than depending on a sibling checkout. */
export async function copyDesignSystemPackage({ root: checkout, destination: output }) {
  const manifest = await readJson(join(checkout, 'package.json'));
  const reference = manifest.devDependencies?.['@ui-kit/core'];
  const match = reference?.match(/^file:vendor\/(ui-kit-core-[\w.-]+-([a-f0-9]{64})\.tgz)$/);
  if (!match) throw new Error('The Haku design system must be pinned to a SHA-256-named vendor archive.');
  const [name, expectedHash] = match.slice(1);
  const source = join(checkout, 'vendor', name);
  await assertNoSymlink(source);
  const contents = await readFile(source);
  if (createHash('sha256').update(contents).digest('hex') !== expectedHash) {
    throw new Error('The Haku design-system archive does not match its pinned SHA-256.');
  }
  await mkdir(output, { recursive: true });
  await assertNoSymlink(output);
  await copyFile(source, join(output, name));
  return { package: '@ui-kit/core', specifier: `file:./vendor/${name}` };
}

/** Exact versions the application installs, taken from the checkout's manifests. */
async function applicationManifest(archives) {
  const workspace = await readJson(join(root, 'package.json'));
  const application = await readJson(join(playground, 'package.json'));
  const versions = { ...workspace.devDependencies, ...application.dependencies, ...application.devDependencies };
  const pick = names => Object.fromEntries(names.map(name => {
    const version = archives.get(name) ?? versions[name];
    if (!version || version.startsWith('workspace:')) throw new Error(`No pinned version for ${name}.`);
    return [name, version];
  }));
  const framework = name => `@vibespa/${name}`;
  return {
    name: 'vibespa-app',
    version: '0.1.0',
    private: true,
    type: 'module',
    packageManager: workspace.packageManager,
    engines: workspace.engines,
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
      lint: 'eslint .',
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      check: 'pnpm lint && pnpm typecheck && pnpm test',
    },
    dependencies: pick([...applicationPackageNames.filter(name => name !== 'eslint-plugin').map(framework),
      '@ui-kit/core', '@solidjs/web', 'solid-js', 'rxdb', 'rxjs', '@supabase/supabase-js']),
    devDependencies: pick([framework('eslint-plugin'), '@babel/preset-typescript', '@eslint/js', '@solidjs/vite-plugin', '@types/node', 'eslint',
      'fake-indexeddb', 'globals', 'happy-dom', 'typescript', 'typescript-eslint', 'vite', 'vitest']),
  };
}

/**
 * The checkout's pnpm settings without its package list, plus one archive per
 * framework package. Line endings are normalized first (a Windows checkout may
 * use CRLF); the result uses LF.
 */
export function applicationWorkspace(text, archives) {
  const settings = text.replace(/\r\n/g, '\n').replace(/^packages:\n(?: {2}- .*\n)+\n?/, '');
  if (!/^overrides:\n/m.test(settings)) throw new Error('Expected an overrides section in pnpm-workspace.yaml.');
  const pinned = [...archives].map(([name, specifier]) => `  '${name}': ${specifier}\n`).join('');
  return settings.replace(/^overrides:\n/m, `overrides:\n  # One instance of each framework package across the dependency graph.\n${pinned}`);
}

async function prepareTemplate() {
  await assertNoSymlink(packageRoot);
  const staged = await mkdtemp(join(packageRoot, '.template-'));
  // Cleanup is limited to these two fixed, verified children of the CLI package.
  for (const path of [destination, staged]) {
    if (!path.startsWith(`${packageRoot}${sep}`)) throw new Error('Template path escaped its package.');
    await assertNoSymlink(path);
  }
  try {
    const exported = await exportApplicationPackages({ root, destination: join(staged, 'vendor') });
    const archives = new Map(exported.map(item => [item.package, `file:./vendor/${basename(item.path)}`]));
    const designSystem = await copyDesignSystemPackage({ root, destination: join(staged, 'vendor') });
    archives.set(designSystem.package, designSystem.specifier);
    await cp(join(playground, 'src'), join(staged, 'src'), { recursive: true });
    for (const name of ['index.html', 'vite.config.ts']) await copyFile(join(playground, name), join(staged, name));
    // The ESLint source is renamed so the checkout's own lint does not treat it as a nested config.
    for (const [from, to = from] of [['tsconfig.json'], ['eslint.config.template.js', 'eslint.config.js'], ['vitest.config.ts'],
      ['CLAUDE.md'], ['_gitignore']]) {
      await copyFile(join(packageRoot, 'app', from), join(staged, to));
    }
    await mkdir(join(staged, 'test-support'));
    await copyFile(join(root, 'test-support', 'solid-diagnostics.ts'), join(staged, 'test-support', 'solid-diagnostics.ts'));
    for (const name of ['AGENTS.md', 'LICENSE']) await copyFile(join(root, name), join(staged, name));
    await writeFile(join(staged, 'package.json'), `${JSON.stringify(await applicationManifest(archives), null, 2)}\n`);
    await writeFile(join(staged, 'pnpm-workspace.yaml'),
      applicationWorkspace(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'), archives));
    // Resolve the full graph once so every generated application installs the same versions.
    runPnpm(['install', '--lockfile-only', '--prefer-offline'], staged);
    // Keep pack from applying ignore rules to the template's own files.
    await writeFile(join(staged, '.npmignore'), '**/node_modules/\n**/.cache/\n**/.vite/\n**/coverage/\n');
    await collectTemplateFiles(staged);
    await assertNoSymlink(destination);
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
    const packageLicense = join(packageRoot, 'LICENSE');
    await assertNoSymlink(packageLicense);
    await copyFile(join(root, 'LICENSE'), packageLicense);
    console.log('Prepared create-vibespa/template.');
  } catch (error) {
    await assertNoSymlink(staged);
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareTemplate();
