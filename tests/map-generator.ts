import assert from 'node:assert/strict';
import { withApp, withInput, type Session } from './browser.ts';

export async function checkMapSampling(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    const result = await page.evaluate(async () => (await import('../tests/map-sampling-fixture.ts')).checkMapSampling());
    assert.equal(result.worldWidth, 12288); assert.equal(result.worldHeight, 6144);
  });
}

export async function checkMapGenerator(session: Session) {
  await withApp(session, { path: '/?mode=ultra&seed=1995' }, async page => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator('canvas[data-status="ultra"]').waitFor({ timeout: 90_000 });
    assert.match(await page.locator('footer').innerText(), /Seed 1995 · 512 × 256/);
    await page.waitForFunction(() => Number(document.querySelector('footer')?.textContent?.match(/Tick (\d+)/)?.[1]) >= 3, undefined, { timeout: 30000 });
    await page.screenshot({ path: 'test-results/m8-overview.png' });
    const before = await page.getByLabel('Zoom', { exact: true }).innerText();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForFunction(value => document.querySelector('[aria-label="Zoom"]')?.textContent !== value, before);
    await page.getByRole('button', { name: 'Whole map', exact: true }).click();
    await page.waitForFunction(value => document.querySelector('[aria-label="Zoom"]')?.textContent === value, before);
    await withInput(session, page, async () => {
      await page.locator('canvas').click({ position: { x: 600, y: 350 } });
      await page.waitForFunction(() => document.pointerLockElement?.tagName === 'CANVAS');
      await page.mouse.wheel(0, -300);
      await page.waitForFunction(value => document.querySelector('[aria-label="Zoom"]')?.textContent !== value, before);
      // CDP key injection does not perform the browser's native Escape unlock.
      await page.evaluate(() => document.exitPointerLock());
      await page.waitForFunction(() => document.pointerLockElement === null);
    });
    await page.getByRole('button', { name: 'Whole map', exact: true }).click();
    await page.getByRole('button', { name: '10×', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '10×', exact: true }).getAttribute('aria-pressed'), 'true');
    const tick = Number((await page.locator('footer').innerText()).match(/Tick (\d+)/)?.[1]);
    await page.waitForFunction(value => Number(document.querySelector('footer')?.textContent?.match(/Tick (\d+)/)?.[1]) > value + 15, tick, { timeout: 30000 });
    await page.getByRole('button', { name: '1×', exact: true }).click();
    // Unit appearance is inspected from live original sprites; no project output is a visual oracle.
    for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.screenshot({ path: 'test-results/m8-battlefield.png' });
    await page.goto(`${session.baseUrl}/?mode=ultra&seed=1996&size=640x320`);
    await page.locator('canvas[data-status="ultra"]').waitFor({ timeout: 90000 });
    assert.match(await page.locator('footer').innerText(), /Seed 1996 · 640 × 320/);
    await page.waitForFunction(() => Number(document.querySelector('footer')?.textContent?.match(/Tick (\d+)/)?.[1]) >= 3, undefined, { timeout: 30000 });
    await page.screenshot({ path: 'test-results/m8-large-overview.png' });
  });
}
