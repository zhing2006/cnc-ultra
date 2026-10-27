// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { MOVEMENT } from '../data/movement.ts';
import { BUILDINGS } from '../data/buildings.ts';
import * as U from './units-state.ts';

// Ported from BUILDING.CPP / FOOT.CPP / UNIT.CPP / AIRCRAFT.CPP, Sort_Y.
// Greatest_Threat scans Aircraft first, then the ground layer. We use the fully
// sorted current coordinates, not LAYER.CPP Sort's one bubble pass per frame.
export const TARGET_SORT_OFFSETS = MOVEMENT.map(type => {
  const building = BUILDINGS.get(type.name);
  if (building) return type.name === 'FIX' ? [-384, -384] : [0, ['PYLE', 'PROC'].includes(type.name) ? 0 : Math.trunc(building.height * 256 / 3)];
  return [0, type.infantry ? 48 : 128];
});
export function targetOrder(units: Int32Array, a: number, b: number) {
  if (b < 0) return -1;
  const aa = a * U.WORDS, bb = b * U.WORDS;
  const airA = units[aa + U.UDOMAIN] === 1, airB = units[bb + U.UDOMAIN] === 1;
  if (airA !== airB) return airA ? -1 : 1;
  if (airA) return a - b;
  const point = (at: number) => {
    const [x, y] = TARGET_SORT_OFFSETS[units[at + U.UTYPE]], flags = units[at + U.UFLAGS];
    const carrier=units[at+U.UENTER]-1,tethered=carrier>=0&&MOVEMENT[units[carrier*U.WORDS+U.UTYPE]].name==='APC'&&units[at+U.UDEST]===units[carrier*U.WORDS+U.UCELL];
    return [units[at] + x, units[at + 1] + (units[at + U.UKIND] && (tethered || (flags & U.UNLOADING)) ? 256 :
      MOVEMENT[units[at + U.UTYPE]].name === 'LST' && (flags & U.HOVER_TETHERED) ? -128 : y)];
  };
  const pa = point(aa), pb = point(bb);
  return pa[1] - pb[1] || pa[0] - pb[0] || a - b;
}
