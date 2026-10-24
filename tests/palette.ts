import assert from 'node:assert/strict';
import { withApp, type Session } from './browser.ts';

interface Composition {
  width: number;
  /** Pixels where the GPU's index image differs from drawing the sprites one by one. */
  mismatches: { x: number; y: number; gpu: number; expected: number }[];
  shadowOnTerrain: number;
  shadowOnSprite: number;
}

/**
 * Runs in the page: draws two overlapping vehicles of different houses on terrain, with the original
 * data, reads the index image back and compares it with drawing each sprite in turn onto the image,
 * as Buffer_Frame_To_Page does with SHAPE_FADING and SHAPE_GHOST (KEYFBUFF.ASM): a shadow pixel turns
 * the index under it into UnitShadow's entry and then goes through the house remap table, any other
 * pixel goes through the remap table.
 */
async function composeInPage(): Promise<Composition> {
  const { createRenderer } = await import('../src/engine/renderer.ts');
  const { PalettePipeline, NO_TILE } = await import('../src/engine/indexed/pipeline.ts');
  const { packAtlas } = await import('../src/engine/indexed/atlas.ts');
  const { loadData } = await import('../src/game/data-files.ts');
  const { decodeShp } = await import('../src/game/formats/shp.ts');
  const { decodeIconSet } = await import('../src/game/formats/icons.ts');
  const { REMAP_NAMES, remapTable } = await import('../src/game/data/houses.ts');

  const mix = await loadData();
  const shadowFile = mix.require('TUNITS.MRF');
  const sources = shadowFile.slice(0, 256).map((table) => (table === 0xff ? 0 : 1));
  const shadowTable = shadowFile.slice(256, 512);
  const remaps = REMAP_NAMES.map(remapTable);

  // A 3 × 3 cell patch of CLEAR1 icons.
  const clear = decodeIconSet(mix.require('CLEAR1.TEM'));
  const icons = [0, 1, 2].map((icon) => ({ width: 24, height: 24, pixels: clear.icons[clear.map[icon]] }));
  const tileAtlas = packAtlas(icons, 72);
  const cells = Uint32Array.from([0, 1, 2, 1, 2, 0, 2, 0, 1]);

  // The second tank sits 6 pixels left of the first, so its shadow falls partly on the first tank and
  // partly on bare terrain.
  const tank = decodeShp(mix.require('MTNK.SHP'));
  const frames = [0, 4].map((frame) => ({ width: tank.width, height: tank.height, pixels: tank.frames[frame] }));
  const { atlas, regions } = packAtlas(frames, 128);
  const sprites = [
    { x: 24, y: 24, region: regions[0], remap: REMAP_NAMES.indexOf('blue'), shadow: true },
    { x: 18, y: 24, region: regions[1], remap: REMAP_NAMES.indexOf('yellow'), shadow: true },
  ];

  // A renderer of its own on a small canvas, so that the app's view stays untouched.
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position: fixed; width: 16px; height: 16px';
  document.body.append(canvas);
  const renderer = await createRenderer(canvas, { onDeviceLost: (message) => console.error(message) });
  if (!renderer) throw new Error('no WebGPU');
  const pipeline = new PalettePipeline(renderer.three, {
    palette: new Uint8Array(1024), shadowSources: sources, shadowTable, remaps,
    tiles: { tileSize: 24, atlas: tileAtlas.atlas, cells, columns: 3, rows: 3 },
    spriteAtlas: atlas, spriteCapacity: sprites.length,
  });
  // The view starts a little left of and above the map, where the tile map draws index 0.
  const view = { x: -4, y: -4, width: 80, height: 80 };
  // The first tank is drawn alone once, so the second reaches the GPU only through a later write of
  // its own part of the draw list.
  pipeline.setSprites(sprites.slice(0, 1));
  await pipeline.readIndices(view);
  pipeline.setSprites(sprites.slice(1), 1);
  const gpu = await pipeline.readIndices(view);
  pipeline.dispose();
  renderer.dispose();
  canvas.remove();

  const expected = new Uint8Array(view.width * view.height);
  const onSprite = new Uint8Array(view.width * view.height);
  for (let y = 0; y < view.height; y++) {
    for (let x = 0; x < view.width; x++) {
      const worldX = view.x + x;
      const worldY = view.y + y;
      const inside = worldX >= 0 && worldY >= 0 && worldX < 72 && worldY < 72;
      if (!inside || cells[Math.floor(worldY / 24) * 3 + Math.floor(worldX / 24)] === NO_TILE) continue;
      const region = tileAtlas.regions[cells[Math.floor(worldY / 24) * 3 + Math.floor(worldX / 24)]];
      const texel = (region.y + worldY % 24) * tileAtlas.atlas.width + region.x + worldX % 24;
      expected[y * view.width + x] = tileAtlas.atlas.pixels[texel];
    }
  }
  let shadowOnTerrain = 0;
  let shadowOnSprite = 0;
  sprites.forEach((sprite, index) => {
    const pixels = frames[index].pixels;
    for (let row = 0; row < sprite.region.height; row++) {
      for (let column = 0; column < sprite.region.width; column++) {
        const source = pixels[row * sprite.region.width + column];
        if (source === 0) continue;
        const at = (sprite.y - view.y + row) * view.width + sprite.x - view.x + column;
        if (sources[source]) {
          if (onSprite[at]) shadowOnSprite++;
          else shadowOnTerrain++;
          expected[at] = remaps[sprite.remap][shadowTable[expected[at]]];
        } else {
          expected[at] = remaps[sprite.remap][source];
          onSprite[at] = 1;
        }
      }
    }
  });

  const mismatches = [];
  for (let at = 0; at < gpu.length; at++) {
    if (gpu[at] === expected[at]) continue;
    mismatches.push({ x: at % view.width, y: Math.floor(at / view.width), gpu: gpu[at], expected: expected[at] });
  }
  return { width: view.width, mismatches: mismatches.slice(0, 10), shadowOnTerrain, shadowOnSprite };
}

export function checkShadowComposition(session: Session) {
  return withApp(session, {}, async (page) => {
    await page.locator('canvas[data-status="running"]').waitFor({ state: 'attached' });
    const result = await page.evaluate(composeInPage);
    assert(result.shadowOnTerrain > 0, 'the scene should put shadow pixels on terrain');
    assert(result.shadowOnSprite > 0, 'the scene should put shadow pixels on the other tank');
    assert.deepEqual(result.mismatches, [], 'the index image should match drawing each sprite in turn');
  });
}
