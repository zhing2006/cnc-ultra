import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  // three/webgpu alone is about 800 kB minified.
  build: { chunkSizeWarningLimit: 1024 },
  test: { include: ['src/**/*.test.ts'], environment: 'node', passWithNoTests: true },
});
