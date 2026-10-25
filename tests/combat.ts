import { withInput, withApp, type Session } from './browser.ts';
import { writeFileSync } from 'node:fs';
import { checkObserverControls } from './match-foundations.ts';
export async function checkCombat(session: Session) {
  await withApp(session, {path:'/tests/fixture.html'}, async (page) => {
    page.setDefaultTimeout(30000);
    await page.exposeFunction('waitForGpuBenchmarks', () => session.performanceReady ?? Promise.resolve());
    const measured = await page.evaluate(async acceptance => (await import('../tests/combat-fixture.ts')).compareCombat(
      () => (window as unknown as { waitForGpuBenchmarks(): Promise<void> }).waitForGpuBenchmarks(),acceptance),!!session.acceptance);
    writeFileSync('test-results/m4-measurement.json', JSON.stringify({ browser: session.browser.version(), gpu: session.gpu, ...measured }, null, 2));
    console.log(`M4 environment: Chromium ${session.browser.version()}, ${JSON.stringify(measured)}`);
    if(session.acceptance){
      const defense=await page.evaluate(async()=>(await import('../tests/match-performance-fixture.ts')).measureBaseDefense());
      writeFileSync('test-results/m6-scaling.json',JSON.stringify({gpu:session.gpu,browser:session.browser.version(),defense},null,2));
      console.log(`M6 base-defense GPU measurement: ${JSON.stringify(defense)}`);
      const median=[...defense.gpuMs].sort((a,b)=>a-b)[Math.floor(defense.gpuMs.length/2)];
      if(session.gpu?.vendor==='nvidia'&&median>1000/60)throw new Error(`Base defense alone exceeded the 60 FPS frame budget: ${median} ms`);
    }
    await page.goto(`${session.baseUrl}/?demo=combat`);
    await page.locator('canvas[data-status="running"]').waitFor({ state: 'attached' });
    await withInput(session, page, async () => {
      await page.evaluate(async () => {
        const { GpuCombat } = await import('../src/game/simulation/combat-gpu.ts');
        const step = GpuCombat.prototype.step;
        GpuCombat.prototype.step = function (commands) {
          (window as unknown as {
            combatTest: InstanceType<typeof GpuCombat>;
          }).combatTest = this;
          return step.call(this, commands);
        };
      });
      await page.waitForFunction(() => !!(window as unknown as {
        combatTest: unknown;
      }).combatTest);
      await page.keyboard.press('n');
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.evaluate(async () => {
        const { GpuCombat } = await import('../src/game/simulation/combat-gpu.ts');
        const { WORDS, UHEALTH } = await import('../src/game/simulation/units-state.ts');
        const battle = (window as unknown as {
          combatTest: InstanceType<typeof GpuCombat>;
        }).combatTest;
        const ids = battle.setup.units.flatMap((u, id) => u.owner === 0 && u.health !== 0 ? [id] : []);
        battle.step([{ frame: battle.frame + 1, kind: 'attack', target: 6, ids }]);
        battle.stepMany(450);
        const result = await battle.snapshot();
        if (result[1][6 * WORDS + UHEALTH] >= 300)
          throw new Error('The commanded force did not damage its target');
      });
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await page.waitForFunction(() => Number(document.querySelector('[data-tick]')?.getAttribute('data-tick')) > 460);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.screenshot({ path: 'test-results/m4-combat.png' });
      await checkObserverControls(page);
    });
  });
}
