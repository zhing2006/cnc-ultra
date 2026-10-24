// Browser checks. Starts its own Vite server on a free port next to one Chromium, runs the checks
// side by side and closes everything it opened.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@playwright/test';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer, type Logger } from 'vite';
import type { Session } from './browser.ts';
import { checkShadowComposition } from './palette.ts';
import { checkDeviceLossRestart, checkNoWebGLFallback } from './renderer.ts';
import { checkOriginalVisuals } from './visuals.ts';
import { checkSimulation } from './simulation.ts';
import { checkCombat } from './combat.ts';
import { checkSelectionReady } from './startup.ts';
import { checkUnits } from './units.ts';
import { discoverGpus, identifyGpu, launchGpu } from './gpu.ts';

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
  [browser] = await Promise.all([launchGpu(), server.listen()]);
  const address = server.httpServer?.address();
  assert(address && typeof address === 'object', 'the Vite server should listen on a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const argument = process.argv.find(value => value.startsWith('--gpus='));
  const requested: (string | undefined)[] = argument ? argument.slice(7).split(',') : [undefined];
  assert(requested.every(value => value === undefined || value === 'amd' || value === 'nvidia'), 'Supported GPU choices are nvidia and amd');
  const choices = argument ? await discoverGpus(browser) : [];
  const reports: {
    gpu: Awaited<ReturnType<typeof identifyGpu>>;
    checks: number;
    failures: { check: string; error: string }[];
    seconds: number;
  }[] = [];

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
  await mkdir('test-results', { recursive: true });
  const saveReport = (complete: boolean) => writeFile('test-results/acceptance.json', JSON.stringify({
    requested: requested.map(vendor => vendor ?? 'default'), complete, runs: reports,
  }, null, 2));
  await saveReport(false);
  for (const vendor of requested) {
    if (vendor !== undefined) {
      const choice = choices.find(choice => choice.vendor === vendor);
      assert(choice || process.platform !== 'win32', `No ${vendor} hardware adapter is available; milestone acceptance cannot skip it`);
      await browser.close();
      browser = await launchGpu(choice);
    }
    const gpu = await identifyGpu(browser, baseUrl, vendor);
    console.log(`GPU environment: ${JSON.stringify(gpu)}`);
    let releasePerformance!: () => void;
    let peers = checks.length - 1;
    const performanceReady = new Promise<void>(resolve => { releasePerformance = resolve; });
    const session: Session = { browser, baseUrl, gpu, performanceReady };
    const suiteStart = Date.now();
    const results = await Promise.allSettled(checks.map(async ([name, check]) => {
      const start = performance.now();
      try {
        await check(session);
        console.log(`ok   [${gpu.vendor}] ${name} (${seconds(start)})`);
      } catch (error) {
        console.error(`FAIL [${gpu.vendor}] ${name} (${seconds(start)})`);
        console.error(error);
        throw error;
      } finally {
        if (check !== checkCombat && --peers === 0) releasePerformance();
      }
    }));
    const failures = results.flatMap((result, i) => result.status === 'rejected' ? [{ check: checks[i][0], error: String(result.reason) }] : []);
    for (const failure of failures) console.error(failure);
    const directory = `test-results/${gpu.vendor}`;
    await mkdir(directory, { recursive: true });
    // Existing checks retain their stable artifact names; archive each GPU run
    // before the next one replaces them. Never copy artifacts from an older run.
    for (const file of await readdir('test-results', { withFileTypes: true })) {
      if (file.isFile() && /\.(json|png)$/.test(file.name) && (await stat(`test-results/${file.name}`)).mtimeMs >= suiteStart) {
        await copyFile(`test-results/${file.name}`, `${directory}/${file.name}`);
      }
    }
    const report = { gpu, checks: checks.length, failures, seconds: (Date.now() - suiteStart) / 1000 };
    reports.push(report);
    await writeFile(`${directory}/acceptance.json`, JSON.stringify(report, null, 2));
    await saveReport(false);
  }
  await saveReport(true);
  assert.equal(reports.reduce((sum, report) => sum + report.failures.length, 0), 0, 'GPU acceptance checks failed');
  assert.deepEqual(serverProblems, [], 'the Vite dev server should not warn or report errors');
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
console.log(`browser checks passed (${seconds(started)} total)`);
