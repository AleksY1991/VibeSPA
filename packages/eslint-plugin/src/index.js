import noPrivateImports from './rules/no-private-imports.js';
import uiBoundary from './rules/ui-boundary.js';
import inertDefinition from './rules/inert-definition.js';

const plugin = {
  meta: { name: '@vibespa/eslint-plugin', version: '0.1.0' },
  rules: {
    'no-private-imports': noPrivateImports,
    'ui-boundary': uiBoundary,
    'inert-definition': inertDefinition,
  },
};

/** Add after a JavaScript/TypeScript parser configuration in an ESLint flat config. */
export function createArchitectureConfig(options = {}) {
  const {
    files = ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'], rootDir, aliases, moduleRoots, packageRoots,
    domainRoots, uiRoots, contractRoots, uiAdapters, allowedUiImports, forbiddenUiImports,
    declarationFactories, definitionImports,
  } = options;
  const supplied = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
  const common = supplied({ rootDir, aliases, moduleRoots, packageRoots });
  return [{
    name: 'vibespa/architecture', files, plugins: { vibespa: plugin },
    rules: {
      'vibespa/no-private-imports': ['error', common],
      'vibespa/ui-boundary': ['error', { ...common, ...supplied({ domainRoots, uiRoots, contractRoots, uiAdapters, allowedUiImports, forbiddenUiImports }) }],
      'vibespa/inert-definition': ['error', { ...common, ...supplied({ declarationFactories, definitionImports }) }],
    },
  }];
}

// Authoring policy, not a claim that every raw call is unowned: modules create
// effects, cleanup and roots through the managed helpers, which enter the module
// owner, refuse work after cancellation and contain cleanup errors.
const managedSolidPrimitive = {
  importNames: ['createEffect', 'createRenderEffect', 'createTrackedEffect', 'createReaction', 'createRoot', 'onCleanup'],
  message: 'Application modules use managed helpers for effects, cleanup and roots: createModuleEffect, onModuleCleanup '
    + 'or moduleAccessor from @vibespa/solid/module, or scope.run for owned construction.',
};

/**
 * Ownership policy for production application-module code. Add after
 * typescript-eslint's configuration; the promise rule is type-aware.
 */
export function createApplicationModulePolicy({ files, ignores = [], tsconfigRootDir }) {
  return [
    {
      name: 'vibespa/application-modules/managed-solid',
      files, ignores,
      rules: {
        'no-restricted-imports': ['error', {
          paths: ['solid-js', '@solidjs/signals'].map(name => ({ name, ...managedSolidPrimitive })),
        }],
      },
    },
    {
      // Unhandled promises must be awaited, returned or given a rejection
      // handler. `void` alone is not handling. Handling a promise does not make
      // its work owned; use scope.task, scope.acquire or scope.defer.
      name: 'vibespa/application-modules/promises',
      files, ignores,
      languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
      rules: { '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }] },
    },
  ];
}

export default plugin;
