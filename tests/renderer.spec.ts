import { expect, test, type Page } from '@playwright/test';

const WINDOWS_BLUE = [0x00, 0x78, 0xd4];

async function centerPixel(page: Page): Promise<number[]> {
  const canvas = page.locator('canvas');
  // Let the animation loop present a couple of frames before capturing.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await canvas.screenshot();
  // Decode the screenshot in the page, which avoids a PNG decoder dependency.
  return page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return Array.from(context.getImageData(bitmap.width >> 1, bitmap.height >> 1, 1, 1).data.slice(0, 3));
  }, png.toString('base64'));
}

test('clears the canvas to Windows blue through WebGPU', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas[data-status="running"]')).toBeVisible();
  expect(await centerPixel(page)).toEqual(WINDOWS_BLUE);
});

test('fails without falling back to WebGL when the WebGPU device cannot be created', async ({ page }) => {
  await page.addInitScript(() => {
    GPUAdapter.prototype.requestDevice = () => Promise.reject(new Error('requestDevice refused by the test'));
    const contextTypes: string[] = [];
    (window as unknown as { contextTypes: string[] }).contextTypes = contextTypes;
    const canvas = HTMLCanvasElement.prototype as unknown as { getContext(type: string, ...rest: unknown[]): unknown };
    const getContext = canvas.getContext;
    canvas.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      contextTypes.push(type);
      return getContext.call(this, type, ...rest);
    };
  });

  await page.goto('/');
  await expect(page.locator('canvas[data-status="failed"]')).toBeAttached();
  const contextTypes = await page.evaluate(() => (window as unknown as { contextTypes: string[] }).contextTypes);
  expect(contextTypes.filter((type) => type.startsWith('webgl'))).toEqual([]);
});

test('offers a restart after the GPU device is lost', async ({ page }) => {
  // Hand the renderer a device whose `lost` promise the test resolves.
  await page.addInitScript(() => {
    const requestDevice = GPUAdapter.prototype.requestDevice;
    const hooks = window as unknown as { loseDevice?: () => void };
    GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, ...args: Parameters<GPUAdapter['requestDevice']>) {
      const device = await requestDevice.apply(this, args);
      const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
        hooks.loseDevice = () => resolve({ reason: 'unknown', message: 'lost by the test' } as GPUDeviceLostInfo);
      });
      Object.defineProperty(device, 'lost', { value: lost });
      return device;
    };
  });

  await page.goto('/');
  await expect(page.locator('canvas[data-status="running"]')).toBeVisible();
  await page.evaluate(() => (window as unknown as { loseDevice: () => void }).loseDevice());
  await expect(page.locator('canvas[data-status="lost"]')).toBeAttached();

  await page.getByRole('button', { name: 'Restart' }).click();
  await expect(page.locator('canvas[data-status="running"]')).toBeVisible();
  expect(await centerPixel(page)).toEqual(WINDOWS_BLUE);
});
