import { withApp, type Session } from './browser.ts';

export async function checkComputeBatch(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    const result = await page.evaluate(async () =>
      (await import('../tests/compute-batch-fixture.ts')).compareComputeBatch());
    console.log('Compute batch:', JSON.stringify(result));
  });
}
