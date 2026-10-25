// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { DIRECTIONS, UNREACHABLE } from '../../engine/simulation/state.ts';
import { distance } from '../coord.ts';
import { GROUND_SPEED, MOVEMENT } from '../data/movement.ts';
import * as S from './units-state.ts';

// Ported from FOOT.CPP, FootClass::Basic_Path, and FOOT.H.
export const DESTINATION_NEIGHBORS = [0, 1, -1, 2, -2, 3, -3, 4];
export const PATH_DELAY = 15;

/** Ported from FACING8.ASM, Desired_Facing8 (the library in the Nyerguds reference). */
export function cellFacing(from: number, to: number, width: number) {
  const dx = to % width - from % width;
  const dy = Math.floor(to / width) - Math.floor(from / width);
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.min(ax, ay) < ((Math.max(ax, ay) + 1) >> 1))
    return ax >= ay ? (dx < 0 ? 6 : 2) : (dy < 0 ? 0 : 4);
  return dx < 0 ? (dy > 0 ? 5 : 7) : (dy > 0 ? 3 : 1);
}

/** FINDPATH.CPP Find_Path preserves a reachable prefix when the final open region is sealed. */
export function reachablePrefix(setup:S.UnitsSetup,source:number,goal:number,distances:Int32Array,base:number){
  let cursor=source,prefix=source;
  for(let step=0;step<Math.max(setup.grid.width,setup.grid.height)&&cursor!==goal;step++){
    const [dx,dy]=DIRECTIONS[cellFacing(cursor,goal,setup.grid.width)];cursor+=dy*setup.grid.width+dx;
    if(distances[base+cursor]<UNREACHABLE)prefix=cursor;
  }
  return prefix===source?-1:prefix;
}

/** Ported from FOOT.CPP, Basic_Path. NavCom remains the clicked cell. */
export function pathDestination(setup: S.UnitsSetup, units: Int32Array, occupancy: Int32Array, id: number, goal: number) {
  const at = id * S.WORDS, type = MOVEMENT[units[at + S.UTYPE]], { width, height, edges } = setup.grid;
  const open = (cell: number) => !!(setup.passable ? setup.passable[cell] : edges[cell])
    && GROUND_SPEED[setup.land[cell]][type.locomotion] !== 0;
  const x = goal % width, y = Math.floor(goal / width);
  if (open(goal)) return goal;
  const source = Math.floor(units[at + 1] / 256) * width + Math.floor(units[at] / 256);
  const facing = cellFacing(goal, source, width);
  if (distance(units[at], units[at + 1], x * 256 + 128, y * 256 + 128) > 0x300) for (const offset of DESTINATION_NEIGHBORS) {
    const [dx, dy] = DIRECTIONS[(facing + offset + 8) & 7], xx = x + dx, yy = y + dy;
    if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
    const cell = yy * width + xx;
    if (!open(cell)) continue;
    let free = 0;
    for (let slot = 0; slot < 5; slot++) if (!occupancy[cell * 5 + slot] || occupancy[cell * 5 + slot] === id + 1) free++;
    if (free === 5 || (type.infantry && free)) return cell;
  }
  // FINDPATH.CPP, Find_Path: look through intermediate obstacles before ending the
  // prefix at the obstacle containing the destination. The flow field supplies
  // the route around those intermediate obstacles instead of Follow_Edge.
  let cursor = source, prefix = source;
  for (let step = 0; step < Math.max(width, height); step++) {
    const [dx, dy] = DIRECTIONS[cellFacing(cursor, goal, width)];
    cursor += dy * width + dx;
    if (cursor === goal) break;
    if (open(cursor)) prefix = cursor;
  }
  return prefix === source ? goal : prefix;
}
