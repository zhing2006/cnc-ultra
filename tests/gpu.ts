import assert from 'node:assert/strict';
import { chromium, type Browser } from '@playwright/test';

export interface GpuEnvironment {
  vendor: string;
  architecture: string;
  name: string;
  driver: string;
  browser: string;
}

export interface GpuChoice {
  vendor: string;
  luid: string;
}

/** Windows adapter LUIDs are discovered on each run, never persisted as configuration. */
export async function discoverGpus(browser: Browser): Promise<GpuChoice[]> {
  if (process.platform !== 'win32') return [];
  const page = await browser.newPage();
  try {
    await page.goto('chrome://gpu');
    // chrome://gpu first publishes a placeholder adapter with LUID={0,0}.
    await page.getByText(/LUID=\{(?!0,0\})/).first().waitFor();
    const report = await page.locator('info-view').evaluate(element => element.shadowRoot!.textContent!);
    return [...report.matchAll(/VENDOR=\s*0x([\da-f]+),[\s\S]*?LUID=\{(-?\d+),(\d+)\}/gi)]
      .map(match => ({
        vendor: match[1].toLowerCase() === '1002' ? 'amd' : match[1].toLowerCase() === '10de' ? 'nvidia' : 'other',
        luid: `${match[2]},${match[3]}`,
      }));
  } finally { await page.close(); }
}

export async function launchGpu(choice?: GpuChoice,preciseTimestamps=false) {
  return chromium.launch({ channel: 'chromium', args: [...(choice ? ['--use-angle=d3d11', `--use-adapter-luid=${choice.luid}`] : []),...(preciseTimestamps?['--enable-webgpu-developer-features']:[])] });
}

/** Check the actual WebGPU adapter, not merely the browser's launch arguments. */
export async function identifyGpu(browser: Browser, baseUrl: string, expected?: string): Promise<GpuEnvironment> {
  const page = await browser.newPage();
  const cdp = await browser.newBrowserCDPSession();
  try {
    await page.goto(`${baseUrl}/tests/fixture.html`);
    const adapter = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter is available');
      return { vendor: adapter.info.vendor, architecture: adapter.info.architecture };
    });
    if (expected) assert.equal(adapter.vendor, expected, `The requested ${expected} GPU must actually execute the checks`);
    const { gpu } = await cdp.send('SystemInfo.getInfo');
    const active = gpu.devices[0];
    return { ...adapter, name: active.deviceString, driver: active.driverVersion, browser: browser.version() };
  } finally { await cdp.detach(); await page.close(); }
}
