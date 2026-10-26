import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MixFile, MixSet } from '../formats/mix.ts';
import { decodeShp } from '../formats/shp.ts';
import { CampaignAssets } from './assets.ts';
import { OriginalInterface } from './interface.ts';

it('uses the in-game button texture with the battlefield palette', async () => {
  const mix = new MixSet(['updatec.mix', 'cclocal.mix', 'conquer.mix', 'general.mix'].map(name =>
    new MixFile(readFileSync(new URL(`../../../assets/dev/${name}`, import.meta.url)))));
  const assets = {
    bytes: async (name: string) => mix.require(name),
    optionalBytes: async (name: string) => mix.get(name),
  } as CampaignAssets;
  const ui = await OriginalInterface.open(assets), texture = decodeShp(mix.require('BTEXTURE.SHP'));
  const button = { id: 'resume', label: '', x: 150, y: 110, width: 340, height: 22 };
  // DIALOG.CPP Draw_Box passes InMainLoop to CC_Texture_Fill: frame 0
  // uses the title palette; frame 1 uses the current battlefield palette.
  for (const inGame of [false, true]) {
    ui.box(button, false, false, inGame);
    for (let y = 1; y < button.height - 1; y++) for (let x = 1; x < button.width - 1; x++)
      expect(ui.pixels[(button.y + y) * 640 + button.x + x]).toBe(
        texture.frames[inGame ? 1 : 0][(y % texture.height) * texture.width + x % texture.width]);
  }
});
