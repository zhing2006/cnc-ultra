import { Sidebar } from '../src/game/sidebar.ts';
import type { MixSet } from '../src/game/formats/mix.ts';
import { sidebarEconomy } from './sidebar-fixture.ts';

/** CPU rasterization only. No renderer submission, GPU uploads or full-frame timing. */
export function measureSidebar(data: MixSet) {
  const ticks = 1000, ticksPerDraw = 25;
  const { economy, available } = sidebarEconomy();
  available.splice(0, available.length, 'NUKE', 'PYLE', 'PROC', 'WEAP', 'E1', 'E3', 'MTNK', 'HARV');
  const sidebar = new Sidebar(economy, data);
  const everyTick: number[] = [], perDraw: number[] = [];
  const sample = (defer: boolean) => {
    const before = sidebar['texture'].version;
    const start = performance.now();
    for (let tick = 1; tick <= ticks; tick++) {
      sidebar.update(!defer);
      if (defer && tick % ticksPerDraw === 0) sidebar.drawPixels();
    }
    const elapsed = performance.now() - start;
    const expected = defer ? ticks / ticksPerDraw : ticks;
    if (sidebar['texture'].version - before !== expected) throw new Error('Sidebar rasterization count does not match rendered frames');
    return elapsed;
  };
  try {
    // Warm both paths and finish radar activation / power bounce before recording samples.
    sample(false); sample(true);
    const expected = sidebar['pixels'].slice();
    for (let i = 0; i < 5; i++) {
      // Alternate the order to reduce bias from warm-up and CPU frequency changes.
      if (i % 2) { perDraw.push(sample(true)); everyTick.push(sample(false)); }
      else { everyTick.push(sample(false)); perDraw.push(sample(true)); }
      const actual = sidebar['pixels'];
      for (let p = 0; p < expected.length; p++) if (actual[p] !== expected[p]) throw new Error(`Deferred sidebar drawing changed pixel ${p}`);
    }
    return { ticks, ticksPerDraw, paintsEveryTick: ticks, paintsPerDraw: ticks / ticksPerDraw,
      everyTickMilliseconds: everyTick, perDrawMilliseconds: perDraw, gpuAndFullFrameMeasured: false };
  } finally { sidebar.dispose(); }
}
