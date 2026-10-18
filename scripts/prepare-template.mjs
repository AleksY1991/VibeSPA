import { copyFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, copyTemplate } from '../packages/create-vibespa/src/scaffold.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(root, 'packages', 'create-vibespa');
const destination = join(packageRoot, 'template');
await assertNoSymlink(packageRoot);
const staged = await mkdtemp(join(packageRoot, '.template-'));

// Cleanup is limited to these two fixed, verified children of the CLI package.
for (const path of [destination, staged]) {
  if (!path.startsWith(`${packageRoot}${sep}`)) throw new Error('Template path escaped its package.');
  await assertNoSymlink(path);
}
try {
  await copyTemplate({ templateRoot: root, destination: staged, name: 'vibespa-app' });
  await assertNoSymlink(destination);
  await rm(destination, { recursive: true, force: true });
  await rename(staged, destination);
  await copyFile(join(root, '.gitignore'), join(destination, '_gitignore'));
  // Override the embedded .gitignore during pack so compiled library exports
  // remain available to ordinary consumers of the generated workspace.
  await writeFile(join(destination, '.npmignore'), '**/node_modules/\n**/.cache/\n**/.vite/\n**/coverage/\n');
  const packageLicense = join(packageRoot, 'LICENSE');
  await assertNoSymlink(packageLicense);
  await copyFile(join(root, 'LICENSE'), packageLicense);
  console.log('Prepared create-vibespa/template.');
} catch (error) {
  await assertNoSymlink(staged);
  await rm(staged, { recursive: true, force: true });
  throw error;
}
