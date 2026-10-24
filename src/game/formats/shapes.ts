import { lcwUncompress } from './lcw.ts';

/** One decoded shape from a shape library: palette indices, 0 for transparent. */
export interface LibraryShape {
  width: number;
  height: number;
  pixels: Uint8Array;
}

// Shape type flags (MAKESHAPE_* in the Westwood library).
const MAKESHAPE_COMPACT = 0x0001;
const MAKESHAPE_NOCOMP = 0x0002;

/**
 * Decodes a shape library, the older format of MOUSE.SHP. The library is a 16-bit shape count
 * followed by 32-bit offsets, which count from just after the count (GETSHAPE.CPP, Extract_Shape).
 * Each shape has a 10-byte header: type, height, width, original height, shape size and data size.
 * Ported from WWMOUSE.ASM, ASM_Set_Mouse_Cursor, in the Nyerguds fork's library: the data is LCW
 * compressed unless the type says otherwise, a compact shape carries a 16-entry color table, and the
 * result is run-length coded, with a 0 followed by the number of transparent pixels.
 */
export function decodeShapeLibrary(data: Uint8Array): LibraryShape[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint16(0, true);
  const shapes: LibraryShape[] = [];
  for (let index = 0; index < count; index++) {
    const start = 2 + view.getUint32(2 + index * 4, true);
    const type = view.getUint16(start, true);
    const width = view.getUint16(start + 3, true);
    const height = view.getUint8(start + 5);
    const dataSize = view.getUint16(start + 8, true);

    let body = start + 10;
    let table: Uint8Array | null = null;
    if (type & MAKESHAPE_COMPACT) {
      table = data.subarray(body, body + 16);
      body += 16;
    }
    let coded = data.subarray(body);
    if (!(type & MAKESHAPE_NOCOMP)) {
      coded = new Uint8Array(dataSize);
      lcwUncompress(data, body, coded);
    }

    const pixels = new Uint8Array(width * height);
    let s = 0;
    for (let d = 0; d < pixels.length;) {
      const value = coded[s++];
      if (value === 0) {
        d += coded[s++];
      } else {
        pixels[d++] = table ? table[value] : value;
      }
    }
    shapes.push({ width, height, pixels });
  }
  return shapes;
}
