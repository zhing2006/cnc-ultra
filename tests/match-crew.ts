import { withApp, type Session } from './browser.ts';

export async function checkMatchCrew(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    await page.evaluate(async () => {
      const { createRenderer } = await import('../src/engine/renderer.ts');
      const { checkMatchEconomy } = await import('../tests/match-economy-fixture.ts');
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const wrapper = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
      if (!wrapper) throw new Error('WebGPU is required');
      wrapper.three.setAnimationLoop(null);
      wrapper.three.render = () => { throw new Error('Crew checks must not draw'); };
      try { await checkMatchEconomy(wrapper.three); }
      finally { wrapper.dispose(); canvas.remove(); }
    });
  });
}
