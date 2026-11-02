import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assertNoSymlink } from '../src/scaffold.mjs';

const checks = dirname(fileURLToPath(import.meta.url));
const root = resolve(checks, '../../..');
const temporary = await mkdtemp(join(tmpdir(), 'vibespa-solid-domain-'));
const consumer = join(temporary, 'consumer');
const modules = join(consumer, 'node_modules');
const forbidden = /^(?:rxdb|rxjs)(?:\/|$)/;
const formatHost = { getCurrentDirectory: () => consumer, getCanonicalFileName: path => path, getNewLine: () => '\n' };

function within(directory, path) {
  const location = relative(directory, path);
  return location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location);
}

async function stagePackages() {
  // Framework source and development conditions are deliberately unavailable.
  // Loading a source path or a required RxDB peer must fail in this consumer.
  for (const name of ['contracts', 'core', 'solid']) {
    const source = join(root, 'packages', name);
    const destination = join(modules, '@vibespa', name);
    await mkdir(destination, { recursive: true });
    await cp(join(source, 'package.json'), join(destination, 'package.json'));
    await cp(join(source, 'dist'), join(destination, 'dist'), { recursive: true });
  }
  await stat(join(modules, '@vibespa', 'solid', 'dist', 'domain.js')).catch(error => {
    throw new Error('Solid domain emitted output is required. Run pnpm build:packages first.', { cause: error });
  });
  const copied = new Set();
  async function copyDependency(name, parent) {
    assert.ok(!forbidden.test(name), `Forbidden persistence dependency: ${name}`);
    if (copied.has(name)) return;
    const manifestPath = createRequire(parent).resolve(`${name}/package.json`);
    const source = dirname(await realpath(manifestPath));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const destination = join(modules, ...name.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    // Copy installed package contents, not pnpm's node_modules symlink graph.
    await cp(source, destination, {
      recursive: true, dereference: true,
      filter: path => !relative(source, path).split(sep).includes('node_modules'),
    });
    copied.add(name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await copyDependency(dependency, manifestPath);
  }
  await copyDependency('solid-js', join(root, 'package.json'));
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  for (const name of ['rxdb', 'rxjs']) {
    await assert.rejects(stat(join(modules, name)), { code: 'ENOENT' });
  }
  await assertNoSymlink(consumer);
}

const positive = `import { createSolidDomain, type DomainView } from '@vibespa/solid/domain';
import { createRestDomainAdapter } from '@vibespa/solid/domain-rest';
import type { ModuleContext } from '@vibespa/core/module';
interface Note { id: string; details: { title: string }; tags: { label: string }[] }
declare const scope: ModuleContext;
const owner = createSolidDomain<Note>(scope, { generation: 'consumer' });
export const view: DomainView<Note> = owner.view;
export const title: string | undefined = view.rows[0]?.details.title;
export const rest = createRestDomainAdapter<Note>({
  endpoint: '/notes', transport: async () => ({ status: 200, body: [] }),
});
`;
const negative = `${positive}
view.rows.push({ id: 'a', details: { title: 'A' }, tags: [] }); // @diagnostic 2339 Property 'push' does not exist
view.rows[0]!.details.title = 'Changed'; // @diagnostic 2540 Cannot assign to 'title'
view.rows[0]!.tags.push({ label: 'Changed' }); // @diagnostic 2339 Property 'push' does not exist
view.rows[0]!.tags[0]!.label = 'Changed'; // @diagnostic 2540 Cannot assign to 'label'
view.rows[0] = { id: 'b', details: { title: 'B' }, tags: [] }; // @diagnostic 2542 only permits reading
view.delivery().phase = 'failed'; // @diagnostic 2540 Cannot assign to 'phase'
view.commit({ gestureId: 'consumer', label: 'No authority', writes: [] }); // @diagnostic 2339 Property 'commit' does not exist
`;

async function typeChecks() {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: false,
    verbatimModuleSyntax: true, customConditions: [], types: [],
  };
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    assert.ok(!forbidden.test(name), `The domain consumer tried to resolve ${name} from ${containingFile}`);
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
  });
  let rejected = 0;
  for (const [name, source] of [['positive', positive], ['readonly', negative]]) {
    const path = join(consumer, `${name}.ts`);
    await writeFile(path, source);
    const program = ts.createProgram([path], options, host);
    const diagnostics = [...ts.getPreEmitDiagnostics(program)];
    for (const file of program.getSourceFiles()) {
      const packageDirectory = join(modules, '@vibespa');
      if (within(packageDirectory, file.fileName)) {
        const location = relative(packageDirectory, file.fileName).split(sep);
        assert.equal(location[1], 'dist', `Framework source leaked: ${file.fileName}`);
        assert.ok(file.isDeclarationFile, `Non-declaration framework input: ${file.fileName}`);
      }
      assert.ok(!/[\\/]node_modules[\\/](?:rxdb|rxjs)(?:[\\/]|$)/.test(file.fileName), `Persistence source leaked: ${file.fileName}`);
    }
    const markers = source.split(/\r?\n/).flatMap((line, index) => {
      const match = line.match(/\/\/ @diagnostic (\d+) (.+)$/);
      return match ? [{ line: index, code: Number(match[1]), message: match[2] }] : [];
    });
    assert.equal(markers.length, name === 'positive' ? 0 : 7);
    for (const marker of markers) {
      const index = diagnostics.findIndex(diagnostic => diagnostic.file && resolve(diagnostic.file.fileName) === path
        && diagnostic.start !== undefined
        && diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line === marker.line
        && diagnostic.code === marker.code
        && ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').includes(marker.message));
      assert.notEqual(index, -1, `${name}:${marker.line + 1} must report TS${marker.code} containing ${marker.message}\n`
        + ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
      diagnostics.splice(index, 1);
      rejected++;
    }
    assert.equal(diagnostics.length, 0, `${name}: unexpected diagnostics\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost)}`);
  }
  return rejected;
}

async function runtimeCheck() {
  const path = join(consumer, 'runtime.mjs');
  await writeFile(path, `import assert from 'node:assert/strict';
import { defineFeatureModule, FeatureType } from '@vibespa/core/module';
import { createSolidSystem } from '@vibespa/solid/module';
import { createSolidDomain } from '@vibespa/solid/domain';
import { createRestDomainAdapter } from '@vibespa/solid/domain-rest';
import { createEffect, createRoot, flush } from 'solid-js';
const system = createSolidSystem({ id: 'standalone-memory' });
const module = defineFeatureModule({
  id: 'notes', kind: FeatureType.Feature, title: 'Notes', description: 'Owns standalone memory notes.',
  contract: { inputs: {}, exports: { rows: 'Read rows.', delivery: 'Read delivery.', history: 'Read history.', commands: 'Change notes.' } },
  load: async () => (_inputs, scope) => {
  const owner = createSolidDomain(scope, { generation: 'standalone' });
  return { ...owner.view, commands: scope.commands({
    add: async () => owner.commit({ gestureId: 'add', label: 'Add', writes: [{ kind: 'put', document: { id: 'a', details: { title: 'First' }, tags: [{ label: 'stable' }] } }] }),
    rename: async () => owner.commit({ gestureId: 'rename', label: 'Rename', writes: [{ kind: 'put', document: { id: 'a', details: { title: 'Second' }, tags: [{ label: 'stable' }] } }] }),
  }) };
} });
try {
  const handle = await system.start(module, {});
  const local = handle.exports.commands.add();
  assert.equal(handle.exports.rows[0].details.title, 'First', 'local state applies synchronously');
  await local;
  const row = handle.exports.rows[0];
  const titles = [];
  const tags = [];
  const dispose = createRoot(release => {
    createEffect(() => row.details.title, value => { titles.push(value); });
    createEffect(() => row.tags[0].label, value => { tags.push(value); });
    return release;
  });
  try {
    flush();
    await handle.exports.commands.rename();
    flush();
    assert.equal(handle.exports.rows[0], row, 'row identity survives a leaf update');
    assert.deepEqual(titles, ['First', 'Second']);
    assert.deepEqual(tags, ['stable']);
    assert.throws(() => { row.details.title = 'Bypass'; }, TypeError);
    assert.equal(row.details.title, 'Second');
    assert.equal(handle.exports.delivery().phase, 'memory');
    assert.equal(handle.exports.history().canUndo, true);
  } finally { dispose(); }
  const cancellation = new AbortController();
  const rest = await createRestDomainAdapter({ endpoint: '/controlled', transport: async () => ({ status: 200, body: [] }) }).open({
    generation: 'rest', signal: cancellation.signal, receive: () => ({ accepted: [], refused: [] }),
  });
  assert.deepEqual(await rest.load(), []);
  await rest.close();
} finally { await system.dispose(); }
`);
  const result = spawnSync(process.execPath, ['--conditions=browser', path], {
    cwd: consumer, encoding: 'utf8', windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Standalone emitted memory owner failed:\n${result.stdout}${result.stderr}`);
}

try {
  await stagePackages();
  const rejected = await typeChecks();
  await runtimeCheck();
  console.log(`Solid domain consumer: emitted declarations + memory runtime passed without RxDB/RxJS; ${rejected} deep readonly violations rejected.`);
} finally {
  // Unique mkdtemp scratch tree, verified to contain no symlinks before removal.
  assert.ok(within(tmpdir(), temporary) && temporary !== resolve(tmpdir()));
  await assertNoSymlink(temporary);
  await rm(temporary, { recursive: true, force: true });
}
