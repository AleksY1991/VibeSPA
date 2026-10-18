import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import { createArchitectureConfig } from './packages/eslint-plugin/src/index.js';

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
];
