import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assertNoSymlink } from '../src/scaffold.mjs';

const checks = dirname(fileURLToPath(import.meta.url));
const root = resolve(checks, '../../..');
const temporary = await mkdtemp(join(tmpdir(), 'vibespa-consumers-'));
const formatHost = { getCurrentDirectory: () => root, getCanonicalFileName: path => path, getNewLine: () => '\n' };

function within(directory, path) {
  const location = relative(directory, path);
  return location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location);
}

function requireClean(diagnostics, label) {
  assert.equal(diagnostics.length, 0, `${label}\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost)}`);
}

async function emittedConsumerChecks() {
  const consumer = join(temporary, 'consumer');
  // Only the real public manifests and emitted output are installed. Source is
  // deliberately absent, including if an export accidentally points back to it.
  for (const name of ['core', 'contracts']) {
    const source = join(root, 'packages', name);
    const destination = join(consumer, 'node_modules', '@vibespa', name);
    await mkdir(destination, { recursive: true });
    await cp(join(source, 'package.json'), join(destination, 'package.json'));
    await cp(join(source, 'dist'), join(destination, 'dist'), { recursive: true });
  }
  const fixtures = join(consumer, 'src');
  await mkdir(fixtures);
  for (const name of await readdir(join(checks, 'fixtures'))) {
    assert.ok(name.endsWith('.ts.txt'), `Unexpected fixture: ${name}`);
    await cp(join(checks, 'fixtures', name), join(fixtures, name.slice(0, -4)));
  }
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: false,
    verbatimModuleSyntax: true,
    customConditions: [],
    types: [],
    paths: undefined,
    baseUrl: undefined,
  };
  const host = ts.createCompilerHost(options);
  const probe = join(fixtures, 'positive.ts');
  for (const [specifier, name] of [
    ['@vibespa/core', 'core'], ['@vibespa/core/module', 'core'], ['@vibespa/core/system', 'core'],
    ['@vibespa/contracts', 'contracts'],
  ]) {
    const resolved = ts.resolveModuleName(specifier, probe, options, host).resolvedModule;
    assert.ok(resolved, `Unresolved public import: ${specifier}. Run pnpm build:packages first.`);
    const dist = join(consumer, 'node_modules', '@vibespa', name, 'dist');
    assert.ok(within(dist, await realpath(resolved.resolvedFileName)) && resolved.resolvedFileName.endsWith('.d.ts'),
      `${specifier} must resolve to emitted declarations: ${resolved.resolvedFileName}`);
  }
  let rejected = 0;
  for (const name of ['positive', 'extra-loader-input', 'missing-input', 'wrong-input', 'invented-export']) {
    const path = join(fixtures, `${name}.ts`);
    const source = await readFile(path, 'utf8');
    assert.ok(!/@ts-(?:expect-error|ignore|nocheck)/.test(source), `Suppressed fixture: ${name}`);
    const expected = source.split(/\r?\n/).flatMap((line, index) => {
      const match = line.match(/\/\/ @diagnostic (\d+) (.+)$/);
      return match ? [{ line: index, code: Number(match[1]), message: match[2] }] : [];
    });
    assert.equal(expected.length > 0, name !== 'positive', `Missing diagnostic markers: ${name}`);
    const program = ts.createProgram([path], options, host);
    // Check the entire program: declaration, config, and unresolved-import
    // failures must never masquerade as successful contract rejections.
    const diagnostics = ts.getPreEmitDiagnostics(program);
    for (const file of program.getSourceFiles()) {
      const packageDirectory = join(consumer, 'node_modules', '@vibespa');
      if (within(packageDirectory, file.fileName)) {
        const location = relative(packageDirectory, file.fileName).split(sep);
        assert.equal(location[1], 'dist', `Framework source leaked into consumer: ${file.fileName}`);
        assert.ok(file.isDeclarationFile, `Non-declaration framework input: ${file.fileName}`);
      }
    }
    const remaining = [...diagnostics];
    for (const marker of expected) {
      const index = remaining.findIndex(diagnostic => diagnostic.file && resolve(diagnostic.file.fileName) === path
        && diagnostic.start !== undefined
        && diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line === marker.line
        && diagnostic.code === marker.code
        && ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').includes(marker.message));
      assert.notEqual(index, -1, `${name}:${marker.line + 1} must report TS${marker.code} containing ${marker.message}\n`
        + ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
      remaining.splice(index, 1);
    }
    requireClean(remaining, `${name}: unexpected diagnostics`);
    rejected += expected.length;
  }
  console.log(`Public declarations: positive consumer compiled; ${rejected} marked contract errors rejected (root + module + system, dist only).`);
}

try {
  await emittedConsumerChecks();
} finally {
  // This is the unique scratch directory returned by mkdtemp, never a checkout.
  assert.ok(within(tmpdir(), temporary) && temporary !== resolve(tmpdir()));
  await assertNoSymlink(temporary);
  await rm(temporary, { recursive: true, force: true });
}
