import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PREVIEW_DATA_FILES } from './data-files.ts';
import { MixFile, MixSet } from './formats/mix.ts';
import { readScenario } from './formats/scenario.ts';
import { BUILDINGS } from './data/buildings.ts';
import { buildingFrame, buildingPosition, initialCellImages } from './map-visuals.ts';
import { buildScene } from './scene.ts';
import { PaletteCycle } from './palette-cycle.ts';
import { initialZoom, zoomOrigin } from './zoom.ts';
import { buildPreview } from './preview.ts';
import { decodeShp } from './formats/shp.ts';
import { overlapFixture, OVERLAP_ORDER } from '../../tests/visual-fixture.ts';

const mix = new MixSet(PREVIEW_DATA_FILES.map(name => new MixFile(readFileSync(new URL(`../../assets/dev/${name}`, import.meta.url)))));

test('scg08eb retains every terrain object and structure, including overlapping village buildings', () => {
  const scene = buildScene(mix, 'SCG08EB');
  expect(scene.scenario.terrain).toHaveLength(64);
  expect(scene.scenario.buildings).toHaveLength(38);
  expect(scene.objects.filter(object => object.key.startsWith('terrain:'))).toHaveLength(64);
  expect(scene.objects.filter(object => object.key.startsWith('building:'))).toHaveLength(38);
  expect(scene.objects.some(object => object.key === 'building:3660:V02')).toBe(true);
  expect(scene.objects.some(object => object.key === 'building:3660:V11')).toBe(true);
});

test('overlapping objects use the original sort coordinates and building image origins', () => {
  const scene = buildScene(mix, overlapFixture());
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

test('the gallery exposes all original units and all 65 buildings across the two theaters', () => {
  const settings = { group: 'units', theater: 'TEMPERATE', house: 'BadGuy', facing: 64, buildingState: 'damaged', cloak: 'normal' } as const;
  const units = buildPreview(mix, settings);
  expect(units.entries).toHaveLength(47); // 22 UnitTypes, 20 InfantryTypes, 5 AircraftTypes.
  expect(units.scene.objects.filter(object => object.key.startsWith('aircraft:'))).toHaveLength(5);
  expect(units.scene.objects.some(object => object.key.endsWith(':BOAT'))).toBe(true);
  const names = new Set<string>();
  for (const theater of ['TEMPERATE', 'DESERT'] as const) {
    const gallery = buildPreview(mix, { ...settings, group: 'buildings', theater });
    for (const item of gallery.entries) names.add(item.name);
  }
  expect(names.size).toBe(65);
});

test('the ruined gallery uses the last frame even for the 1000-hitpoint temple', () => {
  const settings = { group: 'buildings', theater: 'TEMPERATE', house: 'GoodGuy', facing: 0,
    buildingState: 'ruined', cloak: 'normal' } as const;
  const gallery = buildPreview(mix, settings);
  const object = gallery.scene.objects.find(object => object.key.endsWith(':TMPL'))!;
  const { region } = gallery.scene.sprites[object.first];
  const { spriteAtlas } = gallery.scene.setup;
  const pixels = new Uint8Array(region.width * region.height);
  for (let y = 0; y < region.height; y++) pixels.set(spriteAtlas.pixels.subarray(
    (region.y + y) * spriteAtlas.width + region.x, (region.y + y) * spriteAtlas.width + region.x + region.width,
  ), y * region.width);
  // BuildingClass::Draw_It uses the last SHP frame at one hitpoint or less, regardless of MaxStrength.
  const expected = decodeShp(mix.require('TMPL.SHP')).frames.at(-1)!;
  expect(pixels.findIndex((pixel, i) => pixel !== expected[i]), 'first pixel differing from the ruin frame').toBe(-1);
});
