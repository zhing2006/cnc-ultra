import assert from 'node:assert/strict';
import type { Browser, Page } from '@playwright/test';
import type { GpuEnvironment } from './gpu.ts';
import { setTimeout as delay } from 'node:timers/promises';

/** Playwright waitForFunction treats a returned Promise as truthy; await GPU reads explicitly. */
export async function pollCheck(check:()=>Promise<boolean>,message:string,timeout=5000){
  const deadline=Date.now()+timeout;
  while(!await check()){
    assert(Date.now()<deadline,message);
    await delay(25);
  }
}

export interface Session {
  browser: Browser;
  baseUrl: string;
  gpu?: GpuEnvironment;
  /** Full milestone journeys and GPU cost measurements run only in acceptance. */
  acceptance?: boolean;
  /** Performance samples wait until other checks stop using the GPU. */
  performanceReady?: Promise<void>;
}

export interface AppOptions {
  /** Initial page; offscreen fixtures do not need an unrelated game rendering behind them. */
  path?: string;
  /** Runs in the page before any of its scripts. */
  init?: () => void;
  /** Console errors, TSL warnings and page errors caused on purpose. Other issues fail the check. */
  expectedErrors?: RegExp[];
}

const inputOwners = new WeakMap<Browser, Promise<void>>();
/** Pointer lock and fullscreen share browser focus. Only these interaction phases take turns. */
export async function withInput(session: Session, page: Page, check: () => Promise<void>) {
  const previous = inputOwners.get(session.browser) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  inputOwners.set(session.browser, current);
  await previous;
  try { await page.bringToFront(); await check(); } finally { release(); }
}

/** Opens the app in a fresh page, runs the check on it and closes the page. */
export async function withApp(session: Session, options: AppOptions, check: (page: Page) => Promise<void>) {
  const page = await session.browser.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  let failPage!:(error:Error)=>void;
  const pageFailed=new Promise<never>((_,reject)=>{failPage=reject;});
  // An animation-loop error can stop a fixture before its completion promise
  // settles. Report it immediately instead of waiting forever for another tick.
  void pageFailed.catch(()=>{});
  const record=(message:string)=>{
    errors.push(message);
    if(!(options.expectedErrors??[]).some(pattern=>pattern.test(message)))failPage(new Error(message));
  };
  page.on('pageerror', (error) => record(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || (message.type() === 'warning' && message.text().startsWith('THREE.TSL:')))
      record(`${message.text()} (${message.location().url})`);
  });
  try {
    if (options.init) await page.addInitScript(options.init);
    await page.goto(`${session.baseUrl}${options.path ?? '/?render=map'}`);
    await Promise.race([check(page),pageFailed]);
  } catch(error) {
    console.error('Browser failure state:', await page.evaluate(() => ({
      url: location.href, hidden: document.hidden,
      status: document.querySelector('canvas')?.getAttribute('data-status'),
      stage: document.querySelector('[data-loading-stage]')?.textContent,
    })).catch(() => 'Page is unavailable'));
    const unexpected=errors.filter(text=>!(options.expectedErrors??[]).some(pattern=>pattern.test(text)));
    if(unexpected.length)throw new AggregateError([error,...unexpected.map(text=>new Error(text))],'Browser check and page errors');
    throw error;
  } finally {
    await page.close();
  }
  const expected = options.expectedErrors ?? [];
  assert.deepEqual(errors.filter((text) => !expected.some((pattern) => pattern.test(text))), [], 'unexpected errors or TSL warnings in the page');
}
