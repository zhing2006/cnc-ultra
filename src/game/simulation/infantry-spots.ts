// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { desiredFacing256, distance, movePoint } from '../coord.ts';

// Ported from CELL.CPP, CellClass::Closest_Free_Spot.
export const SPOT_SEQUENCE = [[1, 2, 3, 4], [0, 2, 3, 4], [0, 1, 4, 3], [0, 1, 4, 2], [0, 2, 3, 1]];

/** Ported from INFANTRY.CPP, Start_Driver, and CELL.CPP, Spot_Index. */
export function entryPoint(x: number, y: number, targetX: number, targetY: number) {
  // Adjacent_Cell(Coord, Path[0]) retains the starting subcell coordinates.
  targetX = (targetX & ~255) + (x & 255); targetY = (targetY & ~255) + (y & 255);
  const direction = (desiredFacing256(x, y, targetX, targetY) + 128) & 255;
  return movePoint(targetX, targetY, direction, 0x7c);
}

export function entrySpot(x: number, y: number, targetX: number, targetY: number) {
  const point = entryPoint(x, y, targetX, targetY);
  const xx = point[0] & 255, yy = point[1] & 255;
  return distance(xx, yy, 128, 128) < 60 ? 0 : 1 + (xx > 128 ? 1 : 0) + (yy > 128 ? 2 : 0);
}

/** Ported from CELL.CPP, Closest_Free_Spot; the center uses one of four cyclic alternatives. */
export function freeSpot(mask: number, preferred: number, random: number) {
  if (mask & (1 << preferred)) return preferred;
  const sequence = preferred ? SPOT_SEQUENCE[preferred] : Array.from({ length: 4 }, (_, i) => 1 + ((i + random) & 3));
  return sequence.find(slot => mask & (1 << slot)) ?? -1;
}
