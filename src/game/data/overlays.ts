// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.

export interface OverlayType { name: string; theater: boolean; wall: boolean; tiberium: boolean }
// Ported from ODATA.CPP, the OverlayTypeClass objects.
const rows: [string, boolean, boolean, boolean][] = [
  ["ROAD",false,false,false],
  ["CONC",false,false,false],
  ["SBAG",false,true,false],
  ["CYCL",false,true,false],
  ["BRIK",false,true,false],
  ["BARB",false,true,false],
  ["WOOD",false,true,false],
  ["TI1",true,false,true],
  ["TI2",true,false,true],
  ["TI3",true,false,true],
  ["TI4",true,false,true],
  ["TI5",true,false,true],
  ["TI6",true,false,true],
  ["TI7",true,false,true],
  ["TI8",true,false,true],
  ["TI9",true,false,true],
  ["TI10",true,false,true],
  ["TI11",true,false,true],
  ["TI12",true,false,true],
  ["SQUISH",false,false,false],
  ["V12",true,false,false],
  ["V13",true,false,false],
  ["V14",true,false,false],
  ["V15",true,false,false],
  ["V16",true,false,false],
  ["V17",true,false,false],
  ["V18",true,false,false],
  ["FPLS",false,false,false],
  ["WCRATE",false,false,false],
  ["SCRATE",false,false,false],
];
export const OVERLAYS: ReadonlyMap<string, OverlayType> = new Map(rows.map(
  ([name, theater, wall, tiberium]) => [name, { name, theater, wall, tiberium }],
));
