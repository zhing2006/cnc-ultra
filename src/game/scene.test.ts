import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DATA_FILES } from './data-files.ts';
import { REMAP_NAMES, remapTable } from './data/houses.ts';
import { MixFile, MixSet } from './formats/mix.ts';

const assets = new URL('../../assets/dev/', import.meta.url);
const mix = new MixSet(DATA_FILES.map((name) => new MixFile(readFileSync(new URL(name, assets)))));

// The original runs a shadow pixel's result through the house remap table as well (KEYFBUFF.ASM,
// Single_Line_Ghost_Fading_Trans), but PalettePipeline does not. The two agree only while no remap
// table touches an index the shadow table produces.
test('house remaps leave every temperate shadow color alone', () => {
  const shaded = new Set(mix.require('TUNITS.MRF').subarray(256, 512));
  for (const name of REMAP_NAMES) {
    const table = remapTable(name);
    const changed = [...shaded].filter((index) => table[index] !== index);
    expect(changed, name).toEqual([]);
  }
});
