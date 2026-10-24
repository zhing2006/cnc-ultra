import assert from 'node:assert/strict';
import type { Browser, Page } from '@playwright/test';

export interface Session {
  browser: Browser;
  baseUrl: string;
}

export interface AppOptions {
  /** Runs in the page before any of its scripts. */
  init?: () => void;
  /** Console and page errors the check causes on purpose. Any other error fails the check. */
  expectedErrors?: RegExp[];
}

/** Opens the app in a fresh page, runs the check on it and closes the page. */
export async function withApp(session: Session, options: AppOptions, check: (page: Page) => Promise<void>) {
  const page = await session.browser.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`);
  });
  try {
    if (options.init) await page.addInitScript(options.init);
    await page.goto(session.baseUrl);
    await check(page);
  } finally {
    await page.close();
  }
  const expected = options.expectedErrors ?? [];
  assert.deepEqual(errors.filter((text) => !expected.some((pattern) => pattern.test(text))), [], 'unexpected errors in the page');
}
