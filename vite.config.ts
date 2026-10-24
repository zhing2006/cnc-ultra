import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Cross-origin isolation, which SharedArrayBuffer and shared memory between workers need. Any
// static host that serves the build must send the same two headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [svelte()],
  // Relative asset paths, so the build runs from any subpath.
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true, headers: isolation },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, headers: isolation },
  // three/webgpu alone is about 800 kB minified.
  build: { chunkSizeWarningLimit: 1024 },
  test: { include: ['src/**/*.test.ts'], environment: 'node', passWithNoTests: true },
});
