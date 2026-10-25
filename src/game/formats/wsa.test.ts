import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MixFile } from './mix.ts';
import { WsaVideo } from './wsa.ts';

describe.skipIf(!existsSync('data/transit.mix'))('Original campaign animations against OpenRA', () => {
  for (const name of ['CHOOSE', 'S-GDIIN2', 'SCRSCN1']) it(`${name}: every frame and loop restart`, () => {
    const archive = new MixFile(readFileSync(`data/${name === 'CHOOSE' ? 'transit.mix' : 'gdi/general.mix'}`));
    const animation = new WsaVideo(archive.get(`${name}.WSA`)!);
    const reference = readFileSync('tests/reference/openra-wsa.txt', 'utf8').split('\n').filter(line => line.startsWith(`${name} `));
    const bgra = new Uint8Array(animation.width * animation.height * 4);
    const lines: string[] = [];
    let first: Uint8Array | undefined;
    for (let frame = 0; frame < animation.frameCount; frame++) {
      const pixels = animation.next();
      if (!frame) first = pixels.slice();
      for (let i = 0; i < pixels.length; i++) {
        for (let channel = 0; channel < 3; channel++) {
          const value = animation.palette[pixels[i] * 3 + 2 - channel] << 2;
          bgra[i * 4 + channel] = value | value >> 6;
        }
        bgra[i * 4 + 3] = 255;
      }
      lines.push(`${name} ${frame} ${animation.width} ${animation.height} ${createHash('sha256').update(bgra).digest('hex')}`);
    }
    expect(lines).toEqual(reference);
    expect(animation.next()).toEqual(first);
  });
});
