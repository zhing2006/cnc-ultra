import assert from 'node:assert/strict';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { withApp } from './browser.ts';
import { identifyGpu, launchGpu } from './gpu.ts';

const option = (name: string, fallback: number) => {
  const argument = process.argv.find(value => value.startsWith(`--${name}=`));
  const value = argument ? Number(argument.slice(name.length + 3)) : fallback;
  assert(Number.isSafeInteger(value) && value >= 0, `${name} must be a nonnegative integer`);
  return value;
};
const options = { seed: option('seed', 1995), ticks: option('ticks', 15000), progressEvery: option('every', 3000),
  ...(process.argv.some(value => value.startsWith('--force-at='))
    ? { forceAttackAt: option('force-at', 0) } : {}),
};
assert(options.seed <= 0xffffffff, 'seed must fit in an unsigned 32-bit integer');
assert(options.progressEvery > 0, 'every must be positive');
const server = await createServer({ cacheDir: 'node_modules/.vite-tests', logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, forwardConsole: false },
});
await server.listen();
const address = server.httpServer!.address();
assert(address && typeof address === 'object', 'Vite must expose a test port');
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await launchGpu();
try {
  const gpu = await identifyGpu(browser, baseUrl);
  console.log('GPU environment:', JSON.stringify(gpu));
  await mkdir('test-results', { recursive: true });
  const stem = `test-results/m6-simulation-${options.seed}${options.forceAttackAt === undefined ? '' : '-forced'}`;
  await writeFile(`${stem}-history.jsonl`, '');
  await withApp({ browser, baseUrl, gpu }, { path: '/tests/fixture.html' }, async page => {
    await page.exposeFunction('matchProgress', async (frame: number, snapshot: object) => {
      await writeFile(`${stem}-progress.tmp`, JSON.stringify({ gpu, ...snapshot }, null, 2));
      await rename(`${stem}-progress.tmp`, `${stem}-progress.json`);
      await appendFile(`${stem}-history.jsonl`, `${JSON.stringify({ gpu, ...snapshot })}\n`);
      console.log(`Logic tick ${frame}; diagnostic checkpoint saved`);
    });
    const result = await page.evaluate(async options => {
      const { runMatchSimulation } = await import('../tests/match-simulation-fixture.ts');
      const progress = (window as unknown as { matchProgress(frame: number, snapshot: object): Promise<void> }).matchProgress;
      return runMatchSimulation(options, progress);
    }, options);
    const output = `${stem}.json`;
    await writeFile(output, JSON.stringify({ gpu, ...result }, null, 2));
    console.log(JSON.stringify({ frame: result.frame, outcome: result.outcome,
      ticksPerSecond: result.ticksPerSecond, drawCalls: result.drawCalls, output }));
  });
} finally {
  await browser.close();
  await server.close();
}
