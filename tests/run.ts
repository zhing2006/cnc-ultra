// Browser checks. Starts its own Vite server on a free port next to one Chromium, runs the checks
// side by side and closes everything it opened.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { createServer, type Logger } from 'vite';
import type { Session } from './browser.ts';
import { checkShadowComposition } from './palette.ts';
import { checkDeviceLossRestart, checkNoWebGLFallback } from './renderer.ts';
import { checkOriginalVisuals } from './visuals.ts';
import { checkSimulation } from './simulation.ts';
import { checkCombat } from './combat.ts';
import { checkSelectionReady } from './startup.ts';
import { checkUnits } from './units.ts';

const started = performance.now();
const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)}s`;

const serverProblems: string[] = [];
const logger: Logger = {
  info() {},
  warn(message) { serverProblems.push(message); },
  warnOnce(message) { serverProblems.push(message); },
  error(message) { serverProblems.push(message); },
  clearScreen() {},
  hasWarned: false,
  hasErrorLogged() { return false; },
};

const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  customLogger: logger,
  // Keep the dependency cache apart from the dev server's.
  cacheDir: 'node_modules/.vite-tests',
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    // The checks never edit files. Vite's config merge drops watch: null, so ignore every path instead.
    watch: { ignored: () => true },
    hmr: false,
    // Each check collects its own page's errors; forwarded copies would land here a second time.
    forwardConsole: false,
  },
});

let browser: Browser | undefined;
try {
  // Full Chromium in new headless mode. The default headless shell gets no WebGPU adapter.
  [browser] = await Promise.all([chromium.launch({ channel: 'chromium' }), server.listen()]);
  const address = server.httpServer?.address();
  assert(address && typeof address === 'object', 'the Vite server should listen on a TCP port');
  const session: Session = { browser, baseUrl: `http://127.0.0.1:${address.port}` };

  const checks: [string, (session: Session) => Promise<void>][] = [
    ['loading stages and selection ready before first input', checkSelectionReady],
    ['ground combat, deterministic impacts and survivors', checkCombat],
    ['original unit movement, multiple targets, sight and controls', checkUnits],
    ['integer CPU/GPU simulation, contention and deterministic replay', checkSimulation],
    ['no WebGL fallback when the WebGPU device cannot be created', checkNoWebGLFallback],
    ['restart after the GPU device is lost while starting and while running', checkDeviceLossRestart],
    ['shadows and house colors compose like drawing each sprite in turn', checkShadowComposition],
    ['original object order, cloaking, integer zoom and the asset preview', checkOriginalVisuals],
  ];
  const results = await Promise.allSettled(checks.map(async ([name, check]) => {
    const start = performance.now();
    try {
      await check(session);
      console.log(`ok   ${name} (${seconds(start)})`);
    } catch (error) {
      console.error(`FAIL ${name} (${seconds(start)})`);
      throw error;
    }
  }));
  const failures = results.filter((result) => result.status === 'rejected');
  for (const failure of failures) console.error(failure.reason);
  assert.equal(failures.length, 0, `${failures.length} of ${checks.length} checks failed`);
  assert.deepEqual(serverProblems, [], 'the Vite dev server should not warn or report errors');
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
console.log(`browser checks passed (${seconds(started)} total)`);
