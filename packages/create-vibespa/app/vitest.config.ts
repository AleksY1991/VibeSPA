import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Solid computations and ownership diagnostics need Solid's browser development build.
  resolve: { conditions: ['browser', 'development'] },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['./test-support/solid-diagnostics.ts'],
    testTimeout: 15000,
    // Inline Solid and the VibeSPA packages so every import shares one Solid instance.
    server: { deps: { inline: [/solid-js/, /@solidjs\//, /@vibespa\//] } },
  },
});
