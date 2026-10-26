import { withApp, type Session } from './browser.ts';

export async function checkMatchRendering(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    await page.evaluate(async () => {
      const checks = await import('../tests/match-rendering-fixture.ts');
      await checks.checkDeferredVisualHistory();
      await checks.checkSpecialDrawing();
    });
  });
}
