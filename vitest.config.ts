import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [solid({ include: /\.tsx$/, refresh: { disabled: true }, babel: { presets: [['@babel/preset-typescript', { onlyRemoveTypeImports: true }]] } })],
    resolve: { conditions: ['development'], dedupe: ['solid-js', '@solidjs/web', '@solidjs/signals'] },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/template/**'],
    maxWorkers: 4,
    testTimeout: 15000,
    projects: [
      { extends: true, test: {
        name: 'node',
        include: ['packages/**/{test,tests}/**/*.test.{ts,js}', 'packages/**/src/**/*.test.{ts,js}'],
        exclude: ['**/node_modules/**', '**/dist/**', '**/template/**', 'packages/solid/**'],
      } },
      {
        // Application modules construct Solid computations. The node environment
        // resolves Solid's non-reactive server build, so use the browser build as
        // the solid project does.
        extends: true,
        resolve: { conditions: ['browser', 'development'] },
        test: {
          name: 'app',
          setupFiles: ['./test-support/solid-diagnostics.ts'],
          include: ['apps/**/src/**/*.test.ts'],
          environment: 'happy-dom',
          server: { deps: { inline: [/solid-js/, /@solidjs\//, /@ui-kit\//, /@awesome.me\//, /lit(?:-|\/|$)/, /@lit\//] } },
        },
      },
      {
        extends: true,
        resolve: { conditions: ['browser', 'development'] },
        test: {
          name: 'solid',
          setupFiles: ['./test-support/solid-diagnostics.ts'],
          include: ['packages/solid/test/**/*.test.ts'],
          environment: 'happy-dom',
          server: { deps: { inline: [/solid-js/, /@solidjs\//] } },
        },
      },
    ],
  },
});
