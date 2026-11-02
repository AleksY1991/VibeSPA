// Repository lint policy for production application modules (eslint.config.js):
// managed Solid helpers for effects, cleanup and roots, and type-aware handling
// of floating promises. Fixtures are linted in memory at representative paths.
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const eslint = new ESLint({ cwd: root });
const modulePath = 'apps/playground/src/modules/focus/internal/runtime.ts';
const moduleTestPath = 'apps/playground/src/modules/focus/internal/runtime.test.ts';
const adapterPath = 'packages/solid/src/module.ts';

async function rules(code, filePath = modulePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map(message => message.ruleId);
}
const restricted = messages => messages.filter(rule => rule === 'no-restricted-imports').length;
const floating = messages => messages.filter(rule => rule === '@typescript-eslint/no-floating-promises').length;

describe('managed Solid helpers in application modules', () => {
  it.each([
    ['a named effect import', "import { createEffect } from 'solid-js';\ncreateEffect(() => 1, () => {});\n"],
    ['an aliased cleanup import', "import { onCleanup as release } from 'solid-js';\nrelease(() => {});\n"],
    ['a namespace import', "import * as Solid from 'solid-js';\nSolid.createRoot(() => {});\n"],
    ['a re-export', "export { createRenderEffect } from 'solid-js';\n"],
    ['the underlying signals package', "import { createRoot } from '@solidjs/signals';\ncreateRoot(() => {});\n"],
  ])('rejects %s', async (_label, code) => {
    expect(restricted(await rules(code))).toBeGreaterThan(0);
  });

  it('allows native signals and memos, and the managed helpers', async () => {
    const code = [
      "import { createMemo, createSignal, untrack } from 'solid-js';",
      "import { createModuleEffect, moduleAccessor, onModuleCleanup } from '@vibespa/solid/module';",
      'export const used = [createMemo, createSignal, untrack, createModuleEffect, moduleAccessor, onModuleCleanup];',
      '',
    ].join('\n');
    expect(restricted(await rules(code))).toBe(0);
  });

  it('does not restrict module tests or framework adapters', async () => {
    const code = "import { createEffect, onCleanup } from 'solid-js';\nexport const used = [createEffect, onCleanup];\n";
    expect(restricted(await rules(code, moduleTestPath))).toBe(0);
    expect(restricted(await rules(code, adapterPath))).toBe(0);
  });
});

describe('floating promises in application modules', () => {
  it.each([
    ['an ignored promise', 'export function run(work: () => Promise<void>) {\n  work();\n}\n'],
    ['a promise silenced only with void', 'export function run(work: () => Promise<void>) {\n  void work();\n}\n'],
    ['a then without a rejection handler', 'export function run(work: () => Promise<void>) {\n  work().then(() => {});\n}\n'],
  ])('rejects %s', async (_label, code) => {
    expect(floating(await rules(code))).toBe(1);
  });

  it.each([
    ['an awaited promise', 'export async function run(work: () => Promise<void>) {\n  await work();\n}\n'],
    ['a returned promise', 'export function run(work: () => Promise<void>) {\n  return work();\n}\n'],
    ['a handled rejection', 'export function run(work: () => Promise<void>, report: (error: unknown) => void) {\n  work().catch(report);\n}\n'],
  ])('accepts %s', async (_label, code) => {
    expect(floating(await rules(code))).toBe(0);
  });

  it('does not apply to module tests', async () => {
    const code = 'export function run(work: () => Promise<void>) {\n  void work();\n}\n';
    expect(floating(await rules(code, moduleTestPath))).toBe(0);
  });
});
