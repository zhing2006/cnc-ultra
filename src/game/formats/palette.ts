// Ported from LIB.CPP in the Nyerguds fork's library: Divide_With_Round, Convert_RGB_To_HSV and
// Convert_HSV_To_RGB. Palette components are 6-bit (0..63), HSV components 0..255.
const HSV_BASE = 255;
const RGB_BASE = 63;

function divideWithRound(num: number, den: number): number {
  return Math.floor(num / den) + (num % den >= (den + 1) >> 1 ? 1 : 0);
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r = divideWithRound(r * HSV_BASE, RGB_BASE);
  g = divideWithRound(g * HSV_BASE, RGB_BASE);
  b = divideWithRound(b * HSV_BASE, RGB_BASE);
  let h = 0;
  const v = Math.max(r, g, b);
  const m = Math.min(r, g, b);
  const s = v !== 0 ? divideWithRound((v - m) * HSV_BASE, v) : 0;
  if (s !== 0) {
    const tmp = v - m;
    const r1 = divideWithRound((v - r) * HSV_BASE, tmp);
    const g1 = divideWithRound((v - g) * HSV_BASE, tmp);
    const b1 = divideWithRound((v - b) * HSV_BASE, tmp);
    if (v === r) {
      h = m === g ? 5 * HSV_BASE + b1 : 1 * HSV_BASE - g1;
    } else if (v === g) {
      h = m === b ? 1 * HSV_BASE + r1 : 3 * HSV_BASE - b1;
    } else {
      h = m === r ? 3 * HSV_BASE + g1 : 5 * HSV_BASE - r1;
    }
    h = divideWithRound(h, 6);
  }
  return [h, s, v];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h *= 6;
  const f = h % HSV_BASE;
  const values = [0, v, v, 0, 0, 0, 0];
  values[3] = divideWithRound(v * (HSV_BASE - divideWithRound(s * f, HSV_BASE)), HSV_BASE);
  values[4] = values[5] = divideWithRound(v * (HSV_BASE - s), HSV_BASE);
  values[6] = divideWithRound(v * (HSV_BASE - divideWithRound(s * (HSV_BASE - f), HSV_BASE)), HSV_BASE);
  let i = Math.floor(h / HSV_BASE);
  i += i > 4 ? -4 : 2;
  const r = divideWithRound(values[i] * RGB_BASE, HSV_BASE);
  i += i > 4 ? -4 : 2;
  const b = divideWithRound(values[i] * RGB_BASE, HSV_BASE);
  i += i > 4 ? -4 : 2;
  const g = divideWithRound(values[i] * RGB_BASE, HSV_BASE);
  return [r, g, b];
}

/** The default brightness, color, tint and contrast settings (OPTIONS.CPP, OptionsClass constructor). */
const NEUTRAL = 0x80;

/**
 * The palette the original game shows for a theater palette file, as 6-bit RGB triples. Init_Theater
 * in DISPLAY.CPP ends with Options.Fixup_Palette, which runs every color but the last through HSV and
 * back (OPTIONS.CPP, OptionsClass::Adjust_Palette). The default settings leave HSV unchanged, but the
 * rounding of the two conversions still moves some colors.
 */
export function gamePalette(file: Uint8Array): Uint8Array {
  if (file.length < 768) throw new Error('a palette file holds 256 RGB triples');
  const palette = file.slice(0, 768);
  for (let index = 0; index < 255; index++) {
    let [h, s, v] = rgbToHsv(palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]);
    // Ported from OptionsClass::Adjust_Palette: brightness, contrast, color and tint in that order.
    v = Math.min(Math.max(Math.trunc((v * NEUTRAL) / 0x80), 0), 0xff);
    v = Math.min(Math.max(Math.trunc(((v - 0x80) * NEUTRAL) / 0x80) + 0x80, 0), 0xff);
    s = Math.min(Math.max(Math.trunc((s * NEUTRAL) / 0x80), 0), 0xff);
    h = Math.min(Math.max(Math.trunc((h * NEUTRAL) / 0x80), 0), 0xff);
    palette.set(hsvToRgb(h, s, v), index * 3);
  }
  return palette;
}

/**
 * Converts 6-bit RGB triples to 8-bit RGBA, shifting each component left by 2 as the original does
 * when it hands the palette to DirectDraw (DDRAW.CPP, Set_DD_Palette, in the remaster's library).
 */
export function paletteToRgba(palette: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index++) {
    rgba[index * 4] = (palette[index * 3] << 2) & 0xff;
    rgba[index * 4 + 1] = (palette[index * 3 + 1] << 2) & 0xff;
    rgba[index * 4 + 2] = (palette[index * 3 + 2] << 2) & 0xff;
    rgba[index * 4 + 3] = 0xff;
  }
  return rgba;
}
