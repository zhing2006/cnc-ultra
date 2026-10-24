import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    // Full Chromium in new headless mode. The default headless shell gets no WebGPU adapter.
    channel: 'chromium',
  },
  webServer: {
    command: 'pnpm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
});
