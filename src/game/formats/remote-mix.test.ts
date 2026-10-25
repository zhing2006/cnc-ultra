import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { MixFile } from './mix.ts';
import { BufferedSource, readRange, RemoteMix } from './remote-mix.ts';

afterEach(() => vi.unstubAllGlobals());

it('reads the original MIX directory then only the requested member ranges', async () => {
  const bytes = readFileSync('assets/dev/conquer.mix'), requests: [number, number][] = [];
  vi.stubGlobal('fetch', async (_url: URL, options: RequestInit) => {
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec((options.headers as Record<string, string>).Range)!;
    const start = Number(first), end = Number(last); requests.push([start, end]);
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  });
  const remote = await RemoteMix.open(new URL('https://example.invalid/data/conquer.mix'));
  const source = remote.get('MTNK.SHP')!;
  const original = new MixFile(bytes).get('MTNK.SHP')!;
  expect(source.size).toBe(original.length);
  const buffer = new BufferedSource(source, 128);
  expect(await buffer.read(0, 32)).toEqual(new Uint8Array(original.subarray(0, 32)));
  expect(await buffer.read(32, 32)).toEqual(new Uint8Array(original.subarray(32, 64)));
  expect(requests).toHaveLength(3);
  expect(requests[0]).toEqual([0, 5]);
  expect(requests[1]).toEqual([6, 5 + bytes.readUInt16LE(0) * 12]);
  expect(requests[2][1] - requests[2][0] + 1).toBe(128);
});

it('cancels a full archive response when a static host ignores Range', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  vi.stubGlobal('fetch', async () => new Response(stream, { status: 200 }));
  await expect(readRange(new URL('https://example.invalid/data/movies.mix'), 0, 6)).rejects.toThrow('byte range unavailable');
  expect(cancelled).toBe(true);
});
