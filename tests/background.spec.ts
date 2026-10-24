import { expect, test } from '@playwright/test';

test('clears the canvas to Windows blue through WebGPU', async ({ page }) => {
  await page.goto('/');
  const canvas = page.locator('canvas[data-status="running"]');
  await expect(canvas).toBeVisible();
  // Let the animation loop present a couple of frames before capturing.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const png = await canvas.screenshot();
  // Decode the screenshot in the page, which avoids a PNG decoder dependency.
  const pixel = await page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return Array.from(context.getImageData(bitmap.width >> 1, bitmap.height >> 1, 1, 1).data.slice(0, 3));
  }, png.toString('base64'));

  expect(pixel).toEqual([0x00, 0x78, 0xd4]);
});
