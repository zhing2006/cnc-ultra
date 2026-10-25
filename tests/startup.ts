import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { withApp, withInput, type Session } from './browser.ts';

export interface StartupProbe {
  readyAt: number | null;
  readyTick: number | null;
  latePipelines: { kind: string; at: number }[];
  frameGaps: number[];
  pointerDownAt: number | null;
  pointerLockMs: number | null;
}

/** Observe before loading the app: waiting for a locator can hide a blocked main thread. */
export function observeStartup() {
  const probe: StartupProbe = { readyAt: null, readyTick: null, latePipelines: [], frameGaps: [], pointerDownAt: null, pointerLockMs: null };
  (window as unknown as { startupProbe: StartupProbe }).startupProbe = probe;
  new MutationObserver(() => {
    if (probe.readyAt === null && document.querySelector('canvas[data-status="running"]')) {
      probe.readyAt = performance.now();
      probe.readyTick = Number(document.querySelector('[data-tick]')?.getAttribute('data-tick'));
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-status'] });
  const record = (kind: string) => {
    if (document.querySelector('canvas[data-status="running"]')) probe.latePipelines.push({ kind, at: performance.now() });
  };
  const sync = GPUDevice.prototype.createComputePipeline;
  GPUDevice.prototype.createComputePipeline = function (...args) { record('compute'); return sync.apply(this, args); };
  const async = GPUDevice.prototype.createComputePipelineAsync;
  GPUDevice.prototype.createComputePipelineAsync = function (...args) { record('computeAsync'); return async.apply(this, args); };
  let previous = 0;
  const frame = (now: number) => {
    if (probe.readyAt !== null && probe.frameGaps.length < 90) {
      if (previous) probe.frameGaps.push(now - previous);
      previous = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.addEventListener('mousedown', event => {
    if (event.target instanceof HTMLCanvasElement && probe.pointerDownAt === null) probe.pointerDownAt = performance.now();
  }, true);
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement && probe.pointerDownAt !== null && probe.pointerLockMs === null)
      probe.pointerLockMs = performance.now() - probe.pointerDownAt;
  });
}

export async function checkSelectionReady(session: Session) {
  await withApp(session, {path:'/tests/fixture.html', init: observeStartup}, async page => {
    page.setDefaultTimeout(30000);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/data/conquer.mix', async route => { await held; await route.continue(); });
    await page.goto(`${session.baseUrl}/?demo=combat`);
    try {
      await page.locator('[data-loading-stage]').filter({hasText:'Loading game files'}).waitFor();
      assert.equal(await page.locator('canvas').getAttribute('data-status'), 'starting');
      await page.screenshot({path:'test-results/loading.png'});
    } finally { release(); }
    // Cold shader compilation shares the GPU with the parallel suite. Keep its deadline
    // separate from input readiness assertions, as in the building-scene check.
    await page.locator('canvas[data-status="running"]').waitFor({state:'attached',timeout:60000});
    await page.unroute('**/data/conquer.mix');
    await page.evaluate(async () => {
      const { GpuSelection } = await import('../src/game/simulation/selection.ts');
      const apply = GpuSelection.prototype.apply;
      GpuSelection.prototype.apply = function (command) {
        const backend = (this as unknown as {renderer:{backend:{createComputePipeline(...args: unknown[]): unknown}}}).renderer.backend;
        const create = backend.createComputePipeline;
        let builds = 0;
        backend.createComputePipeline = function (...args) { builds++; return create.apply(this, args); };
        try { return apply.call(this, command); } finally {
          backend.createComputePipeline = create;
          (window as unknown as {selectionBuilds:number}).selectionBuilds = builds;
        }
      };
    });
    await withInput(session, page, async () => {
      await page.mouse.click(610,330);
      await page.waitForFunction(() => !!document.pointerLockElement);
      await page.waitForTimeout(180);
      await page.mouse.move(570,300,{steps:3}); await page.mouse.down();
      await page.mouse.move(690,390,{steps:5}); await page.mouse.up();
      await page.waitForFunction(() => (window as unknown as {selectionBuilds?:number}).selectionBuilds !== undefined);
      assert.equal(await page.evaluate(() => (window as unknown as {selectionBuilds:number}).selectionBuilds), 0,
        'the first selection must not build a compute pipeline after startup');
      await page.waitForFunction(() => Number(document.querySelector('[data-tick]')?.getAttribute('data-tick')) >= 3);
      const probe = await page.evaluate(() => (window as unknown as { startupProbe: StartupProbe }).startupProbe);
      writeFileSync('test-results/startup-measurement.json', JSON.stringify({ gpu: session.gpu, ...probe }, null, 2));
      assert.equal(probe.readyTick, 0, 'preparing the scene must not advance the simulation');
      assert.deepEqual(probe.latePipelines, [], 'all simulation and sound pipelines must be ready when loading finishes');
    });
  });
}
