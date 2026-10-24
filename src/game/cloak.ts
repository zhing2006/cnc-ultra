// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { DataTexture, FloatType, NearestFilter, RedFormat, type Node } from 'three/webgpu';
import { Fn, int, ivec2, max, min, select, textureLoad, array, floor } from 'three/tsl';
import type { IndexedImage } from '../engine/indexed/atlas.ts';
import type { DisplacementInput, Sprite } from '../engine/indexed/pipeline.ts';

export const CLOAK_STAGES = ['normal', 'indistinct', 'darken', 'shadowy', 'ripple', 'hidden'] as const;
export type CloakStage = typeof CLOAK_STAGES[number];

/** WWSTD.H, ColorType: BLACK is distinct from transparent TBLACK at index 0. */
const BLACK = 12;

/** Ported from TECHNO.CPP, Techno_Draw_Object, and CONQUER.CPP, CC_Draw_Shape. */
export function cloakedSprites<T extends Omit<Sprite, 'region'>>(body: T, stage: CloakStage): T[] {
  const filter = { ...body, shadow: false, filter: 0 };
  const ripple = { ...body, shadow: false, displace: true };
  switch (stage) {
    case 'normal': return [body];
    case 'indistinct': return [body, ripple];
    case 'darken': return [body, filter, ripple];
    case 'shadowy': return [filter, ripple];
    case 'ripple': return [ripple];
    case 'hidden': return [];
  }
}

/**
 * Ported from SUPPORT.ASM, Conquer_Build_Fading_Table, and DISPLAY.CPP, Init_Theater.
 * SpecialGhost maps nonzero source pixels through a 100/256 black fade; 240..255 are fixed points.
 * Build it from the file palette, before Options.Fixup_Palette adjusts the presentation colors.
 */
export function specialGhost(palette: Uint8Array): Uint8Array {
  const result = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 1; i < 240; i++) {
    const ideal = [0, 1, 2].map(c => {
      const component = palette[i * 3 + c];
      return component - Math.floor((component - palette[BLACK * 3 + c]) * 100 / 256);
    });
    let distance = Infinity;
    for (let target = 240; target < 256; target++) {
      const d = ideal.reduce((sum, component, c) => sum + (palette[target * 3 + c] - component) ** 2, 0);
      if (d < distance) { distance = d; result[i] = target; }
    }
  }
  return result;
}

/**
 * Ported from KEYFBUFF.ASM, Single_Line_Predator_Trans/BF_Predator_Trans, and CONQUER.CPP,
 * CC_Draw_Shape. Only nontransparent, unclipped pixels advance the eight-entry offset sequence.
 * On the right half of the view the original reads leftwards from the next scanline instead.
 */
export function cloakDisplacement(atlas: IndexedImage) {
  // A summed-area table counts opaque pixels in clipped rows without per-pixel CPU work at render time.
  const width = atlas.width + 1, height = atlas.height + 1;
  const integral = new Float32Array(width * height);
  for (let y = 0; y < atlas.height; y++) {
    let row = 0;
    for (let x = 0; x < atlas.width; x++) {
      row += atlas.pixels[y * atlas.width + x] !== 0 ? 1 : 0;
      integral[(y + 1) * width + x + 1] = integral[y * width + x + 1] + row;
    }
  }
  const texture = new DataTexture(integral, width, height, RedFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const offset = ({ local, rect, atlas: info, origin, size, time }: DisplacementInput) => Fn(() => {
    const corner = ivec2(info.xy);
    const first = ivec2(max(origin.sub(rect.xy), 0));
    const right = int(min(rect.z, origin.x.add(size.x).sub(rect.x)));
    const sum = (x: Node<'int'>, y: Node<'int'>) => int(textureLoad(texture, corner.add(ivec2(x, y))).r);
    const rank = sum(right, local.y).sub(sum(first.x, local.y)).sub(sum(right, first.y)).add(sum(first.x, first.y))
      .add(sum(local.x, local.y.add(1))).sub(sum(first.x, local.y.add(1)))
      .sub(sum(local.x, local.y)).add(sum(first.x, local.y));
    const phase = int(time.div(1000).mul(15)).mod(8);
    const index = phase.add(rank).mod(8);
    const positive = array([int(1), int(3), int(2), int(5), int(2), int(3), int(4), int(1)]);
    const negative = array([int(-1), int(-3), int(-2), int(-5), int(-2), int(-4), int(-3), int(-1)]);
    // A preview phase is not the total logic Frame. The original's Frame == 0 startup exception
    // must use that real frame counter when simulation is connected, not a phase wrapping to zero.
    const reversed = rect.x.add(floor(rect.z.div(2))).sub(origin.x).greaterThan(size.x.div(2));
    return ivec2(select(reversed, negative.element(index), positive.element(index)), select(reversed, int(1), int(0)));
  })();
  return { offset, dispose: () => texture.dispose() };
}
