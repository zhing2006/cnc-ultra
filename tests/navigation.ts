import { withApp, type Session } from './browser.ts';
export async function checkNavigation(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    await page.evaluate(async () => {
      const { compareUnreachablePrefixes } = await import('../tests/navigation-fixture.ts');
      await compareUnreachablePrefixes();
    });
  });
}
