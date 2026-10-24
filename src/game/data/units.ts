/** What drawing a vehicle needs from its type. The shape file is the INI name plus ".SHP". */
export interface UnitType {
  name: string;
  /** A turret is drawn on top of the body, from frame 32 on (UnitClass::Draw_It). */
  turret: boolean;
  /** Eight-facing units, the dinosaurs (IsPieceOfEight). */
  eight: boolean;
  /** Units with only a few body facings, the hovercraft and the gunboat (IsChunkyShape). */
  chunky: boolean;
  /** A rotating radar dish is drawn on top, from frame 32 on (IsRadarEquipped). */
  radar: boolean;
  /** The body frame is the animation stage instead of the facing (IsAnimating). */
  animating: boolean;
}

// Ported from UDATA.CPP, the UnitTypeClass objects. Only the flags that drawing uses are kept.
const rows: [string, boolean, boolean, boolean, boolean, boolean][] = [
  // name, turret, eight, chunky, radar, animating
  ['VICE', false, false, false, false, true],
  ['FTNK', false, false, false, false, false],
  ['STNK', false, false, false, false, false],
  ['LTNK', true, false, false, false, false],
  ['MTNK', true, false, false, false, false],
  ['HTNK', true, false, false, false, false],
  ['MHQ', false, false, false, true, false],
  ['LST', false, false, true, false, false],
  ['MLRS', true, false, false, false, false],
  ['ARTY', false, false, false, false, false],
  ['HARV', false, false, false, false, false],
  ['MCV', false, false, false, false, false],
  ['JEEP', true, false, false, false, false],
  ['BGGY', true, false, false, false, false],
  ['BIKE', false, false, false, false, false],
  ['MSAM', true, false, false, false, false],
  ['APC', false, false, false, false, false],
  ['BOAT', true, false, true, false, false],
  ['TRIC', false, true, false, false, false],
  ['TREX', false, true, false, false, false],
  ['RAPT', false, true, false, false, false],
  ['STEG', false, true, false, false, false],
];

export const UNITS: ReadonlyMap<string, UnitType> = new Map(rows.map(([name, ...flags]) => {
  const [turret, eight, chunky, radar, animating] = flags;
  return [name, { name, turret, eight, chunky, radar, animating }];
}));
