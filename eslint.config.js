import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
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
    allowedUiImports: ['@vibespa/contracts', '@vibespa/solid', 'solid-js', '@solidjs/web'],
  }),
  ...createApplicationModulePolicy({ files: applicationModules, ignores: applicationModuleTests, tsconfigRootDir: import.meta.dirname }),
];
