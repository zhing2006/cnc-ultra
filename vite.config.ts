import { createReadStream, readdirSync, statSync } from 'node:fs';
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
 * Serves the development files and the complete local installation. Ranges keep movie archives
 * out of browser memory. Original files never enter the build.
 */
function originalData(): Plugin {
  const directories = [new URL('./assets/dev/', import.meta.url), new URL('./data/', import.meta.url)];
  const serve: Connect.NextHandleFunction = (request, response: ServerResponse, next) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    let name: string;
    try { name = decodeURIComponent((request.url ?? '').split('?')[0]).replace(/^\//, ''); }
    catch { response.statusCode = 400; response.end(); return; }
    if (name === 'index.json') {
      const manifest: Record<string, number> = {};
      for (const directory of [...directories].reverse()) for (const prefix of ['', 'gdi/', 'nod/']) {
        const path = fileURLToPath(new URL(prefix, directory));
        if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
        for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isFile() && /\.(mix|vqa|vqp)$/.test(entry.name) && entry.name !== 'local.mix')
          manifest[prefix + entry.name] = statSync(fileURLToPath(new URL(prefix + entry.name, directory))).size;
      }
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-cache');
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(manifest)); return;
    }
    if (!/^(?:(?:gdi|nod)\/)?[a-z0-9_-]+\.(?:mix|vqa|vqp)$/i.test(name)) {
      response.statusCode = 404; response.end(); return;
    }
    const found = directories.map(directory => {
      const path = fileURLToPath(new URL(name, directory));
      const stats = statSync(path, { throwIfNoEntry: false });
      return stats?.isFile() ? { path, stats } : undefined;
    }).find(Boolean);
    if (!found) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const { path, stats } = found;
    const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    response.setHeader('ETag', etag);
    if (request.headers['if-none-match'] === etag && !request.headers.range) {
      response.statusCode = 304; response.end(); return;
    }
    response.setHeader('Content-Type', 'application/octet-stream');
    let start = 0, end = stats.size - 1;
    if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (range && (range[1] || range[2])) {
        start = range[1] ? Number(range[1]) : Math.max(0, stats.size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      } else start = stats.size;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0) {
        response.statusCode = 416;
        response.setHeader('Content-Range', `bytes */${stats.size}`);
        response.end(); return;
      }
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
    }
    response.setHeader('Content-Length', Math.max(0, end - start + 1));
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(path, { start, end });
    response.on('close', () => stream.destroy());
    stream.on('error', error => response.destroy(error));
    stream.pipe(response);
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
  test: { include: ['src/**/*.test.ts', 'tests/**/*.test.ts'], environment: 'node', passWithNoTests: true },
});
