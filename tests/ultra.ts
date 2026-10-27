import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { withApp, type Session } from './browser.ts';

export async function checkUltra(session: Session) {
  await withApp({ ...session, checkTimeoutMs: 600000 }, { path: '/tests/fixture.html' }, async page => {
    const result = await page.evaluate(async journey => (await import('../tests/ultra-fixture.ts')).compareUltra(journey), !!session.acceptance || process.argv.includes('--journey'));
    assert.equal(result.units, 20000);
    assert.equal(result.frames, 28);
    assert(result.selected > 9900);
    await writeFile('test-results/m8-determinism.json', JSON.stringify({ gpu: session.gpu, ...result }, null, 2));
  });
}
