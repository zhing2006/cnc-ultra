// Ported from CONST.CPP, the Remap* tables. Each table maps every index to itself except the 16
// unit colors from 176 on, so only those are kept.
const REMAP_START = 176;
const REMAP_COLORS = {
  yellow: null,
  red: [127, 126, 125, 124, 122, 46, 120, 47, 125, 124, 123, 122, 42, 121, 120, 120],
  blueGreen: [2, 119, 118, 135, 136, 138, 112, 12, 118, 135, 136, 137, 138, 139, 114, 112],
  orange: [24, 25, 26, 27, 29, 31, 46, 47, 26, 27, 28, 29, 30, 31, 43, 47],
  green: [5, 165, 166, 167, 159, 142, 140, 199, 166, 167, 157, 3, 159, 143, 142, 141],
  blue: [161, 200, 201, 202, 204, 205, 206, 12, 201, 202, 203, 204, 205, 115, 198, 114],
  none: null,
} as const;

export type RemapName = keyof typeof REMAP_COLORS;

/** Every remap table, in a fixed order. */
export const REMAP_NAMES = Object.keys(REMAP_COLORS) as RemapName[];

/** The full 256-entry remap table. */
export function remapTable(name: RemapName): Uint8Array {
  const table = Uint8Array.from({ length: 256 }, (_, index) => index);
  const colors = REMAP_COLORS[name];
  if (colors) table.set(colors, REMAP_START);
  return table;
}

// Ported from HDATA.CPP: the default remap table of each house. HouseClass::Remap_Table in HOUSE.CPP
// returns it for vehicles and infantry in single-player games.
const HOUSE_REMAPS: Record<string, RemapName> = {
  GoodGuy: 'yellow',
  BadGuy: 'blue',
  Neutral: 'none',
  Special: 'none',
  Multi1: 'blueGreen',
  Multi2: 'orange',
  Multi3: 'green',
  Multi4: 'blue',
  Multi5: 'yellow',
  Multi6: 'red',
};

/** The remap table name for a house's vehicles and infantry. House names compare without case. */
export function unitRemap(house: string): RemapName {
  const entry = Object.entries(HOUSE_REMAPS).find(([name]) => name.toUpperCase() === house.toUpperCase());
  if (!entry) throw new Error(`unknown house ${house}`);
  return entry[1];
}
