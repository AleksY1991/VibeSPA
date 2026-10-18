import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/template/**'],
    maxWorkers: 4,
    testTimeout: 15000,
    projects: [
      { extends: true, test: {
        name: 'node',
        include: ['packages/**/{test,tests}/**/*.test.{ts,js}', 'packages/**/src/**/*.test.{ts,js}', 'apps/**/src/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/dist/**', '**/template/**', 'packages/solid/**'],
      } },
      {
        extends: true,
        resolve: { conditions: ['browser', 'development'] },
        test: {
          name: 'solid',
          include: ['packages/solid/test/**/*.test.ts'],
          environment: 'happy-dom',
          server: { deps: { inline: [/solid-js/, /@solidjs\//] } },
        },
      },
    ],
  },
});
