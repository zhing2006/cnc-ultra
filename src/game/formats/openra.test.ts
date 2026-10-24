import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  framesDigest, parseReferences, PNG_DIRECTORY, REFERENCE_FILE, type Frame, type ReferenceEntry,
} from '../../../tests/reference/digest.ts';
import { readIndexedPng } from '../../../tests/reference/png.ts';
import { PREVIEW_DATA_FILES } from '../data-files.ts';
import { decodeIconSet } from './icons.ts';
import { MixFile, MixSet } from './mix.ts';
import { decodeShapeLibrary } from './shapes.ts';
import { decodeShp } from './shp.ts';

const assets = new URL('../../../assets/dev/', import.meta.url);
const mix = new MixSet(PREVIEW_DATA_FILES.map((name) => new MixFile(readFileSync(new URL(name, assets)))));

// OpenRA's ShpD2Loader gives a shape without a color table Dune II's unit colors, 1 to 4 becoming
// 0x7F down to 0x7C. The original's mouse code keeps the indices as they are (WWMOUSE.ASM), so the
// comparison applies the same substitution to this decoder's output.
const D2_COLORS: Record<number, number> = { 1: 0x7f, 2: 0x7e, 3: 0x7d, 4: 0x7c };

/** Decodes a file the way OpenRA exports it: one frame per shape frame or per logical icon. */
function decode(entry: ReferenceEntry): Frame[] {
  const data = mix.require(entry.name);
  switch (entry.format) {
    case 'shp': {
      const { width, height, frames } = decodeShp(data);
      return frames.map((pixels) => ({ width, height, pixels }));
    }
    case 'tem': {
      // OpenRA exports an icon the set does not store as a blank frame of full size.
      const { width, height, icons, map } = decodeIconSet(data);
      const blank = new Uint8Array(width * height);
      return [...map].map((stored) => ({ width, height, pixels: stored === 0xff ? blank : icons[stored] }));
    }
    case 'shapes':
      return decodeShapeLibrary(data).map((shape) => ({
        ...shape, pixels: shape.pixels.map((value) => D2_COLORS[value] ?? value),
      }));
  }
}

/** The first frame that differs from OpenRA's PNG, when the exported PNGs are at hand. */
function firstDifference(entry: ReferenceEntry, frames: Frame[]): string {
  const name = entry.name;
  const prefix = name.slice(0, name.lastIndexOf('.'));
  const directory = new URL(`${name}/`, PNG_DIRECTORY);
  if (!existsSync(directory)) return 'run node refs/export-png.ts to get OpenRA\'s PNGs and find the frame';
  for (let index = 0; index < frames.length; index++) {
    const path = new URL(`${prefix}-${String(index).padStart(4, '0')}.png`, directory);
    if (!existsSync(path)) return `frame ${index}: OpenRA omits fully transparent SHP frames`;
    const png = readIndexedPng(readFileSync(path));
    const frame = frames[index];
    if (png.width !== frame.width || png.height !== frame.height) {
      return `frame ${index} is ${frame.width}×${frame.height}, OpenRA's is ${png.width}×${png.height}`;
    }
    const pixel = png.pixels.findIndex((value, at) => value !== frame.pixels[at]);
    if (pixel >= 0) {
      const at = `(${pixel % png.width}, ${Math.floor(pixel / png.width)})`;
      return `frame ${index} differs first at ${at}: ${frame.pixels[pixel]}, OpenRA has ${png.pixels[pixel]}`;
    }
  }
  return 'the frames match OpenRA\'s PNGs, so tests/reference/openra.txt is out of date';
}

const entries = parseReferences(readFileSync(REFERENCE_FILE, 'utf8'));

test.each(entries)('$name decodes like OpenRA', (entry) => {
  const frames = decode(entry);
  expect(frames.length, 'frame count').toBe(entry.frames);
  if (framesDigest(frames) !== entry.digest) expect.fail(`${entry.name}: ${firstDifference(entry, frames)}`);
});
