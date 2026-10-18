import { describe, it, expect } from 'vitest';
import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import plugin, { createArchitectureConfig } from '../src/index.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
});
const root = { rootDir: '/repo' };
const moduleFile = '/repo/apps/playground/src/modules/tasks/commands.ts';
const uiFile = '/repo/apps/playground/src/ui/tasks.tsx';
const definitionFile = '/repo/apps/playground/src/modules/tasks/definition.ts';
const privateError = { messageId: 'private' };
const presentationError = { messageId: 'presentation' };
const inertError = { messageId: 'inert' };

tester.run('no-private-imports', plugin.rules['no-private-imports'], {
  valid: [
    { filename: moduleFile, options: [root], code: "import { save } from './internal/save';" },
    { filename: moduleFile, options: [root], code: "import { save } from '@/modules/tasks/internal/save';" },
    { filename: moduleFile, options: [root], code: "export { save } from './internal/save';" },
    { filename: moduleFile, options: [root], code: "import { contacts } from '../contacts/index';" },
    { filename: '/repo/packages/core/src/index.ts', options: [root], code: "export * from './internal/scope';" },
    { filename: '/repo/packages/core/tests/scope.ts', options: [root], code: "import { scope } from '../src/internal/scope';" },
    { filename: '/repo/packages/core/src/internal/index.ts', options: [root], code: "import { scope } from '@vibespa/core/internal/scope';" },
    { filename: '/repo/apps/playground/src/modules/tasks/modules/filter/index.ts', options: [root], code: "import { query } from './internal/query';" },
    { filename: '/repo/src/widgets/search/index.ts', options: [{ ...root, moduleRoots: ['src/widgets'] }], code: "import { query } from './internal/query';" },
  ],
  invalid: [
    { filename: moduleFile, options: [root], code: "import { save } from '../contacts/internal/save';", errors: [privateError] },
    { filename: moduleFile, options: [root], code: "export { save } from '@/modules/contacts/internal/save';", errors: [privateError] },
    { filename: moduleFile, options: [root], code: "export * from '../contacts/internal/save';", errors: [privateError] },
    { filename: moduleFile, options: [root], code: "export type { Save } from '../contacts/internal/save';", errors: [privateError] },
    { filename: moduleFile, options: [root], code: "const save = import('@/modules/contacts/internal/save');", errors: [privateError] },
    { filename: moduleFile, options: [root], code: 'const save = import(`../contacts/internal/save`);', errors: [privateError] },
    { filename: moduleFile, options: [root], code: "type Save = import('../contacts/internal/save').Save;", errors: [privateError] },
    { filename: moduleFile, options: [root], code: "const save = require('../contacts/internal/save');", errors: [privateError] },
    { filename: moduleFile, options: [root], code: "import save = require('../contacts/internal/save');", errors: [privateError] },
    { filename: moduleFile, options: [root], code: "import { scope } from '@vibespa/core/internal/scope';", errors: [privateError] },
    { filename: moduleFile, options: [root], code: "import { values } from '@vibespa/settings/internal/values';", errors: [privateError] },
    { filename: moduleFile, options: [root], code: "export * from '@vibespa/interaction/internal/dispatch';", errors: [privateError] },
    { filename: '/repo/apps/playground/src/main.ts', options: [root], code: "import { save } from './modules/tasks/internal/save';", errors: [privateError] },
    { filename: moduleFile, options: [root], code: "import { query } from './modules/filter/internal/query';", errors: [privateError] },
    { filename: '/repo/apps/playground/src/modules/tasks/modules/filter/index.ts', options: [root], code: "import { save } from '../../internal/save';", errors: [privateError] },
    { filename: '/repo/packages/core/src/index.ts', options: [root], code: "import { query } from './modules/filter/internal/query';", errors: [privateError] },
    { filename: '/repo/src/main.ts', options: [{ ...root, aliases: { '#search': 'src/widgets/search' }, moduleRoots: ['src/widgets'] }], code: "export * from '#search/internal/query';", errors: [privateError] },
    { filename: 'C:/REPO/apps/playground/src/modules/tasks/index.ts', options: [{ rootDir: 'c:/repo' }], code: "import { scope } from '@vibespa/core/internal/scope';", errors: [privateError] },
  ],
});

tester.run('ui-boundary', plugin.rules['ui-boundary'], {
  valid: [
    { filename: moduleFile, options: [root], code: "import { createSignal } from 'solid-js'; const [count] = createSignal(0);" },
    { filename: moduleFile, options: [root], code: 'const store = { batch() {} }; store.batch();' },
    { filename: uiFile, options: [root], code: "import type { TaskView } from '@vibespa/contracts'; import { observe } from '@vibespa/solid';" },
    { filename: uiFile, options: [root], code: "import { Button } from './controls/button'; import type { TaskView } from '../contracts/tasks';" },
    { filename: uiFile, options: [root], code: "import { createSignal } from 'solid-js'; import { render } from '@solidjs/web'; import './style.css'; const view = <div />;" },
    { filename: moduleFile, options: [root], code: 'function inspect(document: { value: number }) { return document.value; }' },
    { filename: '/repo/packages/contracts/src/tasks.ts', options: [root], code: 'interface Element { id: string }; type Selection = Element;' },
    { filename: '/repo/apps/playground/src/modules/tasks/ui-adapter.tsx', options: [{ ...root, uiAdapters: ['apps/*/src/modules/*/ui-adapter.*'] }], code: "import { render } from '@solidjs/web'; const view = <div />;" },
    { filename: '/repo/packages/interaction/src/browser.ts', options: [{ ...root, domainRoots: ['packages/interaction/src'], uiAdapters: ['packages/interaction/src/browser.ts'] }], code: 'document.addEventListener("keydown", () => {});' },
  ],
  invalid: [
    { filename: moduleFile.replace(/\.ts$/, '.tsx'), options: [root], code: 'const view = <div />;', errors: [presentationError] },
    { filename: moduleFile.replace(/\.ts$/, '.tsx'), options: [root], code: 'const view = <>text</>;', errors: [presentationError] },
    { filename: moduleFile, options: [root], code: "import './tasks.css';", errors: [presentationError] },
    { filename: moduleFile, options: [root], code: "const css = import('./tasks.css');", errors: [presentationError] },
    { filename: moduleFile, options: [root], code: "export { render } from '@solidjs/web';", errors: [presentationError] },
    { filename: moduleFile, options: [root], code: 'const element = document.createElement("div");', errors: [presentationError] },
    { filename: moduleFile, options: [root], code: 'const element = globalThis.document.querySelector("div");', errors: [presentationError] },
    { filename: moduleFile, options: [root], code: 'const href = window.location.href;', errors: [presentationError] },
    { filename: moduleFile, options: [root], code: 'element.classList.add("active");', errors: [presentationError] },
    { filename: moduleFile, options: [root], code: 'element.style.color = "red";', errors: [presentationError] },
    { filename: moduleFile, options: [root], code: 'element.setAttribute("style", "color:red");', errors: [presentationError] },
    { filename: moduleFile, options: [root], code: "import { Page } from '../../ui/page';", errors: [presentationError] },
    { filename: uiFile, options: [root], code: "import { commands } from '../modules/tasks/index';", errors: [{ messageId: 'dependency' }] },
    { filename: uiFile, options: [root], code: "export * from '@/modules/tasks/index';", errors: [{ messageId: 'dependency' }] },
    { filename: uiFile, options: [root], code: "const core = import('@vibespa/core');", errors: [{ messageId: 'dependency' }] },
    { filename: uiFile, options: [root], code: "import { createSettings } from '@vibespa/settings';", errors: [{ messageId: 'dependency' }] },
    { filename: uiFile, options: [root], code: "import { createInteraction } from '@vibespa/interaction';", errors: [{ messageId: 'dependency' }] },
    { filename: uiFile, options: [{ ...root, domainRoots: ['packages/settings/src'], forbiddenUiImports: [] }], code: "export { createSettings } from '@vibespa/settings';", errors: [{ messageId: 'dependency' }] },
    { filename: uiFile, options: [{ ...root, domainRoots: ['packages/interaction/src'], forbiddenUiImports: [] }], code: "const interaction = import('@vibespa/interaction');", errors: [{ messageId: 'dependency' }] },
    { filename: uiFile, options: [root], code: "import { createClient } from '@supabase/supabase-js';", errors: [{ messageId: 'dependency' }] },
    { filename: uiFile, options: [root], code: "import { compose } from '../composition';", errors: [{ messageId: 'dependency' }] },
    { filename: '/repo/packages/contracts/src/tasks.ts', options: [root], code: 'interface View { element: HTMLElement; }', errors: [{ messageId: 'domContract' }] },
    { filename: '/repo/packages/contracts/src/tasks.ts', options: [root], code: 'interface View { render(): JSX.Element; }', errors: [{ messageId: 'domContract' }] },
    { filename: '/repo/packages/core/src/scope.tsx', options: [root], code: 'const element = <div />;', errors: [presentationError] },
  ],
});

tester.run('inert-definition', plugin.rules['inert-definition'], {
  valid: [
    { filename: definitionFile, options: [root], code: "import type { ModuleDefinition } from '@vibespa/core'; export const definition = { id: 'tasks', load: () => import('./internal/runtime') } satisfies ModuleDefinition;" },
    { filename: definitionFile, options: [root], code: "import { defineModule as declare } from '@vibespa/core'; export default declare({ id: 'tasks', load: () => import('./internal/runtime').then(m => m.create()) });" },
    { filename: definitionFile, options: [root], code: "import { defineModule } from '@vibespa/core/module'; export default defineModule({ id: 'tasks', load: () => import('./internal/runtime') });" },
    { filename: definitionFile, options: [root], code: "import { defineModule as declare } from '@vibespa/core/module'; export default declare({ id: 'tasks', load: () => import('./internal/runtime').then(m => m.create()) });" },
    ...['Policy', 'Store', 'Feature', 'Service', 'View'].map(kind => ({
      filename: definitionFile, options: [root],
      code: `import { FeatureType } from '@vibespa/contracts'; import { defineFeatureModule } from '@vibespa/core/module'; export default defineFeatureModule({ id: 'tasks', kind: FeatureType.${kind}, title: 'Tasks', description: 'Owns tasks.', contract: { inputs: { store: 'Task storage.' }, exports: { tasks: 'Read tasks.' } }, load: () => import('./internal/runtime').then(m => m.createTasks) });`,
    })),
    { filename: definitionFile, options: [root], code: "import { FeatureType as Kind, type Readable } from '@vibespa/contracts'; import { defineFeatureModule as declare } from '@vibespa/core'; export default declare<Kind.Feature, { title: string }, { title: Readable<string> }>({ id: 'tasks', kind: Kind.Feature, title: 'Tasks', description: 'Owns tasks.', contract: { inputs: { title: 'Initial title.' }, exports: { title: 'Read the title.' } }, load: () => import('./internal/runtime').then(m => m.createTasks) });" },
    { filename: definitionFile, options: [root], code: "import { FeatureType, defineFeatureModule } from '@vibespa/core/module'; export default defineFeatureModule({ id: 'tasks', kind: FeatureType['Store'], load: () => import('./internal/runtime') });" },
    { filename: definitionFile, options: [root], code: "import { FeatureType as Kind, defineFeatureModule as declare } from '@vibespa/core'; export default declare({ id: 'tasks', kind: Kind.View, load: () => new Runtime() });" },
    { filename: definitionFile, options: [root], code: "import { defineModule } from '@vibespa/core'; export default defineModule({ id: 'tasks', async load() { const m = await import('./internal/runtime'); return m.create(); } });" },
    { filename: definitionFile, options: [root], code: "export const definition = { id: 'tasks', load: () => new Runtime() };" },
    { filename: definitionFile, options: [{ ...root, definitionImports: ['./metadata'] }], code: "import { metadata } from './metadata'; export const definition = { id: 'tasks', metadata };" },
    { filename: definitionFile, options: [root], code: "export type { Task } from './types'; export const definition = { id: 'tasks', dependencies: ['storage'], load: async () => ({}) };" },
    { filename: moduleFile, options: [root], code: "import './side-effect'; new Runtime(); start();" },
  ],
  invalid: [
    { filename: definitionFile, options: [root], code: "import './side-effect';", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { createStore } from './internal/store';", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { createScope } from '@vibespa/core';", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { FeatureType, createScope } from '@vibespa/core';", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { FeatureType, createSource } from '@vibespa/contracts';", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import * as FeatureType from '@vibespa/contracts';", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { FeatureType } from './internal/runtime'; const kind = FeatureType.Feature;", errors: [inertError, inertError] },
    { filename: definitionFile, options: [root], code: "import { FeatureType } from '@vibespa/contracts'; const kind = FeatureType.Unknown;", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { FeatureType as Kind } from '@vibespa/contracts'; const kind = Kind[selectedKind];", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { FeatureType } from '@vibespa/contracts'; const kind = FeatureType.Feature();", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { FeatureType } from '@vibespa/contracts'; const runtime = new FeatureType.Feature();", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { FeatureType } from '@vibespa/contracts'; FeatureType.Feature = 'other';", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { FeatureType } from '@vibespa/contracts'; const kind = FeatureType.Feature.value;", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { FeatureType } from '@vibespa/contracts'; import { defineFeatureModule } from '@vibespa/core/module'; export default defineFeatureModule({ id: 'tasks', kind: FeatureType.Feature, title: initialize(), load: () => import('./internal/runtime') });", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "import { defineFeatureModule as declare } from '@vibespa/core'; export default declare({ id: 'tasks', contract: new Runtime(), load: () => import('./internal/runtime') });", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "export const store = new Store();", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "export const data = fetch('/api');", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "export const definition = { load: createRuntime() };", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "const runtime = import('./internal/runtime');", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "export * from './internal/runtime';", errors: [inertError] },
    { filename: definitionFile, options: [root], code: "export { runtime } from './internal/runtime';", errors: [inertError] },
    { filename: definitionFile, options: [root], code: 'state.ready = true;', errors: [inertError] },
    { filename: definitionFile, options: [root], code: 'for (const value of values) {}', errors: [inertError] },
    { filename: definitionFile, options: [root], code: 'const initialize = () => true;', errors: [inertError] },
    { filename: definitionFile, options: [root], code: 'const definition = { get load() { return 1; } };', errors: [inertError] },
    { filename: definitionFile, options: [root], code: 'const current = window.location.href;', errors: [inertError] },
    { filename: definitionFile, options: [root], code: 'const name = tag`run`;', errors: [inertError] },
  ],
});

describe('architecture flat config', () => {
  it('composes with a TypeScript parser and keeps custom aliases in every import boundary', () => {
    const config = createArchitectureConfig({
      rootDir: '/repo', aliases: { '#contacts': 'apps/playground/src/modules/contacts' },
      domainRoots: ['apps/*/src/modules'],
    });
    const messages = new Linter({ cwd: '/repo' }).verify("import { secret } from '#contacts/internal/state';", [
      { languageOptions: { parser: tseslint.parser } }, ...config,
    ], { filename: moduleFile });
    expect(messages.map(message => message.ruleId)).toEqual(['vibespa/no-private-imports']);
  });
});
