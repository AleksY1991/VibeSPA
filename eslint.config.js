import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import { COLOR_SELECTORS, DESIGN_SELECTORS, plugin as designSystem } from '@ui-kit/core/eslint';
import { createApplicationModulePolicy, createArchitectureConfig } from './packages/eslint-plugin/src/index.js';

// Production application-module code. Tests and framework adapters are excluded.
const applicationModules = ['apps/*/src/modules/**/*.{ts,tsx}'];
const applicationModuleTests = ['apps/*/src/modules/**/*.test.{ts,tsx}', 'apps/*/src/modules/**/*.spec.{ts,tsx}'];

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/template/**', '**/coverage/**', 'pnpm-lock.yaml'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  ...createArchitectureConfig({
    rootDir: import.meta.dirname,
    domainRoots: [
      'apps/*/src/modules', 'packages/contracts/src', 'packages/core/src',
      'packages/local-first/src', 'packages/settings/src', 'packages/interaction/src',
    ],
    uiAdapters: ['packages/interaction/src/browser.ts'],
    allowedUiImports: ['@vibespa/contracts', '@vibespa/solid', '@vibespa/interaction', '@ui-kit/core', 'solid-js', '@solidjs/web'],
  }),
  {
    files: ['apps/*/src/ui/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.test-helper.{ts,tsx}'],
    plugins: { 'ui-kit': designSystem },
    rules: {
      'ui-kit/design-system-consumer': 'error',
      'ui-kit/icon-boundary': 'error',
      'ui-kit/element-construction': 'error',
      'ui-kit/design-geometry': 'error',
      'no-restricted-syntax': ['error', ...DESIGN_SELECTORS, ...COLOR_SELECTORS, {
        selector: 'JSXOpeningElement[name.name=/^(button|input|select|textarea|a|form|details|summary)$/]',
        message: 'Use a public @ui-kit/core control. Shared controls own interaction, appearance, keyboard behavior and lifetime.',
      }, {
        selector: "ImportDeclaration[source.value='solid-js'] > ImportSpecifier[imported.name='For']",
        message: 'Use List.View from @ui-kit/core for repeated records so the shared design system owns keyed row lifetimes.',
      }],
    },
  },
  ...createApplicationModulePolicy({ files: applicationModules, ignores: applicationModuleTests, tsconfigRootDir: import.meta.dirname }),
];
