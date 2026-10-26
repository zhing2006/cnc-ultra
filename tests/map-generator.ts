import assert from 'node:assert/strict';
import { withApp, type Session } from './browser.ts';

export async function checkMapSampling(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    const result = await page.evaluate(async () => (await import('../tests/map-sampling-fixture.ts')).checkMapSampling());
    assert.equal(result.worldWidth, 12288);
    assert.equal(result.worldHeight, 6144);
  });
}

export async function checkMapGenerator(session: Session) {
  await withApp(session, { path: '/?mode=ultra&seed=1995' }, async page => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator('canvas[data-status="ultra"]').waitFor({ timeout: 30_000 });
    assert.match(await page.locator('footer').innerText(), /Seed 1995 · 512 × 256/);
    const supportPositions = await page.evaluate(() => {
      const armies = ['.zone.west', '.zone.east'].map(selector => document.querySelector(selector)!.getBoundingClientRect());
      return [...document.querySelectorAll('.zone.support')].map((element, i) => {
        const support = element.getBoundingClientRect(), army = armies[i];
        return { deltaY: Math.abs(support.y + support.height / 2 - army.y - army.height / 2), inside: support.left >= army.left && support.right <= army.right };
      });
    });
    assert.equal(supportPositions.length, 2);
    for (const position of supportPositions) assert(position.inside && position.deltaY <= 1, 'support should follow its army, not remain at the northern edge');
    await page.screenshot({ path: 'test-results/m7-map-overview.png' });
    await page.getByRole('button', { name: 'Layout guides' }).click();
    await page.getByRole('button', { name: 'Coast', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="Zoom"]')?.value === '1');
    // Wait for one rendered frame after changing the camera, not an arbitrary time delay.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: 'test-results/m7-map-coast.png' });
    await page.getByRole('button', { name: 'Northern terrain' }).click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: 'test-results/m7-map-north.png' });
    await page.getByRole('button', { name: 'Layout guides' }).click();
    const westX = () => page.locator('.zone.west').evaluate(element => element.getBoundingClientRect().x);
    const beforePan = await westX();
    await page.mouse.move(720, 480); await page.mouse.down(); await page.mouse.move(840, 480); await page.mouse.up();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await westX() - beforePan, 120, 'dragging pans the map and its deployment regions together');
    await page.getByRole('button', { name: 'Next seed' }).click();
    await page.waitForURL(/seed=1996/);
    await page.locator('canvas[data-status="ultra"]').waitFor({ timeout: 30_000 });
    assert.match(await page.locator('footer').innerText(), /Seed 1996/);
    await page.getByLabel('Map size').selectOption('384x256');
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await page.waitForURL(/size=384x256/);
    await page.locator('canvas[data-status="ultra"]').waitFor({ timeout: 30_000 });
    await page.reload();
    await page.locator('canvas[data-status="ultra"]').waitFor({ timeout: 30_000 });
    assert.match(await page.locator('footer').innerText(), /Seed 1996 · 384 × 256/);
    // More physical pixels can make Whole map larger than 1:8, as on Retina displays.
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const armyWidth = () => page.locator('.zone.west').evaluate(element => element.getBoundingClientRect().width);
    const beforeZoom = await armyWidth();
    await page.mouse.move(1280, 700); await page.mouse.wheel(0, -100);
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="Zoom"]')?.value === '1/4');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert(await armyWidth() > beforeZoom, 'scrolling up from Whole map must increase magnification');
  });
}
