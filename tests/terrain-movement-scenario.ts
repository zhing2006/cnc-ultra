import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import type { UnitsSetup } from '../src/game/simulation/units-state.ts';

/** A squad rounds a tree diagonally, then returns past the same corner. */
export function infantryTerrainScenario(trapped = false): UnitsSetup {
  const width = 8, height = 8, passable = new Uint8Array(width * height).fill(1);
  passable[27] = 0;
  return { grid: gridEdges(width, height, passable, true), passable,
    land: new Uint8Array(passable.length), seed: 1995,
    units: Array.from({ length: 5 }, (_, slot) => ({ cell: trapped ? 27 : 28, type: movementType('E1'), slot })),
  };
}

/** The illegal source is part of a solid block, so a westward order must first leave to the south. */
export function terrainExitScenario(name: string): UnitsSetup {
  const width = 8, height = 8, passable = new Uint8Array(width * height).fill(1);
  for (const cell of [18, 19, 26, 27]) passable[cell] = 0;
  return { grid: gridEdges(width, height, passable, true), passable,
    land: new Uint8Array(passable.length), seed: 1995,
    units: [{ cell: 27, type: movementType(name), facing: 192 }],
  };
}

/** A waiting ally blocks the best exit from terrain; the other exits remain free. */
export function blockedTerrainExitScenario(name: string, headOn: boolean): UnitsSetup {
  const width = 18, height = 8, passable = new Uint8Array(width * height).fill(1), source = 3 * width + 3;
  passable[source] = 0;
  return { grid: gridEdges(width, height, passable, true), passable,
    land: new Uint8Array(passable.length), seed: 1995,
    units: [{ cell: source, type: movementType(name), facing: 64 },
      { cell: source + 1, type: movementType('MTNK'), facing: headOn ? 192 : 0 }],
  };
}
