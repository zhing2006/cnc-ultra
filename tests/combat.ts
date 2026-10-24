import { withInput, withApp, type Session } from './browser.ts';
import { writeFileSync } from 'node:fs';
export async function checkCombat(session: Session) {
  await withApp(session, {path:'/tests/fixture.html'}, async (page) => {
    page.setDefaultTimeout(30000);
    const measured = await page.evaluate(async () => (await import('../tests/combat-fixture.ts')).compareCombat());
    writeFileSync('test-results/m4-measurement.json', JSON.stringify({ browser: session.browser.version(), ...measured }, null, 2));
    console.log(`M4 environment: Chromium ${session.browser.version()}, ${JSON.stringify(measured)}`);
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
    });
  });
}
