import assert from 'node:assert/strict';
import { withInput, withApp, type Session } from './browser.ts';
import type { Page } from '@playwright/test';

async function frames(page: Page, count = 8) {
  await page.evaluate(count => new Promise<void>(resolve => {
    const next = () => { if (--count <= 0) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }), count);
}


export async function checkSimulation(session: Session) {
  await withApp(session, {path:'/tests/fixture.html'}, async page => {
    assert.deepEqual(await page.evaluate(async () => (await import('../tests/simulation-fixture.ts')).compareSimulation()), []);
    await page.goto(`${session.baseUrl}/?demo=simulation`);
    await page.locator('canvas[data-status="running"]').waitFor({state:'attached'});
    await withInput(session,page,async()=>{
    await page.getByRole('button', {name:'Flow field', exact:true}).click();
    assert.equal(await page.getByRole('button', {name:'Flow field', exact:true}).getAttribute('aria-pressed'), 'true');
    const destination = await page.evaluate(async () => {
      const {PalettePipeline} = await import('../src/engine/indexed/pipeline.ts');
      const {loadData} = await import('../src/game/data-files.ts');
      const {simulationScene} = await import('../src/demo/simulation-scene.ts');
      const {passable,setup,scene} = simulationScene(await loadData());
      scene.setup.displacement?.dispose();
      return new Promise<{x:number;y:number;cell:number}>(resolve => {
        const render = PalettePipeline.prototype.render;
        PalettePipeline.prototype.render = function(view,scale) {
          PalettePipeline.prototype.render = render; render.call(this,view,scale);
          for (let y = Math.floor(view.height * 0.7); y > 190; y -= 24) for (let x = Math.floor(view.width * 0.7); x > 100; x -= 24) {
            const cx = Math.floor((view.x+x)/24), cy = Math.floor((view.y+y)/24), cell = cy * setup.grid.width + cx;
            if (cx >= 0 && cy >= 0 && cx < setup.grid.width && cy < setup.grid.height && passable[cell]) {
              resolve({x:x*scale/devicePixelRatio,y:y*scale/devicePixelRatio,cell}); return;
            }
          }
          throw new Error('No visible move destination');
        };
      });
    });
    const command = page.evaluate(async () => {
      const {GpuSimulation} = await import('../src/engine/simulation/gpu.ts');
      return new Promise<number>((resolve,reject) => {
        const step = GpuSimulation.prototype.step;
        const timeout = setTimeout(() => {
          GpuSimulation.prototype.step = step;
          reject(new Error('No move command received'));
        }, 5000);
        GpuSimulation.prototype.step = function(commands = []) {
          step.call(this,commands);
          if (commands.length) { clearTimeout(timeout); GpuSimulation.prototype.step = step; resolve(commands[0].target); }
        };
        (window as unknown as { simulationCommandReady: boolean }).simulationCommandReady = true;
      });
    });
    // The async import must finish before input; fast ticks can consume the command before a late hook.
    await page.waitForFunction(() => (window as unknown as { simulationCommandReady?: boolean }).simulationCommandReady);
    await page.mouse.click(destination.x,destination.y);
    await page.waitForFunction(() => document.pointerLockElement !== null);
    await page.mouse.click(destination.x,destination.y);
    assert.equal(await command, destination.cell, 'a map click submits the world cell as a move command');
    await page.keyboard.press('Escape');
    // Playwright's synthetic Escape does not invoke Chromium's native pointer-lock exit gesture.
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => document.pointerLockElement === null);
    await frames(page,12);
    await page.getByRole('button', {name:'Pause',exact:true}).click();
    const stopped = Number(await page.locator('[data-tick]').textContent());
    await frames(page);
    assert.equal(Number(await page.locator('[data-tick]').textContent()), stopped, 'manual pause stops logic ticks');
    await page.getByRole('button', {name:'Resume',exact:true}).click();
    await frames(page);
    await page.evaluate(() => {
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hidden = Number(await page.locator('[data-tick]').textContent());
    await frames(page);
    assert.equal(Number(await page.locator('[data-tick]').textContent()), hidden, 'background visibility pauses logic ticks');
    await page.evaluate(() => {
      delete (document as unknown as {hidden?:boolean}).hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(previous => Number(document.querySelector('[data-tick]')?.textContent) > previous, hidden);
    const resumed = Number(await page.locator('[data-tick]').textContent());
    assert(resumed > hidden, 'visibility resumes logic ticks');
    await page.screenshot({path:'test-results/m2-demo.png'});
    const adapter = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      return adapter && {vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description};
    });
    console.log(`Simulation environment: Chromium ${session.browser.version()}, ${JSON.stringify(adapter)}`);
    });
  });
}
