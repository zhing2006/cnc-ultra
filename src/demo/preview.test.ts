import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DESERT_DATA_FILES } from '../game/data-files.ts';
import { MixFile, MixSet } from '../game/formats/mix.ts';
import { decodeShp } from '../game/formats/shp.ts';
import { buildPreview } from './preview.ts';

const mix = new MixSet(DESERT_DATA_FILES.map(name => new MixFile(readFileSync(new URL(`../../assets/dev/${name}`, import.meta.url)))));

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
