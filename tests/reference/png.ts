import { inflateSync } from 'node:zlib';
import type { Frame } from './digest.ts';

/**
 * Reads the palette indices of an 8-bit indexed PNG, the kind OpenRA's --png command writes. Other
 * kinds of PNG are rejected.
 */
export function readIndexedPng(data: Uint8Array): Frame {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let width = 0;
  let height = 0;
  const chunks: Uint8Array[] = [];
  for (let offset = 8; offset < data.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || color !== 3 || interlace !== 0) throw new Error('not an 8-bit indexed, non-interlaced PNG');
    } else if (type === 'IDAT') {
      chunks.push(body);
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(chunks));
  const pixels = new Uint8Array(width * height);
  const previous = new Uint8Array(width);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (width + 1)];
    const line = raw.subarray(row * (width + 1) + 1, (row + 1) * (width + 1));
    const out = pixels.subarray(row * width, (row + 1) * width);
    for (let x = 0; x < width; x++) {
      const left = x > 0 ? out[x - 1] : 0;
      const up = previous[x];
      const upLeft = x > 0 ? previous[x - 1] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[x] = (line[x] + predicted) & 0xff;
    }
    previous.set(out);
  }
  return { width, height, pixels };
}
