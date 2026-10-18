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

export default plugin;
