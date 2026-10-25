/**
 * Decompresses LCW (format 80) data into dest and returns the number of bytes written. Ported from
 * LCWUNCMP.CPP, LCW_Uncompress, the C version of the library routine in the remaster's Red Alert
 * source. Writes past the end of dest are dropped, as typed arrays drop them.
 */
export function lcwUncompress(source: Uint8Array, sourceOffset: number, dest: Uint8Array, relative = false): number {
  let s = sourceOffset;
  let d = 0;
  for (;;) {
    const op = source[s++];
    if (op === undefined) throw new Error('LCW data ends without an end code');
    if (!(op & 0x80)) {
      // Short copy from earlier output, relative to the current position.
      let count = (op >> 4) + 3;
      let from = d - (source[s++] + ((op & 0x0f) << 8));
      while (count--) dest[d++] = dest[from++];
    } else if (!(op & 0x40)) {
      if (op === 0x80) return d;
      // Medium copy from the source.
      let count = op & 0x3f;
      while (count--) dest[d++] = source[s++];
    } else if (op === 0xfe) {
      // Long run of one byte.
      let count = source[s] + (source[s + 1] << 8);
      const value = source[s + 2];
      s += 3;
      while (count--) dest[d++] = value;
    } else {
      // Long or medium copy from earlier output, at an absolute position.
      let count: number;
      if (op === 0xff) {
        count = source[s] + (source[s + 1] << 8);
        s += 2;
      } else {
        count = (op & 0x3f) + 3;
      }
      let from = source[s] + (source[s + 1] << 8);
      s += 2;
      if (relative) from = d - from;
      while (count--) dest[d++] = dest[from++];
    }
  }
}
