import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import type { CombatSetup } from '../src/game/simulation/combat-state.ts';

/** A stationary target keeps the attack alive while the first ranks fill its western firing arc. */
export function backlineScenario(): CombatSetup {
  const width = 40, height = 24;
  return {
    grid: gridEdges(width, height, new Uint8Array(width * height).fill(1), true),
    land: new Uint8Array(width * height), seed: 0x1995,
    units: [
      ...Array.from({ length: 40 }, (_, id) => ({
        cell: (4 + id % 8 * 2) * width + 3 + Math.floor(id / 8) * 2,
        type: movementType('MTNK'), facing: 64,
      })),
      { cell: 12 * width + 30, type: movementType('MCV'), owner: 1, health: 1000000 },
    ],
  };
}
