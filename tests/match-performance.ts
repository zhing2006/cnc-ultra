import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { discoverGpus, identifyGpu, launchGpu } from './gpu.ts';
import { withApp } from './browser.ts';

const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) ?? 'current';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid measurement label');
const server = await createServer({ cacheDir: 'node_modules/.vite-tests', server: { host: '127.0.0.1', port: 0, hmr: false, forwardConsole: false }, logLevel: 'error' });
await server.listen();
const address = server.httpServer!.address();
if (!address || typeof address === 'string') throw new Error('No measurement port');
const baseUrl = `http://127.0.0.1:${address.port}`;
let browser = await launchGpu();
const choices = await discoverGpus(browser), runs: unknown[] = [];
await mkdir('test-results', { recursive: true });
try {
  for (const vendor of ['nvidia', 'amd']) {
    const choice = choices.find(item => item.vendor === vendor);
    if (!choice) throw new Error(`No ${vendor} GPU`);
    await browser.close(); browser = await launchGpu(choice);
    const gpu = await identifyGpu(browser, baseUrl, vendor);
    console.log('GPU environment:', JSON.stringify(gpu));
    await withApp({ browser, baseUrl, gpu }, { path: '/?demo=match&seed=1995' }, async page => {
      await page.locator('canvas[data-status="running"]').waitFor({ state: 'attached', timeout: 60000 });
      await page.evaluate(async () => {
        const [{ EconomyReport, REPORT_COUNTS, REPORT_HEADER }, { GpuCombat }, { GpuGround }, { CombatView }, { BuildingView }, { AircraftView }, { GpuBuildingEffects }, { PalettePipeline }] = await Promise.all([
          import('../src/game/simulation/economy-report.ts'), import('../src/game/simulation/combat-gpu.ts'),
          import('../src/game/simulation/ground.ts'), import('../src/game/simulation/combat-view.ts'),
          import('../src/game/simulation/building-view.ts'), import('../src/game/simulation/aircraft-view.ts'),
          import('../src/game/simulation/building-effects-gpu.ts'), import('../src/engine/indexed/pipeline.ts'),
        ]);
        const stats = { active: false, started: 0, startTick: 0, tick: 0, lastRender: 0,
          counts: {} as Record<string, number>, cpu: {} as Record<string, number>,
          reportMs: [] as number[], mapMs: [] as number[], renderIntervals: [] as number[],
          bytes: 0, slots: 0, actors: 0, peakActors: 0 };
        (window as unknown as { matchPerformance: typeof stats }).matchPerformance = stats;
        const observe = (prototype: object, name: string, label: string) => {
          const methods = prototype as Record<string, (this: unknown, ...args: unknown[]) => unknown>, original = methods[name];
          methods[name] = function (...args) {
            if (!stats.active) return original.apply(this, args);
            const start = performance.now();
            if (label === 'render') {
              if (stats.lastRender) stats.renderIntervals.push(start - stats.lastRender);
              stats.lastRender = start;
            }
            try { return original.apply(this, args); } finally {
              stats.counts[label] = (stats.counts[label] ?? 0) + 1;
              stats.cpu[label] = (stats.cpu[label] ?? 0) + performance.now() - start;
            }
          };
        };
        observe(GpuCombat.prototype, 'step', 'logic'); observe(GpuGround.prototype, 'sort', 'sort');
        observe(GpuGround.prototype, 'updateSprites', 'groundSprites'); observe(CombatView.prototype, 'update', 'combatSprites');
        observe(BuildingView.prototype, 'update', 'buildingSprites'); observe(AircraftView.prototype, 'update', 'aircraftSprites');
        observe(GpuBuildingEffects.prototype, 'update', 'effectSprites'); observe(PalettePipeline.prototype, 'updateGpuSprites', 'spriteIndex');
        observe(PalettePipeline.prototype, 'render', 'render'); observe(GPUQueue.prototype, 'submit', 'submit');
        const read = EconomyReport.prototype.read;
        EconomyReport.prototype.read = async function () {
          const start = performance.now(), record = stats.active;
          const result = await read.call(this);
          stats.tick = this.battle.frame;
          stats.actors = result.subarray(REPORT_COUNTS, REPORT_HEADER).reduce((sum, count) => sum + count, 0);
          if (record && stats.active) {
            stats.reportMs.push(performance.now() - start); stats.bytes = this.readbackBytes;
            stats.slots = this.battle.setup.units.length; stats.peakActors = Math.max(stats.peakActors, stats.actors);
          }
          return result;
        };
        const map = GPUBuffer.prototype.mapAsync;
        GPUBuffer.prototype.mapAsync = async function (...args) {
          const start = performance.now(), record = stats.active;
          await map.apply(this, args);
          if (record && stats.active) stats.mapMs.push(performance.now() - start);
        };
      });
      const speed = page.getByRole('group', { name: 'Simulation speed', exact: true });
      await speed.getByRole('button', { name: '100×', exact: true }).click();
      // Build and fight under real rules before measuring; no injected forces or money.
      await page.waitForFunction(() => Number(document.querySelector('[data-tick]')?.getAttribute('data-tick')) >= 14000, undefined, { timeout: 180000 });
      const samples: unknown[] = [];
      for (const target of [1, 10, 100]) {
        await speed.getByRole('button', { name: `${target}×`, exact: true }).click();
        await page.waitForTimeout(2000);
        await page.evaluate(() => {
          const stats = (window as unknown as { matchPerformance: {
            active: boolean; started: number; startTick: number; tick: number; lastRender: number;
            counts: object; cpu: object; reportMs: number[]; mapMs: number[]; renderIntervals: number[]; peakActors: number;
          } }).matchPerformance;
          Object.assign(stats, { active: true, started: performance.now(), startTick: stats.tick, lastRender: 0,
            counts: {}, cpu: {}, reportMs: [], mapMs: [], renderIntervals: [], peakActors: 0 });
        });
        // FPS and achieved speed require a wall-clock sampling window, unlike logic correctness checks.
        await page.waitForTimeout(5000);
        const result = await page.evaluate(() => {
          const stats = (window as unknown as { matchPerformance: {
            active: boolean; started: number; startTick: number; tick: number; counts: Record<string, number>;
            cpu: Record<string, number>; reportMs: number[]; mapMs: number[]; renderIntervals: number[];
            bytes: number; slots: number; actors: number; peakActors: number;
          } }).matchPerformance;
          stats.active = false;
          const elapsed = performance.now() - stats.started;
          const summarize = (samples: number[]) => {
            const sorted = samples.slice().sort((a, b) => a - b);
            return { count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
              p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)] };
          };
          return { elapsed, startTick: stats.startTick, endTick: stats.tick, slots: stats.slots,
            actors: stats.actors, peakActors: stats.peakActors, counts: stats.counts, cpuMs: stats.cpu,
            actual: (stats.counts.logic ?? 0) * 1000 / (15 * elapsed),
            panelActual: Number(document.querySelector('[data-actual-speed]')?.getAttribute('data-actual-speed')),
            renderHz: (stats.counts.render ?? 0) * 1000 / elapsed, renderIntervalsMs: summarize(stats.renderIntervals),
            reportBytes: stats.bytes, reportWallMs: summarize(stats.reportMs), allReadbackMapMs: summarize(stats.mapMs) };
        });
        samples.push({ target, ...result }); console.log(JSON.stringify({ vendor, target, ...result }));
        await page.screenshot({ path: `test-results/m6-live-${label}-${vendor}-${target}x.png` });
      }
      runs.push({ gpu, samples });
      await writeFile(`test-results/m6-live-${label}.json`, JSON.stringify({ label, scenario: 'SCM01EA, seed 1995, both AI, sampled after tick 14000', runs }, null, 2));
    });
  }
} finally { await browser.close(); await server.close(); }
