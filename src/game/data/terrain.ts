// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.

export interface TerrainType { name: string; baseX: number; baseY: number; occupy: readonly [number, number][] }
// Ported from TDATA.CPP, the TerrainTypeClass objects. Base offsets are in original image pixels.
const rows: [string, number, number, [number, number][]][] = [
  ["T01",11,41,[[0,1]]],
  ["T02",11,44,[[0,1]]],
  ["T03",12,45,[[0,1]]],
  ["T04",8,9,[[0,0]]],
  ["T05",15,41,[[0,1]]],
  ["T06",16,37,[[0,1]]],
  ["T07",15,41,[[0,1]]],
  ["T08",14,22,[[0,0]]],
  ["T09",11,22,[[0,0]]],
  ["T10",25,43,[[0,1],[1,1]]],
  ["T11",23,44,[[0,1],[1,1]]],
  ["T12",14,36,[[0,1]]],
  ["T13",19,40,[[0,1]]],
  ["T14",19,40,[[0,1],[1,1]]],
  ["T15",19,40,[[0,1],[1,1]]],
  ["T16",13,36,[[0,1]]],
  ["T17",18,44,[[0,1]]],
  ["T18",33,40,[[1,1]]],
  ["SPLIT2",18,44,[[0,1]]],
  ["SPLIT3",18,44,[[0,1]]],
  ["TC01",28,41,[[0,1],[1,1]]],
  ["TC02",38,41,[[1,0],[0,1],[1,1]]],
  ["TC03",33,35,[[0,0],[1,0],[0,1],[1,1]]],
  ["TC04",44,49,[[0,1],[1,1],[2,1],[0,2]]],
  ["TC05",49,58,[[2,0],[0,1],[1,1],[2,1],[1,2],[2,2]]],
  ["ROCK1",33,41,[[0,1],[1,1]]],
  ["ROCK2",24,23,[[0,0],[1,0]]],
  ["ROCK3",20,39,[[0,1],[1,1]]],
  ["ROCK4",12,20,[[0,0]]],
  ["ROCK5",17,19,[[0,0]]],
  ["ROCK6",28,40,[[0,1],[1,1],[2,1]]],
  ["ROCK7",57,22,[[0,0],[1,0],[2,0],[3,0]]],
];
export const TERRAIN: ReadonlyMap<string, TerrainType> = new Map(rows.map(
  ([name, baseX, baseY, occupy]) => [name, { name, baseX, baseY, occupy }],
));
