import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import { createApplicationModulePolicy, createArchitectureConfig } from '@vibespa/eslint-plugin';

// Production module code; module tests are exempt from the ownership policy.
const modules = ['src/modules/**/*.{ts,tsx}'];
const moduleTests = ['src/modules/**/*.test.{ts,tsx}', 'src/modules/**/*.spec.{ts,tsx}'];

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'pnpm-lock.yaml'] },
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
    aliases: { '@/': 'src/' },
    moduleRoots: ['src/modules'],
    packageRoots: [],
    domainRoots: ['src/modules'],
    uiRoots: ['src/ui'],
    contractRoots: ['src/contracts'],
    allowedUiImports: ['@vibespa/contracts', '@vibespa/solid', 'solid-js', '@solidjs/web'],
  }),
  ...createApplicationModulePolicy({ files: modules, ignores: moduleTests, tsconfigRootDir: import.meta.dirname }),
];
