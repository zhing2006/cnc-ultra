import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DATA_FILES } from './data-files.ts';
import { MixFile, MixSet } from './formats/mix.ts';
import { readScenario, type Scenario } from './formats/scenario.ts';
import { decodeIconSet } from './formats/icons.ts';
import { NO_TILE } from '../engine/indexed/pipeline.ts';
import { BUILDINGS } from './data/buildings.ts';
import { buildingFrame, buildingPosition, initialCellImages } from './map-visuals.ts';
import { buildScene } from './scene.ts';
import { PaletteCycle } from './palette-cycle.ts';
import { initialZoom, zoomOrigin } from './zoom.ts';
import { overlapFixture, OVERLAP_ORDER } from '../../tests/visual-fixture.ts';

const mix = new MixSet(DATA_FILES.map(name => new MixFile(readFileSync(new URL(`../../assets/dev/${name}`, import.meta.url)))));

test('scg08eb retains every terrain object and structure, including overlapping village buildings', () => {
  const scene = buildScene(mix, 'SCG08EB');
  expect(scene.scenario.terrain).toHaveLength(64);
  expect(scene.scenario.buildings).toHaveLength(38);
  expect(scene.objects.filter(object => object.key.startsWith('terrain:'))).toHaveLength(64);
  expect(scene.objects.filter(object => object.key.startsWith('building:'))).toHaveLength(38);
  expect(scene.objects.some(object => object.key === 'building:3660:V02')).toBe(true);
  expect(scene.objects.some(object => object.key === 'building:3660:V11')).toBe(true);
});

test.each([false, true])('overlapping objects retain original coordinates with omitted storage dimensions: %s', (omitted) => {
  const scenario = overlapFixture();
  expect([scenario.mapWidth, scenario.mapHeight]).toEqual([64, 64]);
  if (omitted) {
    delete scenario.mapWidth;
    delete scenario.mapHeight;
  }
  const scene = buildScene(mix, scenario);
  expect([scene.setup.tiles.columns, scene.setup.tiles.rows, scene.setup.tiles.cells.length]).toEqual([64, 64, 4096]);
  expect(scene.objects.map(object => object.key)).toEqual(OVERLAP_ORDER);
  // The refinery is a 72×72 centered shape; terrain draws from its top-left without SHAPE_CENTER.
  const first = scene.sprites[scene.objects[0].first];
  const last = scene.sprites[scene.objects[4].first];
  expect([first.x, first.y, first.region.width, first.region.height]).toEqual([168, 96, 72, 72]);
  expect([last.x, last.y]).toEqual([192, 120]);
});

test('wall connections, tiberium density and foundation smudges follow initial placement rules', () => {
  const scenario = readScenario(`[Map]
X=0
Y=0
Width=20
Height=20
Theater=Temperate
[Structures]
0=GoodGuy,NUKE,256,130,0,None
[Smudge]
0=SC1,194,0
1=CR1,400,3
2=CR1,400,0
[Overlay]
650=TI1
651=TI1
586=TI1
587=TI1
800=WOOD
801=WOOD
864=WOOD
736=BRIK
`, new Uint8Array(8192).fill(255));
  const { smudges, overlays } = initialCellImages(scenario);
  expect(smudges.filter(image => image.type === 'BIB3')).toEqual([
    { type: 'BIB3', cell: 194, frame: 0 }, { type: 'BIB3', cell: 195, frame: 1 },
    { type: 'BIB3', cell: 258, frame: 2 }, { type: 'BIB3', cell: 259, frame: 3 },
  ]);
  expect(smudges.find(image => image.cell === 400)).toEqual({ type: 'CR1', cell: 400, frame: 4 });
  expect(overlays.find(image => image.cell === 650)?.frame).toBe(4); // Three of eight neighbors: _adj[3].
  expect(overlays.find(image => image.cell === 800)?.frame).toBe(6); // East and south; different north wall does not join.
});

function largeScenario(): Scenario {
  return {
    theater: 'TEMPERATE', mapWidth: 512, mapHeight: 256,
    x: 0, y: 0, width: 512, height: 256,
    templates: new Uint8Array(512 * 256), icons: new Uint8Array(512 * 256),
    units: [], infantry: [], aircraft: [], buildings: [], terrain: [], overlays: [], smudges: [],
    waypoints: new Map(),
  };
}

test('a rectangular supplied scene retains far-right and bottom tiles and every object coordinate', () => {
  const scenario = largeScenario();
  // The playable rectangle is deliberately smaller than storage, but reaches its bottom-right.
  Object.assign(scenario, { x: 2, y: 3, width: 510, height: 253 });
  scenario.icons[3 * 512 + 511] = 1;
  scenario.icons[255 * 512 + 511] = 2;
  const unit = { house: 'GoodGuy', strength: 256, facing: 0, mission: 'Guard' };
  scenario.units = [{ ...unit, type: 'MTNK', cell: 250 * 512 + 500 }];
  scenario.infantry = [{ ...unit, type: 'E1', cell: 251 * 512 + 501, spot: 4 }];
  scenario.aircraft = [{ ...unit, type: 'ORCA', cell: 252 * 512 + 502 }];
  scenario.terrain = [{ type: 'T01', cell: 253 * 512 + 503 }];
  scenario.buildings = [{ ...unit, type: 'PROC', cell: 250 * 512 + 505 }];
  scenario.smudges = [{ type: 'SC1', cell: 254 * 512 + 509, frame: 0 }];
  scenario.overlays = [{ type: 'WOOD', cell: 255 * 512 + 511 }];
  const scene = buildScene(mix, scenario);
  const tiles = scene.setup.tiles;
  expect([tiles.columns, tiles.rows, tiles.cells.length]).toEqual([512, 256, 131072]);
  expect(scene.home).toBe(3 * 512 + 2);
  expect(tiles.cells[3 * 512 + 1]).toBe(NO_TILE);
  expect(tiles.cells[2 * 512 + 511]).toBe(NO_TILE);
  // First-encounter order: CLEAR1 icons 0, 1, then 2. No 64-column aliasing or lost final row.
  expect(tiles.cells[3 * 512 + 2]).toBe(0);
  expect(tiles.cells[3 * 512 + 511]).toBe(1);
  expect(tiles.cells[255 * 512 + 511]).toBe(2);
  const clear = decodeIconSet(mix.require('CLEAR1.TEM'));
  for (const id of [0, 1, 2]) {
    for (let row = 0; row < 24; row++) {
      const offset = row * tiles.atlas.width + id * 24;
      expect([...tiles.atlas.pixels.slice(offset, offset + 24)]).toEqual([...clear.icons[clear.map[id]].slice(row * 24, row * 24 + 24)]);
    }
  }
  const object = (key: string) => scene.objects.find(object => object.key === key)!;
  const sprite = (key: string, index = 0) => scene.sprites[object(key).first + index];
  const center = (key: string, index = 0) => {
    const image = sprite(key, index);
    return [image.x + Math.floor(image.region.width / 2), image.y + Math.floor(image.region.height / 2)];
  };
  // UNIT.CPP: cell center; INFANTRY.CPP: lower-right spot, shifted left 2 and down 4.
  const tank = `unit:${250 * 512 + 500}:MTNK`;
  expect(center(tank)).toEqual([500 * 24 + 12, 250 * 24 + 12]);
  expect(object(tank)).toMatchObject({ sortX: 500 * 256 + 128, sortY: 251 * 256 });
  const infantry = `infantry:${251 * 512 + 501}:E1`;
  expect(center(infantry)).toEqual([501 * 24 + 18 - 2, 251 * 24 + 18 + 4]);
  expect(object(infantry)).toMatchObject({ sortX: 501 * 256 + 192, sortY: 251 * 256 + 192 + 48 });
  // AIRCRAFT.CPP: parked body at cell center, shadow offset by (1, 2).
  const aircraft = `aircraft:${252 * 512 + 502}:ORCA`;
  expect(center(aircraft)).toEqual([502 * 24 + 13, 252 * 24 + 14]);
  expect(center(aircraft, 1)).toEqual([502 * 24 + 12, 252 * 24 + 12]);
  const tree = sprite(`terrain:${253 * 512 + 503}:T01`);
  expect([tree.x, tree.y]).toEqual([503 * 24, 253 * 24]);
  // BDATA.CPP / BUILDING.CPP: PROC is 3 by 3, with CenterOffset (384, 384) and no Sort_Y bias.
  const refinery = `building:${250 * 512 + 505}:PROC`;
  expect(center(refinery)).toEqual([505 * 24 + 36, 250 * 24 + 36]);
  expect(object(refinery)).toMatchObject({ sortX: 505 * 256 + 384, sortY: 250 * 256 + 384 });
  expect(buildingPosition(scenario.buildings[0], BUILDINGS.get('PROC')!, 512)).toEqual({
    centerX: 505 * 256 + 384, centerY: 250 * 256 + 384,
    sortX: 505 * 256 + 384, sortY: 250 * 256 + 384,
  });
  // Cell graphics precede objects. Foundation bibs precede the explicitly placed scorch.
  const ground = scene.sprites.slice(0, scene.objects[0].first);
  const scorch = ground[ground.length - 2], wall = ground[ground.length - 1];
  expect([scorch.x, scorch.y]).toEqual([509 * 24, 254 * 24]);
  expect([wall.x + Math.floor(wall.region.width / 2), wall.y + Math.floor(wall.region.height / 2)])
    .toEqual([511 * 24 + 12, 255 * 24 + 12]);
});

test('rectangular storage neighbors connect at large coordinates without wrapping edges', () => {
  const scenario = largeScenario();
  const cell = (x: number, y: number) => y * 512 + x;
  scenario.overlays = [
    ...[[511, 100], [511, 101], [510, 100], [0, 101], [0, 0], [0, 255]].map(([x, y]) => ({ type: 'WOOD', cell: cell(x, y) })),
    ...[[500, 200], [501, 200], [500, 201], [501, 201], [511, 230], [0, 231], [500, 255], [501, 255]]
      .map(([x, y]) => ({ type: 'TI1', cell: cell(x, y) })),
  ];
  // TDATA.CPP: T10 occupies (0,1) and (1,1), so its second spot must not wrap.
  scenario.terrain = [{ type: 'T10', cell: cell(511, 220) }];
  scenario.overlays.push({ type: 'TI1', cell: cell(511, 221) }, { type: 'TI1', cell: cell(0, 222) });
  scenario.smudges = [{ type: 'BIB3', cell: cell(511, 255), frame: 0 }];
  const { smudges, overlays } = initialCellImages(scenario);
  const at = (x: number, y: number) => overlays.find(image => image.cell === cell(x, y));
  expect(at(511, 100)?.frame).toBe(12); // CELL.CPP, Wall_Update: south=4, west=8.
  expect(at(511, 101)?.frame).toBe(1); // North only.
  expect(at(510, 100)?.frame).toBe(2); // East only.
  for (const [x, y] of [[0, 101], [0, 0], [0, 255]]) expect(at(x, y)?.frame).toBe(0);
  expect(at(500, 200)?.frame).toBe(4); // CELL.CPP, Tiberium_Adjust: _adj[3].
  expect(at(501, 201)?.frame).toBe(4);
  expect(at(511, 230)?.frame).toBe(0);
  expect(at(0, 231)?.frame).toBe(0);
  // MAP.CPP, Overpass skips the last playable row: keep density at insertion time and TI1.
  expect(at(500, 255)).toEqual({ type: 'TI1', cell: cell(500, 255), frame: 0 });
  expect(at(501, 255)).toEqual({ type: 'TI1', cell: cell(501, 255), frame: 1 });
  expect(at(511, 221)).toBeUndefined();
  expect(at(0, 222)?.frame).toBe(0);
  // SMUDGE.CPP: the 2 by 2 bib is clipped at both storage edges, never wrapped.
  expect(smudges).toEqual([{ type: 'BIB3', cell: cell(511, 255), frame: 0 }]);
});

test('building damage uses the original half-health threshold, turret and ruin frames', () => {
  const building = { type: 'GUN', house: 'BadGuy', cell: 65, facing: 64, strength: 128 };
  expect(buildingFrame(building, BUILDINGS.get('GUN')!, 128)).toBe(24);
  expect(buildingFrame({ ...building, strength: 127 }, BUILDINGS.get('GUN')!, 128)).toBe(88);
  expect(buildingFrame({ ...building, type: 'PROC', strength: 96 }, BUILDINGS.get('PROC')!, 61)).toBe(30);
  // Read_INI converts 450 * 1/256 to 2 hitpoints with Fixed_To_Cardinal, so this is not rubble.
  expect(buildingFrame({ ...building, type: 'PROC', strength: 1 }, BUILDINGS.get('PROC')!, 61)).toBe(30);
  expect(buildingFrame({ ...building, type: 'NUKE', strength: 1 }, BUILDINGS.get('NUKE')!, 10)).toBe(9);
  expect(buildingPosition({ ...building, type: 'FIX' }, BUILDINGS.get('FIX')!)).toMatchObject({ sortX: 256, sortY: 256 });
});

test('the weapon factory roof remains at two rounded hitpoints', () => {
  const scenario = overlapFixture();
  scenario.units = [];
  scenario.infantry = [];
  scenario.terrain = [];
  scenario.buildings = [
    { type: 'WEAP', house: 'GoodGuy', cell: 65, facing: 0, strength: 1 },
    { type: 'WEAP', house: 'GoodGuy', cell: 69, facing: 0, strength: 2 },
  ];
  const scene = buildScene(mix, scenario);
  // COORDA.ASM, Fixed_To_Cardinal: 200 * 1/256 rounds to 1; 200 * 2/256 rounds to 2.
  // BUILDING.CPP, Draw_It: draw WEAP2 only above one hitpoint.
  expect(scene.objects.map(object => object.count)).toEqual([1, 2]);
});

test('water rotates indices 32 through 38 every quarter second, including the first expired timer', () => {
  const colors = Uint8Array.from({ length: 1024 }, (_, i) => Math.floor(i / 4));
  const cycle = new PaletteCycle(colors);
  cycle.update(0);
  expect([...cycle.colors.filter((_, i) => i % 4 === 0).slice(32, 39)]).toEqual([38, 32, 33, 34, 35, 36, 37]);
  expect(cycle.update(249)).toBe(false);
  expect(cycle.update(250)).toBe(true);
  expect(cycle.colors[32 * 4]).toBe(37);
  cycle.update(1500);
  expect(cycle.colors).toEqual(colors);
});

test('zoom keeps the pointer world position to within one original pixel', () => {
  expect(initialZoom(1080)).toBe(2);
  const origin = zoomOrigin(300, 173, 2, 3);
  expect(Math.abs(origin + 173 * 2 / 3 - (300 + 173))).toBeLessThanOrEqual(0.5);
  expect(zoomOrigin(300, 120, 3, 1)).toBe(60);
});
