import assert from 'node:assert/strict';
import { withApp, withInput, type Session } from './browser.ts';

export async function checkSelectionReady(session: Session) {
  await withApp(session, {path:'/tests/fixture.html'}, async page => {
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
    await page.locator('canvas[data-status="running"]').waitFor({state:'attached'});
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
    });
  });
}
