import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
// Required in every application template (scripts/prepare-template.mjs composes it).
const requiredFiles = [
  'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.json', 'eslint.config.js',
  'vitest.config.ts', 'vite.config.ts', 'index.html', join('src', 'main.ts'), join('test-support', 'solid-diagnostics.ts'),
];
const excluded = new Set(['node_modules', '.git', '.cache', '.vite', 'coverage', '.turbo', 'dist', '.npmignore']);

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

async function collectDirectory(root, path, files) {
  const source = childPath(root, path);
  const status = await lstat(source);
  if (status.isSymbolicLink()) throw new Error(`Template contains a symbolic link: ${source}`);
  if (status.isFile()) {
    files.push(path);
    return;
  }
  if (!status.isDirectory()) throw new Error(`Template contains an unsupported file: ${source}`);
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!excluded.has(entry.name)) await collectDirectory(root, path ? join(path, entry.name) : entry.name, files);
  }
}

/** An application template: application code, configuration and pinned framework archives. */
export async function collectTemplateFiles(templateRoot) {
  const root = resolve(templateRoot);
  await assertNoSymlink(root);
  const files = [];
  await collectDirectory(root, '', files);
  // Package managers omit .gitignore from tarballs; templates carry it as _gitignore.
  for (const required of [...requiredFiles, '_gitignore']) {
    if (!files.includes(required)) throw new Error(`Incomplete VibeSPA template: missing ${required}`);
  }
  // Every framework dependency is a pinned archive inside the template.
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const workspace = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const references = [
    ...Object.values({ ...manifest.dependencies, ...manifest.devDependencies }),
    ...Array.from(workspace.matchAll(/(?:file|link|workspace):[^\s'"]*/g), match => match[0]),
  ];
  for (const reference of references) {
    if (/^(?:link|workspace):/.test(reference)) throw new Error(`Template dependency is not portable: ${reference}`);
    if (!reference.startsWith('file:')) continue;
    const match = reference.match(/^file:\.\/vendor\/([\w.@-]+\.tgz)$/);
    if (!match || !files.includes(join('vendor', match[1]))) throw new Error(`Template dependency archive is missing: ${reference}`);
  }
  return files;
}

function standaloneManifest(contents, name) {
  const manifest = JSON.parse(contents);
  manifest.name = name;
  manifest.private = true;
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
  const embedded = join(resolve(cliPackageRoot), 'template');
  if ((await statIfPresent(join(embedded, 'package.json')))?.isFile()) {
    await collectTemplateFiles(embedded);
    return embedded;
  }
  throw new Error('This create-vibespa package has no application template. In the VibeSPA checkout, run pnpm build first.');
}

function moduleFiles(name) {
  const pascal = name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  const camel = pascal[0].toLowerCase() + pascal.slice(1);
  const title = name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
  return {
    'contract.ts': `import type { Accessor } from 'solid-js';\n\nexport interface ${pascal}Inputs {\n  readonly message: string;\n}\n\nexport interface ${pascal}Exports {\n  /** A tracked read: call it inside JSX or a Solid computation. */\n  readonly message: Accessor<string>;\n}\n`,
    'definition.ts': `import { FeatureType } from '@vibespa/contracts';\nimport { defineFeatureModule } from '@vibespa/core';\nimport type { ${pascal}Exports, ${pascal}Inputs } from './contract.js';\n\nexport const ${camel}Module = defineFeatureModule<FeatureType.Feature, ${pascal}Inputs, ${pascal}Exports>({\n  id: '${name}',\n  kind: FeatureType.Feature,\n  title: '${title}',\n  description: 'Provides the ${name} message capability.',\n  contract: {\n    inputs: { message: 'The initial message supplied by the owning composition.' },\n    exports: { message: 'A tracked accessor for the current message.' },\n  },\n  load: () => import('./internal/runtime.js').then((module) => module.create${pascal}),\n});\n`,
    'internal/runtime.ts': `import { createSignal } from 'solid-js';\nimport type { ModuleContext } from '@vibespa/core/module';\nimport type { ${pascal}Exports, ${pascal}Inputs } from '../contract.js';\n\nexport function create${pascal}(inputs: ${pascal}Inputs, _scope: ModuleContext): ${pascal}Exports {\n  // This synchronous factory body runs inside the module's Solid owner, so signals\n  // and memos created here are released with the module. Ownership is not ambient\n  // elsewhere: after an await, in timers, promise callbacks or non-Solid\n  // subscriptions, create reactive work inside _scope.run. Expose a neutral\n  // Readable with moduleAccessor(_scope, readable) from '@vibespa/solid/module'.\n  // Declare public commands once with _scope.commands({ ... }) and export the\n  // returned group. Use _scope.task for background work. Own resources with\n  // _scope.acquire or register their cleanup with _scope.defer.\n  const [message] = createSignal(inputs.message);\n  return { message };\n}\n`,
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
