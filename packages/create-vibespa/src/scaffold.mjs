import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const rootFiles = [
  'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json',
  'tsconfig.json', 'vitest.config.ts', 'eslint.config.js', '.gitignore',
  'CLAUDE.md', 'AGENTS.md', 'LICENSE',
];
const frameworkPackages = ['contracts', 'core', 'solid', 'local-first', 'supabase', 'settings', 'interaction', 'eslint-plugin'];
const excluded = new Set(['node_modules', '.git', '.cache', '.vite', 'coverage', '.turbo']);

async function statIfPresent(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Reject links in every existing path component, including Windows junctions. */
export async function assertNoSymlink(path) {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    const status = await statIfPresent(current);
    if (status?.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`);
    if (current !== absolute && status && !status.isDirectory()) {
      throw new Error(`A parent path is not a directory: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function assertEmptyDestination(destination) {
  await assertNoSymlink(destination);
  const status = await statIfPresent(destination);
  if (status && (!status.isDirectory() || (await readdir(destination)).length > 0)) {
    throw new Error(`Destination must be an empty directory: ${destination}`);
  }
}

function childPath(root, path) {
  const result = resolve(root, path);
  const location = relative(root, result);
  if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
    throw new Error(`Path leaves its destination: ${path}`);
  }
  return result;
}

async function collectDirectory(root, path, files, { omitDist = false } = {}) {
  const source = childPath(root, path);
  const status = await statIfPresent(source);
  if (!status) return;
  if (status.isSymbolicLink()) throw new Error(`Template contains a symbolic link: ${source}`);
  if (status.isFile()) {
    files.push(path);
    return;
  }
  if (!status.isDirectory()) throw new Error(`Template contains an unsupported file: ${source}`);
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (excluded.has(entry.name) || (omitDist && entry.name === 'dist')) continue;
    await collectDirectory(root, join(path, entry.name), files, { omitDist });
  }
}

/** Source snapshots contain the framework and its example, without CLI recursion. */
export async function collectTemplateFiles(templateRoot) {
  const root = resolve(templateRoot);
  await assertNoSymlink(root);
  const files = [];
  for (const name of rootFiles) await collectDirectory(root, name, files);
  // Package managers omit .gitignore from tarballs. Prepared seeds retain it
  // under a plain asset name and restore it when creating an application.
  if (!files.includes('.gitignore')) await collectDirectory(root, '_gitignore', files);
  for (const name of frameworkPackages) await collectDirectory(root, join('packages', name), files);
  await collectDirectory(root, join('apps', 'playground'), files, { omitDist: true });
  await collectDirectory(root, 'scripts', files, { omitDist: true });
  const result = files.filter((path) => basename(path) !== 'prepare-template.mjs');
  for (const required of ['package.json', 'pnpm-workspace.yaml', join('packages', 'core', 'package.json'), join('apps', 'playground', 'package.json')]) {
    if (!result.includes(required)) throw new Error(`Incomplete VibeSPA template: missing ${required}`);
  }
  const manifestPaths = result.filter((path) => path === 'package.json'
    || /^(?:packages[/\\][^/\\]+|apps[/\\]playground)[/\\]package\.json$/.test(path));
  const manifests = await Promise.all(manifestPaths.map(async (path) => JSON.parse(await readFile(childPath(root, path), 'utf8'))));
  const names = new Set(manifests.map((manifest) => manifest.name));
  for (const manifest of manifests) {
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version === 'string' && version.startsWith('workspace:') && !names.has(name)) {
        throw new Error(`Incomplete VibeSPA template: ${manifest.name} needs missing workspace package ${name}.`);
      }
    }
  }
  return result;
}

function standaloneManifest(contents, name) {
  const manifest = JSON.parse(contents);
  manifest.name = name;
  manifest.private = true;
  if (manifest.scripts) {
    for (const [key, value] of Object.entries(manifest.scripts)) {
      if (typeof value !== 'string') continue;
      if (!value.includes('create-vibespa') && !value.includes('prepare-template')) continue;
      const script = value.split(/\s*&&\s*/)
        .filter((part) => !part.includes('create-vibespa') && !part.includes('prepare-template'))
        .join(' && ');
      if (script.trim() === '') delete manifest.scripts[key];
      else manifest.scripts[key] = script;
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Each file is created exclusively, so an unexpected file is never replaced. */
export async function copyTemplate({ templateRoot, destination, name }) {
  const source = resolve(templateRoot);
  const target = resolve(destination);
  const sourceWithinTarget = relative(target, source);
  if (sourceWithinTarget === '' || (!isAbsolute(sourceWithinTarget) && sourceWithinTarget.split(sep)[0] !== '..')) {
    throw new Error('The destination cannot contain the template source.');
  }
  const files = await collectTemplateFiles(source);
  await assertEmptyDestination(target);
  await mkdir(target, { recursive: true });
  for (const path of files) {
    const from = childPath(source, path);
    const to = childPath(target, path === '_gitignore' ? '.gitignore' : path);
    await assertNoSymlink(from);
    await assertNoSymlink(to);
    await mkdir(dirname(to), { recursive: true });
    await assertNoSymlink(dirname(to));
    if (path === 'package.json') {
      const contents = standaloneManifest(await readFile(from, 'utf8'), name);
      await writeFile(to, contents, { flag: 'wx' });
    } else {
      await copyFile(from, to, constants.COPYFILE_EXCL);
    }
  }
  return target;
}

export async function createApplication({ destination, name, templateRoot }) {
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name) || name.length > 214) {
    throw new Error('App name must use lowercase letters, numbers, dots, underscores, or dashes.');
  }
  return copyTemplate({ templateRoot, destination, name });
}

export async function resolveTemplateRoot(cliPackageRoot = packageRoot) {
  const cliRoot = resolve(cliPackageRoot);
  const workspace = resolve(cliRoot, '..', '..');
  const expectedSourcePackage = join(workspace, 'packages', 'create-vibespa');
  if (cliRoot === expectedSourcePackage) {
    try {
      const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
      const cli = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));
      const core = JSON.parse(await readFile(join(workspace, 'packages', 'core', 'package.json'), 'utf8'));
      if (manifest.name === 'vibespa' && cli.name === 'create-vibespa' && core.name === '@vibespa/core') {
        await collectTemplateFiles(workspace);
        return realpath(workspace);
      }
    } catch {
      // A partial or unrelated checkout must never replace the packaged seed.
    }
  }
  const embedded = join(cliRoot, 'template');
  if ((await statIfPresent(join(embedded, 'package.json')))?.isFile()) {
    await collectTemplateFiles(embedded);
    return embedded;
  }
  throw new Error('This create-vibespa package has no template. Build and pack it from the VibeSPA workspace first.');
}

function moduleFiles(name) {
  const pascal = name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  const camel = pascal[0].toLowerCase() + pascal.slice(1);
  const title = name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
  return {
    'contract.ts': `import type { Readable } from '@vibespa/contracts';\n\nexport interface ${pascal}Inputs {\n  readonly message: string;\n}\n\nexport interface ${pascal}Exports {\n  readonly message: Readable<string>;\n}\n`,
    'definition.ts': `import { FeatureType } from '@vibespa/contracts';\nimport { defineFeatureModule } from '@vibespa/core';\nimport type { ${pascal}Exports, ${pascal}Inputs } from './contract.js';\n\nexport const ${camel}Module = defineFeatureModule<FeatureType.Feature, ${pascal}Inputs, ${pascal}Exports>({\n  id: '${name}',\n  kind: FeatureType.Feature,\n  title: '${title}',\n  description: 'Provides the ${name} message capability.',\n  contract: {\n    inputs: { message: 'The initial message supplied by the owning composition.' },\n    exports: { message: 'Read the current message and subscribe to subsequent changes.' },\n  },\n  load: () => import('./internal/runtime.js').then((module) => module.create${pascal}),\n});\n`,
    'internal/runtime.ts': `import { constantReadable } from '@vibespa/core';\nimport type { ${pascal}Exports, ${pascal}Inputs } from '../contract.js';\n\nexport function create${pascal}(inputs: ${pascal}Inputs): ${pascal}Exports {\n  return { message: constantReadable(inputs.message) };\n}\n`,
  };
}

export async function createModule({ application, name }) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/.test(name) || name.length > 80) {
    throw new Error('Module name must be lowercase words separated by dashes, starting with a letter.');
  }
  const root = resolve(application);
  await assertNoSymlink(root);
  const source = join(root, 'src');
  if (!(await statIfPresent(join(root, 'package.json')))?.isFile()
    || !(await statIfPresent(source))?.isDirectory()) {
    throw new Error(`Select an application directory containing package.json and src: ${root}`);
  }
  await assertNoSymlink(source);
  const destination = childPath(root, join('src', 'modules', name));
  await assertNoSymlink(destination);
  if (await statIfPresent(destination)) throw new Error(`Module already exists: ${destination}`);
  await mkdir(destination, { recursive: true });
  for (const [path, contents] of Object.entries(moduleFiles(name))) {
    const target = childPath(destination, path);
    await assertNoSymlink(target);
    await mkdir(dirname(target), { recursive: true });
    await assertNoSymlink(dirname(target));
    await writeFile(target, contents, { flag: 'wx' });
  }
  return destination;
}
