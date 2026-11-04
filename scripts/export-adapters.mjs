import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapterNames = ['solid', 'local-first'];
/** Packages a generated application installs directly, one archive each. */
export const applicationPackageNames = ['contracts', 'core', 'solid', 'local-first', 'interaction', 'eslint-plugin'];

function compiledExports(value) {
  if (typeof value === 'string') return value.startsWith('./dist/') ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(compiledExports);
}

function exportTargets(value) {
  if (typeof value === 'string') return value.startsWith('./') ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportTargets);
}

/** Drop workspace-only `development` conditions so consumers resolve shipped files. */
function withoutDevelopment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([condition]) => condition !== 'development')
    .map(([condition, target]) => [condition, withoutDevelopment(target)]));
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

/** `bundle: true` (adapter snapshots) nests workspace dependencies in the archive.
 * `bundle: false` (application packages) ships only the files the public exports
 * resolve to and leaves workspace dependencies as plain versions, so an
 * application installs one archive per package and one instance of each.
 */
async function stagePackage({ root, packages, source, destination, ancestors = [], bundle = true }) {
  const { path, manifest } = source;
  if (ancestors.includes(manifest.name)) throw new Error(`Circular workspace dependency: ${[...ancestors, manifest.name].join(' -> ')}`);
  const exportsForConsumers = bundle ? manifest.exports : withoutDevelopment(manifest.exports);
  const shipped = bundle ? ['src', 'dist']
    : [...new Set(exportTargets(exportsForConsumers).filter(target => target !== './package.json').map(target => target.split('/')[1]))];
  if (shipped.includes('dist') || bundle) await assertCompiled(source);
  await mkdir(destination, { recursive: true });
  for (const directory of shipped) await cp(join(path, directory), join(destination, directory), { recursive: true, dereference: true });
  let license = join(path, 'LICENSE');
  try { await stat(license); }
  catch (error) { if (error.code !== 'ENOENT') throw error; license = join(root, 'LICENSE'); }
  await copyFile(license, join(destination, 'LICENSE'));

  const staged = structuredClone(manifest);
  // Build hooks and development dependencies belong to the source checkout.
  delete staged.scripts;
  delete staged.devDependencies;
  if (!bundle) {
    staged.exports = exportsForConsumers;
    staged.files = shipped;
  }
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
      if (!bundle || kind === 'peerDependencies' || stagedDependencies.has(name)) continue;
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

/** Run pnpm with constant, shell-safe arguments in `directory`; returns the spawn result. */
export function runPnpm(args, directory, { allowFailure = false } = {}) {
  if (!args.every(argument => /^[\w@.:=/-]+$/.test(argument))) throw new Error(`Unsafe pnpm arguments: ${args.join(' ')}`);
  const pnpmScript = process.env.npm_execpath;
  // npm_execpath is set by `pnpm export:adapters`; invoking its JS entry avoids
  // shell quoting entirely. Direct Node usage falls back to the PATH launcher.
  const useScript = pnpmScript && /(?:^|[/\\])pnpm\.(?:c?js|mjs)$/.test(pnpmScript);
  const windowsLauncher = !useScript && process.platform === 'win32';
  const command = useScript ? process.execPath : windowsLauncher ? `pnpm.cmd ${args.join(' ')}` : 'pnpm';
  const result = spawnSync(command, useScript ? [pnpmScript, ...args] : windowsLauncher ? [] : args, {
    cwd: directory,
    encoding: 'utf8',
    // Shell arguments are checked constants. The user's destination is only
    // used by filesystem APIs and is never interpolated into a shell command.
    shell: windowsLauncher,
    windowsHide: true,
  });
  if (result.error || (result.status !== 0 && !allowFailure)) {
    throw new Error(`pnpm ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  return result;
}

function pack(directory) {
  runPnpm(['--config.node-linker=hoisted', 'pack', '--pack-destination', 'packed'], directory);
}

async function exportPackages({ root, destination, names, bundle }) {
  root = resolve(root);
  destination = resolve(destination);
  const directories = (await readdir(join(root, 'packages'), { withFileTypes: true })).filter(entry => entry.isDirectory());
  const sources = await Promise.all(directories.map(async entry => {
    try { return await readPackage(root, entry.name); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }));
  const packages = new Map(sources.filter(Boolean).map(source => [source.manifest.name, source]));
  const adapters = names.map(name => {
    const source = packages.get(`@vibespa/${name}`);
    if (!source) throw new Error(`Missing package @vibespa/${name}.`);
    return source;
  });
  const temporaryRoot = resolve(tmpdir());
  const stage = await mkdtemp(join(temporaryRoot, 'vibespa-adapters-'));
  try {
    // Finish staging every package before writing any requested output.
    for (const source of adapters) {
      await stagePackage({ root, packages, source, destination: join(stage, source.manifest.name.split('/')[1]), bundle });
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

/** Export self-contained, compiled adapter snapshots without publishing. */
export function exportAdapters({ root = repositoryRoot, destination = join(root, 'artifacts', 'adapters') } = {}) {
  return exportPackages({ root, destination, names: adapterNames, bundle: true });
}

/** Export one pinned archive per application package, without bundled copies. */
export function exportApplicationPackages({ root = repositoryRoot, destination }) {
  return exportPackages({ root, destination, names: applicationPackageNames, bundle: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const application = args[0] === '--application-packages';
    const rest = application ? args.slice(1) : args;
    // Application archives need an explicit destination; adapters default to artifacts/adapters.
    const valid = rest.length === 2 ? rest[0] === '--destination' && Boolean(rest[1]) : !application && rest.length === 0;
    if (!valid) {
      throw new Error('Usage: node scripts/export-adapters.mjs [--destination <directory>]\n'
        + '       node scripts/export-adapters.mjs --application-packages --destination <directory>');
    }
    const exported = application
      ? await exportApplicationPackages({ destination: rest[1] })
      : await exportAdapters({ destination: rest[1] });
    console.log(JSON.stringify(exported, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
