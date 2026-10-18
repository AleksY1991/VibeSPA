import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapterNames = ['solid', 'local-first'];

function compiledExports(value) {
  if (typeof value === 'string') return value.startsWith('./dist/') ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(compiledExports);
}

async function readPackage(root, directory) {
  const path = join(root, 'packages', directory);
  const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  return { path, manifest };
}

async function assertCompiled({ path, manifest }) {
  try {
    const entries = await readdir(join(path, 'dist'));
    if (entries.length === 0) throw new Error('Empty dist directory.');
    for (const target of new Set(compiledExports(manifest.exports))) {
      if (!(await stat(resolve(path, target))).isFile()) throw new Error(`Missing compiled export ${target}.`);
    }
  } catch (error) {
    throw new Error(`${manifest.name} needs compiled exports. Run pnpm build:packages before exporting adapters.`, { cause: error });
  }
}

async function stagePackage({ root, packages, source, destination, ancestors = [] }) {
  const { path, manifest } = source;
  if (ancestors.includes(manifest.name)) throw new Error(`Circular workspace dependency: ${[...ancestors, manifest.name].join(' -> ')}`);
  await assertCompiled(source);
  await mkdir(destination, { recursive: true });
  for (const directory of ['src', 'dist']) await cp(join(path, directory), join(destination, directory), { recursive: true, dereference: true });
  let license = join(path, 'LICENSE');
  try { await stat(license); }
  catch (error) { if (error.code !== 'ENOENT') throw error; license = join(root, 'LICENSE'); }
  await copyFile(license, join(destination, 'LICENSE'));

  const staged = structuredClone(manifest);
  // Build hooks and development dependencies belong to the source checkout.
  delete staged.scripts;
  delete staged.devDependencies;
  const bundled = new Set(staged.bundledDependencies ?? staged.bundleDependencies ?? []);
  const stagedDependencies = new Set();
  delete staged.bundleDependencies;
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(staged[kind] ?? {})) {
      if (/^(?:file|link):/.test(version)) throw new Error(`${manifest.name} has a nonportable ${kind} entry: ${name}`);
      if (!version.startsWith('workspace:')) continue;
      const dependency = packages.get(name);
      if (!dependency) throw new Error(`Missing workspace dependency ${name} required by ${manifest.name}.`);
      staged[kind][name] = dependency.manifest.version;
      if (kind === 'peerDependencies' || stagedDependencies.has(name)) continue;
      stagedDependencies.add(name);
      bundled.add(name);
      await stagePackage({
        root, packages, source: dependency,
        destination: join(destination, 'node_modules', ...name.split('/')),
        ancestors: [...ancestors, manifest.name],
      });
    }
  }
  if (bundled.size > 0) staged.bundledDependencies = [...bundled].sort();
  await writeFile(join(destination, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`);
}

function pack(directory) {
  const args = ['--config.node-linker=hoisted', 'pack', '--pack-destination', 'packed'];
  const pnpmScript = process.env.npm_execpath;
  // npm_execpath is set by `pnpm export:adapters`; invoking its JS entry avoids
  // shell quoting entirely. Direct Node usage falls back to the PATH launcher.
  const useScript = pnpmScript && /(?:^|[/\\])pnpm\.(?:c?js|mjs)$/.test(pnpmScript);
  const windowsLauncher = !useScript && process.platform === 'win32';
  const command = useScript ? process.execPath : windowsLauncher ? 'pnpm.cmd --config.node-linker=hoisted pack --pack-destination packed' : 'pnpm';
  const result = spawnSync(command, useScript ? [pnpmScript, ...args] : windowsLauncher ? [] : args, {
    cwd: directory,
    encoding: 'utf8',
    // All shell arguments above are constants. The user's destination is only
    // used by filesystem APIs and is never interpolated into a shell command.
    shell: windowsLauncher,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not pack adapter: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
}

/** Export self-contained, compiled adapter snapshots without publishing. */
export async function exportAdapters({ root = repositoryRoot, destination = join(root, 'artifacts', 'adapters') } = {}) {
  root = resolve(root);
  destination = resolve(destination);
  const directories = (await readdir(join(root, 'packages'), { withFileTypes: true })).filter(entry => entry.isDirectory());
  const sources = await Promise.all(directories.map(async entry => {
    try { return await readPackage(root, entry.name); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }));
  const packages = new Map(sources.filter(Boolean).map(source => [source.manifest.name, source]));
  const adapters = adapterNames.map(name => {
    const source = packages.get(`@vibespa/${name}`);
    if (!source) throw new Error(`Missing adapter @vibespa/${name}.`);
    return source;
  });
  const temporaryRoot = resolve(tmpdir());
  const stage = await mkdtemp(join(temporaryRoot, 'vibespa-adapters-'));
  try {
    // Finish staging every package before writing any requested output.
    for (const source of adapters) {
      await stagePackage({ root, packages, source, destination: join(stage, source.manifest.name.split('/')[1]) });
    }
    const exported = [];
    for (const source of adapters) {
      const directory = join(stage, source.manifest.name.split('/')[1]);
      pack(directory);
      const tarballs = (await readdir(join(directory, 'packed'))).filter(name => name.endsWith('.tgz'));
      if (tarballs.length !== 1) throw new Error(`Expected one packed artifact for ${source.manifest.name}.`);
      const packedPath = join(directory, 'packed', tarballs[0]);
      const sha256 = createHash('sha256').update(await readFile(packedPath)).digest('hex');
      const filename = `${source.manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${source.manifest.version}-${sha256}.tgz`;
      await mkdir(destination, { recursive: true });
      const path = join(destination, filename);
      await copyFile(packedPath, path);
      exported.push({ package: source.manifest.name, version: source.manifest.version, sha256, path });
    }
    return exported;
  } finally {
    // Only remove the exact newly-created child of the operating system temp
    // directory. Never clean the source checkout or previous exported files.
    const child = relative(temporaryRoot, stage);
    if (child.startsWith('vibespa-adapters-') && !child.includes(sep)) await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--destination' || !args[1])) {
      throw new Error('Usage: node scripts/export-adapters.mjs [--destination <directory>]');
    }
    console.log(JSON.stringify(await exportAdapters({ destination: args[1] }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
