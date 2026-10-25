import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { discoverGpus, identifyGpu, launchGpu } from './gpu.ts';
import { withApp } from './browser.ts';

const ticks = Number(process.argv.find(v => v.startsWith('--ticks='))?.slice(8) ?? 1200);
assert(Number.isSafeInteger(ticks) && ticks > 100, 'Measure more than 100 warmup ticks');
let batching = false;
const server = await createServer({
  cacheDir: 'node_modules/.vite-tests', logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, forwardConsole: false },
  plugins: [{ name: 'unbatched-comparison', enforce: 'pre', transform(code, id) {
    // Disable only the batching adapter for the baseline. Both variants execute
    // the same simulation code, without a runtime toggle in the shipped game.
    if (!batching && id.replaceAll('\\', '/').endsWith('/src/engine/compute-batch.ts'))
      return { code: 'export function batchCompute(renderer, work) { return work(); }', map: null };
  } }],
});
await server.listen();
const address = server.httpServer!.address();
assert(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;
let browser = await launchGpu();
const runs: unknown[] = [];
try {
  const choices = await discoverGpus(browser);
  let reference: unknown;
  for (const vendor of ['nvidia', 'amd']) {
    const choice = choices.find(c => c.vendor === vendor);
    assert(choice, `No ${vendor} adapter`);
    await browser.close(); browser = await launchGpu(choice);
    const gpu = await identifyGpu(browser, baseUrl, vendor);
    console.log('GPU environment:', JSON.stringify(gpu));
    for (const enabled of [false, true]) {
      batching = enabled;
      server.moduleGraph.invalidateAll();
      await withApp({ browser, baseUrl, gpu }, { path: '/tests/fixture.html' }, async page => {
        const { snapshot, ...measurement } = await page.evaluate(async ticks =>
          (await import('../tests/compute-batch-performance-fixture.ts')).measureMatchBatch(ticks), ticks);
        if (reference) assert.deepEqual(snapshot, reference, `${vendor}, batching=${batching}: simulation state differs`);
        else reference = snapshot;
        const stateHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
        const result = { gpu, batching, ticks, actors: snapshot.actors.length, ...measurement, stateHash };
        runs.push(result); console.log(JSON.stringify(result));
        await mkdir('test-results', { recursive: true });
        await writeFile('test-results/m6-compute-batch.json', JSON.stringify({
          scenario: 'SCM01EA, seed 1995, both AI, 512 slots, no rendering', runs,
        }, null, 2));
      });
    }
  }
  console.log('Unbatched and batched simulation states match on both GPUs');
} finally { await browser.close(); await server.close(); }
