import solid from '@solidjs/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [solid({ include: /\.tsx$/, refresh: { disabled: true } })],
  server: { host: '127.0.0.1', port: 8081, strictPort: true },
  preview: { host: '127.0.0.1', port: 8081, strictPort: true },
  resolve: {
    conditions: ['development', 'browser'],
    dedupe: ['solid-js', '@solidjs/web', '@solidjs/signals'],
  },
  build: { target: 'es2022' },
});
