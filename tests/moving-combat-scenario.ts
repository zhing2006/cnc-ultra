import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import * as C from '../src/game/simulation/combat-state.ts';

/** Two targets beside a clear route distinguish firing in transit from pursuing them. */
export function movingCombatScenario(name: string, owner: number): { setup: C.CombatSetup; goal: number } {
  const width = 32, height = 10, passable = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) passable.fill(1, y * width + 1, (y + 1) * width - 1);
  const locked = name === 'FTNK' || name === 'MSAM';
  return { goal: 4 * width + 27, setup: {
    grid: gridEdges(width, height, passable, true), passable, land: new Uint8Array(passable.length),
    seed: 1995, multiplayer: true,
    units: [{ cell: 4 * width + 3, type: movementType(name), owner, facing: 64 },
      { cell: 5 * width + 6, type: movementType('MCV'), owner: 1 - owner, health: locked ? 10000 : 1 },
      { cell: 5 * width + 18, type: movementType('MCV'), owner: 1 - owner, health: 1 }],
    missions: [C.SLEEP, C.SLEEP, C.SLEEP],
  } };
}
