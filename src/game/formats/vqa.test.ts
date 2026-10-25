import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { mixId } from './mix.ts';
import { BufferedSource } from './remote-mix.ts';
import { VqaVideo, vqpTable } from './vqa.ts';

const archive = 'refs/cnc-gold/gdi/movies.mix';
describe.skipIf(!existsSync(archive))('C&C Gold movies against independent OpenRA frames and PCM', () => {
  for (const name of ['LOGO', 'INTRO2', 'GDI1', 'LANDING', 'CONSYARD', 'GAMEOVER']) it(name, async () => {
    const file = await open(archive);
    try {
      const header = Buffer.alloc(6); await file.read(header, 0, 6, 0);
      const table = Buffer.alloc(header.readUInt16LE() * 12); await file.read(table, 0, table.length, 6);
      let offset = -1, size = 0;
      for (let at = 0; at < table.length; at += 12) if (table.readUInt32LE(at) === mixId(`${name}.VQA`)) {
        offset = 6 + table.length + table.readUInt32LE(at + 4); size = table.readUInt32LE(at + 8); break;
      }
      expect(offset).toBeGreaterThan(0);
      let largestRead = 0;
      const video = await VqaVideo.open(new BufferedSource({ size, async read(at, count) {
        largestRead = Math.max(largestRead, count);
        const bytes = Buffer.alloc(count); await file.read(bytes, 0, count, offset + at); return bytes;
      } }));
      const reference = readFileSync('tests/reference/openra-vqa.txt', 'utf8').split('\n').filter(line => line.startsWith(`${name} `));
      const audio = createHash('sha256'), frames: string[] = [];
      const bgra = new Uint8Array(video.width * video.height * 4);
      for (let index = 0, frame; (frame = await video.next()); index++) {
        for (let i = 0; i < frame.pixels.length; i++) {
          const color = frame.pixels[i] * 3;
          bgra[i * 4] = frame.palette[color + 2] << 2;
          bgra[i * 4 + 1] = frame.palette[color + 1] << 2;
          bgra[i * 4 + 2] = frame.palette[color] << 2; bgra[i * 4 + 3] = 255;
        }
        frames.push(`${name} ${index} ${video.width} ${video.height} ${createHash('sha256').update(bgra).digest('hex')}`);
        for (const chunk of frame.audio) audio.update(chunk);
      }
      expect([`${name} audio ${video.sampleRate} ${video.sampleBits} ${video.channels} ${audio.digest('hex')}`, ...frames]).toEqual(reference);
      expect(largestRead).toBeLessThanOrEqual(256 * 1024);
    } finally { await file.close(); }
  }, 30000);
});

it('reconstructs the symmetric Gold VQP table from its stored lower triangle', () => {
  // CONQUER.CPP Load_Interpolated_Palettes: one count, then y+1 bytes for each row.
  const source = new Uint8Array(4 + 32896); source[0] = 1;
  source[4 + 2 * 3 / 2 + 1] = 47;
  const table = vqpTable(source, 0);
  expect(table[2 * 256 + 1]).toBe(47);
  expect(table[1 * 256 + 2]).toBe(47);
});
