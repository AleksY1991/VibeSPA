import { copyFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = join(root, 'packages');
const virtualOutput = join(root, '.vibespa-output');

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const packageDirectories = readdirSync(packagesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
const files = packageDirectories.flatMap(entry => {
  try { return sources(join(packagesRoot, entry.name, 'src')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
});
const base = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile);
if (base.error) throw new Error(ts.flattenDiagnosticMessageText(base.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(base.config, ts.sys, root);
const program = ts.createProgram(files, {
  ...parsed.options,
  noEmit: false,
  declaration: true,
  declarationMap: false,
  sourceMap: false,
  rootDir: packagesRoot,
  outDir: virtualOutput,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: path => path, getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else {
  const result = program.emit(undefined, (path, content) => {
    const parts = relative(virtualOutput, path).split(sep);
    const [packageName, sourceDirectory, ...rest] = parts;
    if (sourceDirectory !== 'src' || !packageName || rest.length === 0) throw new Error(`Unexpected compiler output: ${path}`);
    const destination = join(packagesRoot, packageName, 'dist', ...rest);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  });
  if (result.emitSkipped) throw new Error('Package compilation did not complete.');
  for (const entry of packageDirectories) {
    const packageDirectory = join(packagesRoot, entry.name);
    if (existsSync(join(packageDirectory, 'package.json'))) {
      copyFileSync(join(root, 'LICENSE'), join(packageDirectory, 'LICENSE'));
    }
  }
  const count = new Set(files.map(path => relative(packagesRoot, path).split(sep)[0])).size;
  process.stdout.write(`Built ${count} TypeScript packages with declarations.\n`);
}
