import { createReadStream, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Cross-origin isolation, which SharedArrayBuffer and shared memory between workers need. Any
// static host that serves the build must send the same two headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Serves the original MIX files in assets/dev/ at data/, where a deployed site keeps them. The build
 * never contains them.
 */
function originalData(): Plugin {
  const directory = new URL('./assets/dev/', import.meta.url);
  const serve: Connect.NextHandleFunction = (request, response: ServerResponse, next) => {
    const name = decodeURIComponent((request.url ?? '').split('?')[0]).replace(/^\//, '');
    // Plain file names only, so that no path can leave the directory.
    if (!/^[\w.-]+$/.test(name)) return next();
    const path = fileURLToPath(new URL(name, directory));
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats?.isFile()) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', stats.size);
    createReadStream(path).pipe(response);
  };
  return {
    name: 'original-data',
    configureServer: (server) => void server.middlewares.use('/data', serve),
    configurePreviewServer: (server) => void server.middlewares.use('/data', serve),
  };
}

export default defineConfig({
  plugins: [svelte(), originalData()],
  // Relative asset paths, so the build runs from any subpath.
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true, headers: isolation },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, headers: isolation },
  // three/webgpu alone is about 800 kB minified.
  build: { chunkSizeWarningLimit: 1024 },
  test: { include: ['src/**/*.test.ts'], environment: 'node', passWithNoTests: true },
});
