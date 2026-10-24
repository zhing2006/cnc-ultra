import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DATA_FILES } from '../data-files.ts';
import { MixFile, MixSet } from '../formats/mix.ts';
import { readScenario } from '../formats/scenario.ts';
import { templateLand, WALKABLE_LAND, buildableTemplate } from '../data/land.ts';
import { TEMPLATES } from '../data/templates.ts';
import { movementMap } from './map.ts';
import { bubbleGround, insertGround } from './ground.ts';

const assets = new URL('../../../assets/dev/', import.meta.url);

test('uses CDATA icon exceptions and keeps traversable beach separate from buildable ground', () => {
  // CDATA.CPP: River3's icon 7 uses LAND_CLEAR, all other icons use LAND_WATER.
  expect(templateLand('RV03', 0)).toBe(2);
  expect(templateLand('RV03', 7)).toBe(0);
  expect(buildableTemplate('RV03', 7)).toBe(true);
  expect(buildableTemplate('RV03', 0)).toBe(false);
  // CONST.CPP, Ground: LAND_BEACH permits foot/tracked movement but not construction.
  expect(WALKABLE_LAND[templateLand('SH1', 0)]).toBe(true);
  expect(buildableTemplate('SH1', 0)).toBe(false);
});

test('blocks occupied footprints, walls and rock overlays while leaving canopy and bib cells traversable', () => {
  const mix = new MixSet(DATA_FILES.map(name => new MixFile(readFileSync(new URL(name, assets)))));
  const scenario = readScenario(`[Map]\nX=1\nY=1\nWidth=14\nHeight=14\nTheater=Temperate\n[Terrain]\n130=T01,None\n[Structures]\n0=GoodGuy,NUKE,256,133,0,None\n[Overlay]\n200=V12\n202=BRIK\n`, new Uint8Array(8192).fill(255));
  const water = 8 * 64 + 9;
  scenario.templates[water] = TEMPLATES.findIndex(type => type.name === 'W1'); scenario.icons[water] = 0;
  const {passable, grid} = movementMap(mix, scenario);
  // TDATA.CPP, Tree1 occupies only (0,1), below its image origin.
  expect(passable[130]).toBe(1); expect(passable[194]).toBe(0);
  // BDATA.CPP, Power: (0,0), (0,1), (1,1). Its top-right corner and apron are not occupied.
  expect([passable[133],passable[197],passable[198]]).toEqual([0,0,0]);
  expect([passable[134],passable[261],passable[262]]).toEqual([1,1,1]);
  expect([passable[200],passable[202],passable[water],passable[0]]).toEqual([0,0,0,0]);
  // UNIT.CPP, Can_Enter_Cell ignores the facing argument: clear diagonal destinations remain legal.
  expect(grid.edges[132] & (1 << 1)).not.toBe(0);
});

test('performs only one original bubble sweep and inserts after equal Sort_Y keys', () => {
  const keys = new Int32Array([1,30, 1,20, 1,10, 1,20, 2,20]);
  const order = new Uint32Array([0,1,2,3]);
  bubbleGround(order, keys);
  expect(Array.from(order)).toEqual([1,2,3,0]);
  const inserted = Array.from(order); insertGround(inserted, keys, 4);
  expect(inserted).toEqual([1,2,3,4,0]);
});
