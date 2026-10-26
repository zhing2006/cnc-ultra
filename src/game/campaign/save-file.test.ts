import { expect, it } from 'vitest';
import { crc32, inflateRawSync } from 'node:zlib';
import { decodeSave, decodeSaveFile, encodeSave, encodeSaveFile } from './save-file.ts';

it('preserves signed fixed-point GPU words and campaign metadata across a local save file', () => {
  const state = new Int32Array([-2147483648, -1, 0, 256, 2147483647]);
  const snapshot = { metadata: { mission: 'SCG01EA', frame: 271, side: 'gdi', trigger: { remaining: 1, active: true } },
    buffers: [new Uint8Array(state.buffer), new Uint8Array([255, 0, 47])] };
  const restored = decodeSave<typeof snapshot.metadata>(encodeSave(snapshot));
  expect(restored.metadata).toEqual(snapshot.metadata);
  expect(new Int32Array(restored.buffers[0].buffer)).toEqual(state);
  expect(restored.buffers[1]).toEqual(snapshot.buffers[1]);
});

// Independent fixtures generated with Python's struct and zipfile modules. The ZIPs
// include extra fields and a comment; the streamed variant also uses a data descriptor.
const fixtures = {
  cncu: 'Q05DVUxUUkEBAAAALgAAAAEAAAAUAAAAeyJtaXNzaW9uIjoiU0NHMDFFQSIsImZyYW1lIjoyNzEsInNpZGUiOiJnZGkifQAAAID/////AAAAAAABAAD///9/',
  stored: 'UEsDBBQAAAAAAAAAWl1y8GFmWgAAAFoAAAAMAAYAbWlzc2lvbi5jbmN1/soCAG9rQ05DVUxUUkEBAAAALgAAAAEAAAAUAAAAeyJtaXNzaW9uIjoiU0NHMDFFQSIsImZyYW1lIjoyNzEsInNpZGUiOiJnZGkifQAAAID/////AAAAAAABAAD///9/UEsBAhQDFAAAAAAAAABaXXLwYWZaAAAAWgAAAAwABgAAAAAAAAAAAIABAAAAAG1pc3Npb24uY25jdf7KAgBva1BLBQYAAAAAAQABAEAAAACKAAAADgBDJkMgVWx0cmEgc2F2ZQ==',
  deflated: 'UEsDBBQAAAAIAAAAWl1y8GFmTgAAAFoAAAAMAAYAbWlzc2lvbi5jbmN1/soCAG9rc/ZzDvUJCXJkZGBg0ANiEC0CxNVKuZnFxZn5eUpWSsHO7gaGro5KOkppRYm5qUpWRuaGOkrFmSlAplJ6SqZSLVBDw38gYGCAGAFk1gMAUEsBAhQDFAAAAAgAAABaXXLwYWZOAAAAWgAAAAwABgAAAAAAAAAAAIABAAAAAG1pc3Npb24uY25jdf7KAgBva1BLBQYAAAAAAQABAEAAAAB+AAAADgBDJkMgVWx0cmEgc2F2ZQ==',
  streamed: 'UEsDBBQACAAIAAAAWl0AAAAAAAAAAAAAAAAMAAYAbWlzc2lvbi5jbmN1/soCAG9rc/ZzDvUJCXJkZGBg0ANiEC0CxNVKuZnFxZn5eUpWSsHO7gaGro5KOkppRYm5qUpWRuaGOkrFmSlAplJ6SqZSLVBDw38gYGCAGAFk1gMAUEsHCHLwYWZOAAAAWgAAAFBLAQIUAxQACAAIAAAAWl1y8GFmTgAAAFoAAAAMAAYAAAAAAAAAAACAAQAAAABtaXNzaW9uLmNuY3X+ygIAb2tQSwUGAAAAAAEAAQBAAAAAjgAAAA4AQyZDIFVsdHJhIHNhdmU=',
};

it.each(Object.entries(fixtures))('loads the independent %s save with automatic format detection', async (_format, base64) => {
  const restored = await decodeSaveFile(Uint8Array.from(Buffer.from(base64, 'base64')));
  expect(restored.metadata).toEqual({ mission: 'SCG01EA', frame: 271, side: 'gdi' });
  expect(new Int32Array(restored.buffers[0].buffer)).toEqual(new Int32Array([-2147483648, -1, 0, 256, 2147483647]));
});

it('compresses full-sized GPU buffers inside a ZIP without changing the cncu payload', async () => {
  const snapshot = { metadata: { mission: 'SCG01EA', frame: 271 },
    buffers: [new Uint8Array(new Int32Array(64 * 64 * 64 * 3).fill(-1).buffer)] };
  const raw = await encodeSaveFile(snapshot, false), archive = await encodeSaveFile(snapshot);
  expect(Buffer.from(raw).equals(Buffer.from(encodeSave(snapshot)))).toBe(true);
  expect(archive.length).toBeLessThan(raw.length / 10);
  const view = new DataView(archive.buffer), end = archive.length - 22;
  // ZIP APPNOTE 4.3.7, 4.3.12 and 4.3.16; zlib verifies the independent DEFLATE and CRC.
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  expect(view.getUint16(8, true)).toBe(8);
  const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const payload = inflateRawSync(archive.subarray(start, start + view.getUint32(18, true)));
  expect(payload.equals(Buffer.from(raw))).toBe(true);
  expect(view.getUint32(14, true)).toBe(crc32(payload));
  expect(view.getUint32(22, true)).toBe(raw.length);
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  expect(view.getUint16(end + 10, true)).toBe(1);
  const central = view.getUint32(end + 16, true);
  expect(view.getUint32(central, true)).toBe(0x02014b50);
  expect(view.getUint32(central + 16, true)).toBe(crc32(payload));
  expect(view.getUint32(central + 24, true)).toBe(raw.length);
  expect(new TextDecoder().decode(archive.subarray(central + 46, central + 46 + view.getUint16(central + 28, true)))).toBe('save.cncu');
  const restored = await decodeSaveFile(archive);
  expect(restored.metadata).toEqual(snapshot.metadata);
  expect(restored.buffers).toHaveLength(1);
  expect(Buffer.from(restored.buffers[0]).equals(Buffer.from(snapshot.buffers[0]))).toBe(true);
});
