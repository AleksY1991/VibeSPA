import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [solid({ include: /\.tsx$/, refresh: { disabled: true }, babel: { presets: [['@babel/preset-typescript', { onlyRemoveTypeImports: true }]] } })],
  // Solid computations and ownership diagnostics need Solid's browser development build.
  resolve: { conditions: ['browser', 'development'], dedupe: ['solid-js', '@solidjs/web', '@solidjs/signals'] },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['./test-support/solid-diagnostics.ts'],
    testTimeout: 15000,
    // Inline Solid and the VibeSPA packages so every import shares one Solid instance.
    server: { deps: { inline: [/solid-js/, /@solidjs\//, /@vibespa\//, /@ui-kit\//, /@awesome.me\//, /lit(?:-|\/|$)/, /@lit\//] } },
  },
});
