import type { Grid } from '../../engine/simulation/state.ts';
import { MOVEMENT } from '../data/movement.ts';
import { INFANTRY_SPOTS } from './map.ts';
export const WORDS = 28;
export const UX = 0;
export const UY = 1;
export const UCELL = 2;
export const UDEST = 3;
export const USLOT = 4;
export const UDSLOT = 5;
export const UTRACK_STEP = 6;
export const UTRACK = 7;
export const UACCUM = 8;
export const UKIND = 9;
export const UFACE = 10;
export const UDESIRED = 11;
export const UTYPE = 12;
export const UHEALTH = 13;
export const UJUMP = 14;
export const UJUMP_TRACK = 15;
export const UWAIT = 16;
export const UWALK = 17;
export const UOWNER = 18;
export const UHEAD_X = 19;
export const UHEAD_Y = 20;
export const UMIDDLE = 21;
export const USPEED = 22;
export const URETRIES = 23;
export const USTARTED = 24;
export const UROTATED = 25;
export const UROUTE = 26;
export const USTALLED = 27;
export interface UnitPlacement {
  cell: number;
  type: number;
  facing?: number;
  slot?: number;
  owner?: number;
  health?: number;
}
export interface UnitsSetup {
  grid: Grid;
  land: Uint8Array;
  passable?: Uint8Array;
  units: readonly UnitPlacement[];
  seed: number;
}
export interface UnitCommand {
  frame: number;
  kind: 'move' | 'stop' | 'scatter';
  target?: number;
  /** Local selection is resolved when recording the command, outside the simulation. */
  ids: readonly number[];
}
export function initialUnits(setup: UnitsSetup) {
  const result = new Int32Array(setup.units.length * WORDS);
  setup.units.forEach((placed, id) => {
    const at = id * WORDS;
    const type = MOVEMENT[placed.type];
    const slot = placed.slot ?? 0;
    result[at + UX] = placed.cell % setup.grid.width * 256 + INFANTRY_SPOTS[slot][0];
    result[at + UY] = Math.floor(placed.cell / setup.grid.width) * 256 + INFANTRY_SPOTS[slot][1];
    result[at + UCELL] = placed.cell;
    result[at + UDEST] = -1;
    result[at + USLOT] = slot;
    result[at + UDSLOT] = slot;
    result[at + UTRACK] = -1;
    result[at + UKIND] = type.infantry;
    result[at + UFACE] = placed.facing ?? 0;
    result[at + UDESIRED] = result[at + UFACE];
    result[at + UTYPE] = placed.type;
    result[at + UHEALTH] = placed.health ?? type.strength;
    result[at + UJUMP] = -1;
    result[at + UJUMP_TRACK] = -1;
    result[at + UROUTE] = -1;
    result[at + UOWNER] = placed.owner ?? 0;
    result[at + UMIDDLE] = -1;
    result[at + URETRIES] = 10;
  });
  return result;
}
