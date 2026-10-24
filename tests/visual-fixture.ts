import { readScenario } from '../src/game/formats/scenario.ts';

/** Objects whose sort coordinates differ from their image origins (original Sort_Y functions). */
export function overlapFixture() {
  return readScenario(`[Map]
X=0
Y=0
Width=16
Height=16
Theater=Temperate
[Terrain]
328=T01,None
[Units]
0=GoodGuy,MTNK,256,328,0,Guard,None
[Infantry]
0=GoodGuy,E1,256,392,0,Guard,0,None
[Structures]
0=BadGuy,PROC,256,263,0,None
1=BadGuy,GUN,256,329,0,None
`, new Uint8Array(8192).fill(255));
}

// In leptons: refinery (2176,1408), gun (2432,1493), tank (2176,1536),
// infantry (2176,1712), tree (2165,1717). Building/Unit/Foot/TerrainClass::Sort_Y.
export const OVERLAP_ORDER = ['building:263:PROC', 'building:329:GUN', 'unit:328:MTNK', 'infantry:392:E1', 'terrain:328:T01'];
