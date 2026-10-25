import { withApp, type Session } from './browser.ts';
export async function checkMatchRegressions(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    await page.evaluate(async () => (await import('../tests/match-regressions-fixture.ts')).checkMatchRegressions());
  });
}
