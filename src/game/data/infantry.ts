/** A choreography entry from an infantry DO table: first frame, frame count and frames per facing. */
export interface DoControl {
  frame: number;
  count: number;
  jump: number;
}

/** What drawing an infantry type needs. The shape file is the INI name plus ".SHP". */
export interface InfantryType {
  name: string;
  /** The DO_STAND_READY entry, which an infantry that is doing nothing is drawn with. */
  standReady: DoControl;
}

// Ported from IDATA.CPP: the InfantryTypeClass objects and the DO_STAND_READY row of the DO table
// each of them points to.
const rows: [string, number, number, number][] = [
  ['E1', 0, 1, 1],
  ['E2', 0, 1, 1],
  ['E3', 0, 1, 1],
  ['E4', 0, 1, 1],
  ['E5', 0, 1, 1],
  ['E6', 0, 1, 1],
  ['RMBO', 0, 1, 1],
  ['C1', 0, 1, 1],
  ['C2', 0, 1, 1],
  ['C3', 0, 1, 1],
  ['C4', 0, 1, 1],
  ['C5', 0, 1, 1],
  ['C6', 0, 1, 1],
  ['C7', 0, 1, 1],
  ['C8', 0, 1, 1],
  ['C9', 0, 1, 1],
  ['C10', 0, 1, 1],
  ['MOEBIUS', 0, 1, 1],
  ['DELPHI', 0, 1, 1],
  ['CHAN', 0, 1, 1],
];

export const INFANTRY: ReadonlyMap<string, InfantryType> = new Map(rows.map(([name, frame, count, jump]) => [
  name, { name, standReady: { frame, count, jump } },
]));
