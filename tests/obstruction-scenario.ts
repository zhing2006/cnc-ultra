import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import type { CombatSetup } from '../src/game/simulation/combat-state.ts';

/** DRIVE.CPP Start_Of_Move / INFANTRY.CPP AI: an armed enemy blocks the only route. */
export function obstructionScenario(name: string, blocker = 'MTNK'): CombatSetup {
  const width = 24, height = 5, passable = new Uint8Array(width * height);
  passable.fill(1, width * 2, width * 3);
  return {
    grid: gridEdges(width, height, passable, true), passable,
    land: new Uint8Array(passable.length), seed: 1995,
    units: [{ cell: 49, type: movementType(name), facing: 64 },
      { cell: 57, type: movementType(blocker), facing: 64, owner: 1, health: 1 }],
  };
}

export function buildingObstructionScenario(): CombatSetup {
  const setup = obstructionScenario('MTNK');
  const passable = setup.passable!.slice();
  passable[57] = passable[58] = 0;
  setup.grid = gridEdges(24, 5, passable, true); setup.passable = passable;
  setup.units = [setup.units[0], { cell: 57, type: movementType('NUKE'), owner: 1 }];
  return setup;
}
