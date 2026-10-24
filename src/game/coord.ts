// Coordinates, facings and the integer trigonometry of the original. A position is kept as separate
// x and y lepton values instead of a packed COORDINATE, so that maps can be larger than 64 × 64 cells
// (technical constitution, article 17).

/** Leptons per cell side (CELL_LEPTON_W in DEFINES.H). */
export const CELL_LEPTONS = 256;
/** Pixels per cell side (ICON_PIXEL_W in DEFINES.H). */
export const CELL_PIXELS = 24;

/** Ported from FUNCTION.H, Lepton_To_Pixel. */
export function leptonToPixel(lepton: number): number {
  return Math.floor((lepton * CELL_PIXELS + CELL_LEPTONS / 2) / CELL_LEPTONS);
}

/** Ported from FUNCTION.H, Pixel_To_Lepton. */
export function pixelToLepton(pixel: number): number {
  return Math.floor((pixel * CELL_LEPTONS + CELL_PIXELS / 2) / CELL_PIXELS);
}

/** Ported from CONST.CPP, Facing32: a 256-step direction to one of 32 facings. */
const FACING32 = [
  0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2,
  2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 6, 6,
  6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8,
  8, 8, 8, 9, 9, 9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 10,
  10, 11, 11, 11, 11, 11, 11, 11, 12, 12, 12, 12, 12, 12, 12, 12,
  13, 13, 13, 13, 13, 13, 13, 13, 14, 14, 14, 14, 14, 14, 14, 14,
  14, 15, 15, 15, 15, 15, 15, 15, 15, 15, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 17, 17, 17, 17, 17, 17, 17, 17, 17, 18, 18,
  18, 18, 18, 18, 18, 18, 18, 19, 19, 19, 19, 19, 19, 19, 19, 19,
  19, 20, 20, 20, 20, 20, 20, 21, 21, 21, 21, 21, 21, 21, 22, 22,
  22, 22, 22, 22, 22, 23, 23, 23, 23, 23, 23, 23, 24, 24, 24, 24,
  24, 24, 24, 25, 25, 25, 25, 25, 25, 25, 26, 26, 26, 26, 26, 26,
  26, 27, 27, 27, 27, 27, 27, 27, 28, 28, 28, 28, 28, 28, 28, 28,
  29, 29, 29, 29, 29, 29, 29, 29, 30, 30, 30, 30, 30, 30, 30, 30,
  30, 31, 31, 31, 31, 31, 31, 31, 31, 31, 0, 0, 0, 0, 0, 0,
];

export function facingTo32(dir: number): number {
  return FACING32[dir & 0xff];
}

/** Ported from FUNCTION.H, Dir_Facing: a 256-step direction to one of the 8 facings. */
export function dirFacing(dir: number): number {
  return ((dir + 0x10) & 0xff) >> 5;
}

/** Ported from FUNCTION.H, Facing_Dir. */
export function facingDir(facing: number): number {
  return (facing << 5) & 0xff;
}

/** Ported from TECHNO.CPP, TechnoClass::BodyShape: a 32-step facing to a vehicle body frame. */
export const BODY_SHAPE = [
  0, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
];

/** Ported from INFANTRY.CPP, InfantryClass::HumanShape: a 32-step facing to one of 8 infantry facings. */
export const HUMAN_SHAPE = [
  0, 0, 7, 7, 7, 7, 6, 6, 6, 6, 5, 5, 5, 5, 5, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 0,
];

/** Ported from UNIT.CPP, Turret_Adjust: where the rocket launchers' turret sits for each body facing. */
const TURRET_ADJUST: [number, number][] = [
  [1, 2], [-1, 1], [-2, 0], [-3, 0], [-3, 1], [-4, -1], [-4, -1], [-5, -2],
  [-5, -3], [-5, -3], [-3, -3], [-3, -4], [-3, -4], [-3, -5], [-2, -5], [-1, -5],
  [0, -5], [1, -6], [2, -5], [3, -5], [4, -5], [6, -4], [6, -3], [6, -3],
  [6, -3], [5, -1], [5, -1], [4, 0], [3, 0], [2, 0], [2, 1], [1, 2],
];

export function turretAdjust(dir: number): [number, number] {
  return TURRET_ADJUST[facingTo32(dir)];
}

// Ported from COORD.CPP, Move_Point, in the remaster's source: the tables are signed bytes.
const COS_TABLE = signed([
  0x00, 0x03, 0x06, 0x09, 0x0c, 0x0f, 0x12, 0x15, 0x18, 0x1b, 0x1e, 0x21, 0x24, 0x27, 0x2a, 0x2d,
  0x30, 0x33, 0x36, 0x39, 0x3b, 0x3e, 0x41, 0x43, 0x46, 0x49, 0x4b, 0x4e, 0x50, 0x52, 0x55, 0x57,
  0x59, 0x5b, 0x5e, 0x60, 0x62, 0x64, 0x65, 0x67, 0x69, 0x6b, 0x6c, 0x6e, 0x6f, 0x71, 0x72, 0x74,
  0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7b, 0x7c, 0x7d, 0x7d, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e,
  0x7f, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7d, 0x7d, 0x7c, 0x7b, 0x7b, 0x7a, 0x79, 0x78, 0x77, 0x76,
  0x75, 0x74, 0x72, 0x71, 0x70, 0x6e, 0x6c, 0x6b, 0x69, 0x67, 0x66, 0x64, 0x62, 0x60, 0x5e, 0x5b,
  0x59, 0x57, 0x55, 0x52, 0x50, 0x4e, 0x4b, 0x49, 0x46, 0x43, 0x41, 0x3e, 0x3b, 0x39, 0x36, 0x33,
  0x30, 0x2d, 0x2a, 0x27, 0x24, 0x21, 0x1e, 0x1b, 0x18, 0x15, 0x12, 0x0f, 0x0c, 0x09, 0x06, 0x03,
  0x00, 0xfd, 0xfa, 0xf7, 0xf4, 0xf1, 0xee, 0xeb, 0xe8, 0xe5, 0xe2, 0xdf, 0xdc, 0xd9, 0xd6, 0xd3,
  0xd0, 0xcd, 0xca, 0xc7, 0xc5, 0xc2, 0xbf, 0xbd, 0xba, 0xb7, 0xb5, 0xb2, 0xb0, 0xae, 0xab, 0xa9,
  0xa7, 0xa5, 0xa2, 0xa0, 0x9e, 0x9c, 0x9a, 0x99, 0x97, 0x95, 0x94, 0x92, 0x91, 0x8f, 0x8e, 0x8c,
  0x8b, 0x8a, 0x89, 0x88, 0x87, 0x86, 0x85, 0x85, 0x84, 0x83, 0x83, 0x82, 0x82, 0x82, 0x82, 0x82,
  0x82, 0x82, 0x82, 0x82, 0x82, 0x82, 0x83, 0x83, 0x84, 0x85, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a,
  0x8b, 0x8c, 0x8e, 0x8f, 0x90, 0x92, 0x94, 0x95, 0x97, 0x99, 0x9a, 0x9c, 0x9e, 0xa0, 0xa2, 0xa5,
  0xa7, 0xa9, 0xab, 0xae, 0xb0, 0xb2, 0xb5, 0xb7, 0xba, 0xbd, 0xbf, 0xc2, 0xc5, 0xc7, 0xca, 0xcd,
  0xd0, 0xd3, 0xd6, 0xd9, 0xdc, 0xdf, 0xe2, 0xe5, 0xe8, 0xeb, 0xee, 0xf1, 0xf4, 0xf7, 0xfa, 0xfd,
]);
// The sine table is the cosine table shifted by a quarter turn.
const SIN_TABLE = COS_TABLE.map((_, dir) => COS_TABLE[(dir + 64) & 0xff]);

function signed(bytes: number[]): number[] {
  return bytes.map((value) => (value << 24) >> 24);
}

/**
 * Moves a point by distance leptons in a 256-step direction. Ported from COORD.CPP, Move_Point, and
 * its helpers calcx and calcy: each step is the table value times the distance, shifted right by 7,
 * and y grows southward. The original keeps x and y in 16 bits, which the larger maps cannot.
 */
export function movePoint(x: number, y: number, dir: number, distance: number): [number, number] {
  return [x + ((COS_TABLE[dir & 0xff] * distance) >> 7), y - ((SIN_TABLE[dir & 0xff] * distance) >> 7)];
}

/** Ported from MiscAsm.cpp, Distance_Coord: the larger axis distance plus half the smaller one. */
export function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return Math.max(dx, dy) + (Math.min(dx, dy) >> 1);
}

/** Ported from MiscAsm.cpp, Desired_Facing256: the 256-step direction from one point to another. */
export function desiredFacing256(srcX: number, srcY: number, dstX: number, dstY: number): number {
  let quadrant = 0;
  let dx = dstX - srcX;
  if (dx < 0) {
    dx = -dx;
    quadrant = 0xc0;
  }
  let dy = srcY - dstY;
  if (dy < 0) {
    quadrant ^= 0x40;
    dy = -dy;
  }
  let add = (quadrant & 0x40) ^ 0x40;
  // Keep the larger delta in large and the smaller in small.
  let small = dy;
  let large = dx;
  if (small >= large) {
    [small, large] = [large, small];
    add ^= 0x40;
  }
  if (!(small & 0xffffff00)) {
    while (large & 0xffffff00) {
      large >>>= 1;
      small >>>= 1;
    }
  }
  let angle = large === 0 ? 0xffffffff : Math.floor((small * 256) / large);
  angle >>>= 3;
  if (add) angle = 63 - angle;
  return (angle + quadrant) & 0xff;
}

/**
 * Moves a w × h rectangle at (x, y) so that it lies inside a width × height area, and reports whether
 * it had to. Ported from CLIPRECT.ASM, Confine_Rect, in the Nyerguds fork's library, including its
 * quirk of reporting a shift for a rectangle that already touches the left or top edge.
 */
export function confineRect(x: number, y: number, w: number, h: number, width: number, height: number) {
  let shifted = false;
  if (!(-x < 0 && x + w - width - 1 < 0)) {
    shifted = true;
    x = -x < 0 ? width - w : 0;
  }
  if (!(-y < 0 && y + h - height - 1 < 0)) {
    shifted = true;
    y = -y < 0 ? height - h : 0;
  }
  return { x, y, shifted };
}
