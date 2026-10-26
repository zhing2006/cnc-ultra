import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { withApp, type Session } from './browser.ts';

export async function checkMatchFoundations(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    await page.evaluate(async () => (await import('../tests/match-foundations-fixture.ts')).compareMatchFoundations());
  });
}

/** Continue the combat check's paused game instead of compiling another copy of the same scene. */
export async function checkObserverControls(page: Page) {
  await page.evaluate(async () => {
    const { SimulationDriver } = await import('../src/engine/simulation/driver.ts');
    const setSpeed = SimulationDriver.prototype.setSpeed;
    SimulationDriver.prototype.setSpeed = function (speed) {
      (window as unknown as { matchSpeed: number }).matchSpeed = speed;
      setSpeed.call(this, speed);
    };
  });
  const snapshot = () => page.evaluate(async () => {
    const { GpuCombat } = await import('../src/game/simulation/combat-gpu.ts');
    const battle = (window as unknown as { combatTest: InstanceType<typeof GpuCombat> }).combatTest;
    return (await battle.snapshot()).map(buffer => Array.from(buffer));
  });
  const before = await snapshot();
  const own = await page.locator('canvas').screenshot();
  await page.getByLabel('Map view').selectOption('1');
  await page.getByLabel('Map view').selectOption('all');
  const full = await page.locator('canvas').screenshot();
  assert.notDeepEqual(own, full, 'full-map view must visibly reveal terrain outside the owned shroud');
  await page.getByLabel('Map view').selectOption('0');
  assert.deepEqual(await snapshot(), before, 'spectator controls must not mutate the paused simulation');
  await page.getByRole('group', { name: 'Simulation speed', exact: true }).getByRole('button', { name: '10×', exact: true }).click();
  assert.equal(await page.evaluate(() => (window as unknown as { matchSpeed: number }).matchSpeed), 10);
  const tick = Number(await page.locator('[data-tick]').textContent());
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.waitForFunction(tick => Number(document.querySelector('[data-tick]')?.getAttribute('data-tick')) >= tick + 16, tick);
  await page.waitForFunction(() => Number(document.querySelector('[data-actual-speed]')?.getAttribute('data-actual-speed')) > 0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.screenshot({ path: 'test-results/m6-foundations.png' });
}
