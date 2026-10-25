import assert from 'node:assert/strict';
import { withApp, type Session } from './browser.ts';

export async function checkMatch(session: Session) {
  await withApp(session, { path: '/?demo=match' }, async page => {
    page.setDefaultTimeout(60000);
    await page.locator('canvas[data-status="running"]').waitFor({ state: 'attached' });
    assert.equal(new URL(page.url()).searchParams.get('seed'), '1995');
    assert.equal(await page.getByLabel('Seed', { exact: true }).inputValue(), '1995');
    await page.evaluate(async () => {
      const { MatchRuntime } = await import('../src/game/match-runtime.ts');
      const begin = MatchRuntime.prototype.beginTick;
      MatchRuntime.prototype.beginTick = function () { (window as unknown as { match: InstanceType<typeof MatchRuntime> }).match = this; return begin.call(this); };
    });
    await page.getByRole('group', { name: 'Simulation speed', exact: true }).getByRole('button', { name: '100×', exact: true }).click();
    await page.waitForFunction(() => {
      const match = (window as unknown as { match?: { buildings: Map<number, { owner: number; type: string; active: boolean }> } }).match;
      return match && [0, 1].every(owner => [...match.buildings.values()].some(b => b.owner === owner && b.type === 'PROC' && b.active));
    });
    const speech=await page.evaluate(async()=>{
      const {Eva}=await import('../src/game/eva.ts');
      const match=(window as unknown as {match:import('../src/game/match-runtime.ts').MatchRuntime}).match;
      const original=Eva.prototype.speak,heard:string[]=[];
      Eva.prototype.speak=function(name){heard.push(name);};
      try{
        match.setController(0);
        match.withOwner(0,()=>match.onEvent?.('building',0));
        match.withOwner(1,()=>match.onEvent?.('unitready',1));
        match.onEvent?.('nodcaptured',1);
        match.setController(null);
        match.withOwner(0,()=>match.onEvent?.('underattack',0));
        match.withOwner(1,()=>match.onEvent?.('nukeincoming',1));
        return heard;
      }finally{Eva.prototype.speak=original;match.setController(null);}
    });
    assert.deepEqual(speech,['building','nodcaptured','nukeincoming']);
    await page.getByLabel('Control', { exact: true }).selectOption({ label: 'Take over Nod' });
    assert.deepEqual(await page.evaluate(() => {
      const match = (window as unknown as { match: { controlledOwner: number | null; commanders: { enabled: boolean }[] } }).match;
      return [match.controlledOwner, ...match.commanders.map(c => c.enabled)];
    }), [1, true, false]);
    await page.getByLabel('Map view').selectOption('0');
    await page.getByLabel('Map view').selectOption('all');
    await page.getByLabel('Control', { exact: true }).selectOption({ label: 'Observe' });
    assert.deepEqual(await page.evaluate(() => {
      const match = (window as unknown as { match: { controlledOwner: number | null; commanders: { enabled: boolean }[] } }).match;
      return [match.controlledOwner, ...match.commanders.map(c => c.enabled)];
    }), [null, true, true]);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.screenshot({ path: 'test-results/m6-match-opening.png' });
    await page.evaluate(async () => {
      const { MatchRuntime } = await import('../src/game/match-runtime.ts');
      const scope = window as unknown as { matchRestarts: number[][][]; matchMarker: number };
      scope.matchRestarts = []; scope.matchMarker = 1995;
      const begin = MatchRuntime.prototype.beginTick;
      const waiting = new WeakSet<object>(), sampled = new WeakSet<object>();
      MatchRuntime.prototype.beginTick = function () {
        if (this.battle.frame === 0 && !sampled.has(this)) {
          if (!waiting.has(this)) {
            waiting.add(this);
            void this.battle.snapshot().then(state => { scope.matchRestarts.push(state.map(a => Array.from(a))); sampled.add(this); });
          }
          return false;
        }
        return begin.call(this);
      };
    });
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: 'Restart same seed', exact: true }).click();
      await page.locator('canvas[data-status="running"]').waitFor({ state: 'attached' });
      await page.waitForFunction(count => (window as unknown as { matchRestarts: unknown[] }).matchRestarts.length === count, i + 1);
    }
    const restarted = await page.evaluate(() => {
      const scope = window as unknown as { matchRestarts: number[][][]; matchMarker: number };
      return { states: scope.matchRestarts, marker: scope.matchMarker, seed: new URLSearchParams(location.search).get('seed') };
    });
    assert.equal(restarted.marker, 1995, 'restarting must not reload the document');
    assert.equal(restarted.seed, '1995');
    assert.equal(restarted.states.length, 2);
    assert.deepEqual(restarted.states[1], restarted.states[0], 'the same seed must reset all GPU simulation buffers');
  });
}
