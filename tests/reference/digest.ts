import { createHash } from 'node:crypto';

/** One decoded frame: palette indices, row by row. */
export interface Frame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** SHA-256 over every frame's 16-bit little-endian width and height followed by its pixels. */
export function framesDigest(frames: readonly Frame[]): string {
  const hash = createHash('sha256');
  for (const frame of frames) {
    hash.update(Uint8Array.of(frame.width & 0xff, frame.width >> 8, frame.height & 0xff, frame.height >> 8));
    hash.update(frame.pixels);
  }
  return hash.digest('hex');
}

/** How a reference file is decoded: keyframed shapes, icon sets, or a shape library. */
export type ReferenceFormat = 'shp' | 'tem' | 'shapes';

export interface ReferenceEntry {
  name: string;
  format: ReferenceFormat;
  frames: number;
  digest: string;
}

/** The committed digests of OpenRA's exports, written by refs/export-png.ts. */
export const REFERENCE_FILE = new URL('openra.txt', import.meta.url);

/** The directory refs/export-png.ts leaves OpenRA's PNGs in, one subdirectory per file. */
export const PNG_DIRECTORY = new URL('../../refs/openra-png/', import.meta.url);

export function parseReferences(text: string): ReferenceEntry[] {
  return text.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
    const [name, format, frames, digest] = line.split(' ');
    return { name, format: format as ReferenceFormat, frames: Number(frames), digest };
  });
}
