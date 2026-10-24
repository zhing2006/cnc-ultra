export const UNREACHABLE = 0x3fffffff;
export const FLOW_PASSES = 32;
export const UNIT_WORDS = 12;
export const X = 0, Y = 1, CELL = 2, DEST = 3, SLOT = 4, DEST_SLOT = 5, PROGRESS = 6, LENGTH = 7, SPEED = 8, KIND = 9;
export const FRAME = 0, SEED = 1, TARGET = 2, READY = 3;
export const DIRECTIONS: readonly (readonly [number, number])[] = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
export interface Grid {
  width: number;
  height: number;
  /** Eight outgoing edge bits per cell. Game adapters determine terrain and corner legality. */
  edges: Uint32Array;
}
export interface UnitStart { cell: number; speed: number; kind?: number; slot?: number }
export interface SimulationSetup { grid: Grid; units: readonly UnitStart[]; seed: number; spots: readonly (readonly [number, number])[] }
export interface MoveCommand { frame: number; target: number }
export function unitState(setup: SimulationSetup): Int32Array {
  const result = new Int32Array(setup.units.length * UNIT_WORDS);
  setup.units.forEach((unit, id) => {
    const i = id * UNIT_WORDS, slot = unit.slot ?? 0;
    const [x, y] = setup.spots[slot];
    result.set([(unit.cell % setup.grid.width) * 256 + x, Math.floor(unit.cell / setup.grid.width) * 256 + y,
      unit.cell, -1, slot, slot, 0, 0, unit.speed, unit.kind ?? 0, 0, 0], i);
  });
  return result;
}

/** Generic eight-connected grid, with an explicit choice of whether corners restrict diagonal steps. */
export function gridEdges(width: number, height: number, passable: Uint8Array, cutCorners = false): Grid {
  const edges = new Uint32Array(width * height);
  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && !!passable[y * width + x];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (open(x, y)) {
    DIRECTIONS.forEach(([dx, dy], d) => {
      if (open(x + dx, y + dy) && (cutCorners || !dx || !dy || (open(x + dx, y) && open(x, y + dy)))) edges[y * width + x] |= 1 << d;
    });
  }
  return { width, height, edges };
}
