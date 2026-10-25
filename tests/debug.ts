import assert from 'node:assert/strict';
import { withApp, type Session } from './browser.ts';

export async function checkDebug(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    assert.equal(await page.evaluate(async () => (await import('../tests/debug-fixture.ts')).checkDebugDamage()), true);
  });
}
