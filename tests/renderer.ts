import assert from 'node:assert/strict';
import { withApp, type Session } from './browser.ts';

/** Makes every device request fail and records which canvas contexts the page asks for. */
function refuseDevice() {
  GPUAdapter.prototype.requestDevice = () => Promise.reject(new Error('requestDevice refused by the test'));
  const contextTypes: string[] = [];
  (window as unknown as { contextTypes: string[] }).contextTypes = contextTypes;
  const canvas = HTMLCanvasElement.prototype as unknown as { getContext(type: string, ...rest: unknown[]): unknown };
  const getContext = canvas.getContext;
  canvas.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    contextTypes.push(type);
    return getContext.call(this, type, ...rest);
  };
}

/** Hands out devices whose `lost` promise `window.loseDevice()` resolves. */
function controlDeviceLoss() {
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
}

export function checkNoWebGLFallback(session: Session) {
  const options = { init: refuseDevice, expectedErrors: [/requestDevice refused by the test/] };
  return withApp(session, options, async (page) => {
    await page.locator('canvas[data-status="failed"]').waitFor({ state: 'attached' });
    const contextTypes = await page.evaluate(() => (window as unknown as { contextTypes: string[] }).contextTypes);
    assert.deepEqual(contextTypes.filter((type) => type.startsWith('webgl')), [], 'no WebGL context may be created');
  });
}

export function checkDeviceLossRestart(session: Session) {
  const options = { init: controlDeviceLoss, expectedErrors: [/WebGPU device lost: lost by the test/] };
  return withApp(session, options, async (page) => {
    await page.locator('canvas[data-status="running"]').waitFor({ state: 'attached' });
    await page.evaluate(() => (window as unknown as { loseDevice: () => void }).loseDevice());
    await page.locator('canvas[data-status="lost"]').waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Restart' }).click();
    await page.locator('canvas[data-status="running"]').waitFor({ state: 'attached' });
  });
}
