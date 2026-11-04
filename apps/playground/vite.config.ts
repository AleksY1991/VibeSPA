import solid from '@solidjs/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [solid({ include: /\.tsx$/, refresh: { disabled: true }, babel: { presets: [['@babel/preset-typescript', { onlyRemoveTypeImports: true }]] } })],
  server: { host: '127.0.0.1', port: 8081, strictPort: true },
  preview: { host: '127.0.0.1', port: 8081, strictPort: true },
  resolve: {
    conditions: ['development', 'browser'],
    dedupe: ['solid-js', '@solidjs/web', '@solidjs/signals'],
  },
  // The shared package ships Solid TSX source, so compile it with this app's
  // pinned compiler instead of prebundling it as React-style JSX.
  optimizeDeps: { exclude: ['@ui-kit/core'] },
  build: { target: 'es2022' },
});
