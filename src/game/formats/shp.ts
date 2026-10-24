import { lcwUncompress } from './lcw.ts';

/** A decoded shape file: every frame has the same size and holds one palette index per pixel. */
export interface Shape {
  width: number;
  height: number;
  frames: Uint8Array[];
}

// Frame flags in the top byte of each frame's data offset (KEYFRAME.CPP).
const KF_KEYFRAME = 0x80;
const KF_DELTA = 0x20;

// The header is 7 16-bit fields (KeyFrameHeaderType in KEYFRAME.CPP), and each frame entry is two
// 32-bit words: the data offset with the flags on top, then the reference frame.
const HEADER_SIZE = 14;

/**
 * Decodes a keyframed shape file, the format of unit, infantry and building SHPs. Ported from
 * KEYFRAME.CPP, Build_Frame. A key frame is LCW data. A key delta frame is an XOR delta against a
 * key frame, and a delta frame is an XOR delta against the frame before it, back to a key delta.
 * Build_Frame also juggles 16-bit segment offsets, which a flat buffer does not need.
 */
export function decodeShp(data: Uint8Array): Shape {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint16(0, true);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const flags = view.getInt16(12, true);
  // A palette follows the header when bit 0 is set, and every data offset skips it.
  const skip = flags & 1 ? 768 : 0;
  const entry = (frame: number, word: number) => view.getUint32(HEADER_SIZE + frame * 8 + word * 4, true);
  const offset = (frame: number) => (entry(frame, 0) & 0xffffff) + skip;

  const size = width * height;
  const frames: Uint8Array[] = [];
  for (let frame = 0; frame < count; frame++) {
    const pixels = new Uint8Array(size);
    const frameFlags = entry(frame, 0) >>> 24;
    if (frameFlags & KF_KEYFRAME) {
      lcwUncompress(data, offset(frame), pixels);
    } else {
      // A delta frame names its key delta frame, which names the key frame.
      const keyDelta = frameFlags & KF_DELTA ? entry(frame, 1) & 0xffff : frame;
      lcwUncompress(data, (entry(keyDelta, 1) & 0xffffff) + skip, pixels);
      for (let step = keyDelta; step <= frame; step++) applyXorDelta(pixels, data, offset(step));
    }
    frames.push(pixels);
  }
  return { width, height, frames };
}

/**
 * Applies XOR delta (format 40) data to target. Ported from DrawMisc.cpp, Apply_XOR_Delta, in the
 * remaster's Red Alert library.
 */
export function applyXorDelta(target: Uint8Array, delta: Uint8Array, deltaOffset: number) {
  let s = deltaOffset;
  let d = 0;
  for (;;) {
    let op = delta[s++];
    if (op === undefined) throw new Error('XOR delta data ends without an end code');
    if (op === 0) {
      // Short run: XOR one byte over count bytes.
      let count = delta[s++];
      const value = delta[s++];
      while (count--) target[d++] ^= value;
    } else if (op < 0x80) {
      // Short dump: XOR the next op bytes.
      while (op--) target[d++] ^= delta[s++];
    } else if (op > 0x80) {
      // Short skip.
      d += op - 0x80;
    } else {
      const word = delta[s] | (delta[s + 1] << 8);
      s += 2;
      if (word === 0) return;
      if (word < 0x8000) {
        // Long skip.
        d += word;
      } else if (word & 0x4000) {
        // Long run.
        let count = word - 0xc000;
        const value = delta[s++];
        while (count--) target[d++] ^= value;
      } else {
        // Long dump.
        let count = word - 0x8000;
        while (count--) target[d++] ^= delta[s++];
      }
    }
  }
}
