import type { WebGPURenderer } from 'three/webgpu';
import { initialUnits, UHEALTH, WORDS, UCELL, UWAIT } from '../src/game/simulation/units-state.ts';
import { initialCombat, CWORDS, BWORDS, SHOTS_PER_UNIT, CTARGET, CMISSION, CLOCAL_ROUTE, ATTACK, BACTIVE, BTIMER, BTYPE, BDAMAGE, BSOURCE, BTO_X, BTO_Y } from '../src/game/simulation/combat-state.ts';
import { movementType } from '../src/game/data/movement.ts';
import type { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
/** Reuse compiled combat kernels; cover death and expanded-search spikes, not just opening ticks. */
export async function combatHotspots(renderer: WebGPURenderer, battle: GpuCombat) {
  const backend = renderer.backend as unknown as {
    trackTimestamp: boolean;
  };
  const samples: Record<string, number> = {};
  const width = battle.setup.grid.width, count = battle.setup.units.length;
  for (const mode of ['deaths', 'expandedSearch'] as const) {
    const units = initialUnits({ ...battle.setup, units: battle.setup.units.map(u => ({ ...u, type: movementType('MTNK'), owner: 0 })) });
    const state = initialCombat(battle.setup), projectiles = new Int32Array(battle.projectiles.array.length);
    for (let id = 0; id < count; id++) {
      const at = id * WORDS, c = id * CWORDS;
      if (mode === 'deaths') {
        const b = id * SHOTS_PER_UNIT * BWORDS;
        projectiles[b] = projectiles[b + BTO_X] = units[at];
        projectiles[b + 1] = projectiles[b + BTO_Y] = units[at + 1];
        projectiles[b + BACTIVE] = projectiles[b + BTIMER] = 1;
        projectiles[b + BTYPE] = 2;
        projectiles[b + BDAMAGE] = 1000;
        projectiles[b + BSOURCE] = -1;
      }
      else {
        units[at + UHEALTH] = id < 256 ? 400 : 0;
        if (id >= 256)
          continue;
        const x = 8 + id % 16 * 15, y = 8 + Math.floor(id / 16) * 15;
        units[at] = x * 256 + 128;
        units[at + 1] = y * 256 + 128;
        units[at + UCELL] = y * width + x;
        units[at + UWAIT] = 1;
        state[c + CTARGET] = -(y * width + x + (x < 128 ? 30 : -30)) - 2;
        state[c + CMISSION] = ATTACK;
        state[c + CLOCAL_ROUTE] = 1;
      }
    }
    for (const [attribute, values] of [[battle.units, units], [battle.state, state], [battle.projectiles, projectiles]] as const) {
      (attribute.array as Int32Array).set(values);
      attribute.needsUpdate = true;
    }
    for (const attribute of [battle.movement.goals, battle.movement.pathGoals]) {
      (attribute.array as Int32Array).fill(-1);
      attribute.needsUpdate = true;
    }
    battle.movement.refreshOccupancy();
    // These are new starting placements, not a teleport during a match. Reveal
    // their initial view before timing the battle tick, as the constructor does.
    battle.sight.step();
    await renderer.getArrayBufferAsync(battle.movement.control);
    backend.trackTimestamp = true;
    renderer.compute(battle['before']);
    const prepare = (await renderer.resolveTimestampsAsync('compute'))!;
    battle.movement.step();
    const movement = (await renderer.resolveTimestampsAsync('compute'))!;
    renderer.compute(battle['after']);
    battle.movement.refreshOccupancy();
    const resolve = (await renderer.resolveTimestampsAsync('compute'))!;
    samples[mode] = prepare + movement + resolve;
    samples[`${mode}Prepare`] = prepare;
    samples[`${mode}Movement`] = movement;
    samples[`${mode}Resolve`] = resolve;
    backend.trackTimestamp = false;
    if (mode === 'deaths') {
      const result = new Int32Array(await renderer.getArrayBufferAsync(battle.units));
      for (let id = 0; id < count; id++)
        if (result[id * WORDS + UHEALTH] !== 0)
          throw new Error(`Mass-death fixture left ${id} alive`);
    }
  }
  return { units: count, searches: 256, gpuMs: samples };
}
