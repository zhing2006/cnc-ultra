import { mixId } from './mix.ts';

export interface ByteSource {
  readonly size: number;
  read(offset: number, size: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Strict partial reads: a host ignoring Range must not download a 400 MB movie archive. */
export async function readRange(url: URL, offset: number, size: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!size) return new Uint8Array();
  const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + size - 1}` }, signal });
  const content = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
  if (response.status !== 206 || !content || Number(content[1]) !== offset || Number(content[2]) !== offset + size - 1) {
    await response.body?.cancel();
    throw new Error(`${url.pathname}: byte range unavailable (HTTP ${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== size) throw new Error(`${url.pathname}: incomplete byte range`);
  return bytes;
}

/** MIXFILE.H's six-byte header and twelve-byte entries, without loading the archive body. */
export class RemoteMix {
  private readonly entries = new Map<number, { offset: number; size: number }>();
  private constructor(private readonly url: URL, table: Uint8Array, start: number, bodySize: number) {
    const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
    for (let at = 0; at < table.length; at += 12) {
      const offset = view.getUint32(at + 4, true), size = view.getUint32(at + 8, true);
      if (offset + size > bodySize) throw new Error(`${url.pathname}: invalid MIX directory`);
      this.entries.set(view.getUint32(at, true), { offset: start + offset, size });
    }
  }
  static async open(url: URL, signal?: AbortSignal) {
    const header = await readRange(url, 0, 6, signal);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const length = view.getUint16(0, true) * 12;
    return new RemoteMix(url, await readRange(url, 6, length, signal), 6 + length, view.getUint32(2, true));
  }
  get(name: string): ByteSource | undefined {
    const entry = this.entries.get(mixId(name));
    if (!entry) return undefined;
    return {
      size: entry.size,
      read: (offset, size, signal) => {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > entry.size)
          throw new Error(`${name}: read outside MIX member`);
        return readRange(this.url, entry.offset + offset, size, signal);
      },
    };
  }
}

/** Read-ahead window shared by consecutive frames. A seek discards the old window. */
export class BufferedSource implements ByteSource {
  readonly size: number;
  private offset = 0;
  private bytes: Uint8Array = new Uint8Array();
  constructor(private readonly source: ByteSource, private readonly windowSize = 256 * 1024) { this.size = source.size; }
  async read(offset: number, size: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (offset < this.offset || offset + size > this.offset + this.bytes.length) {
      this.bytes = await this.source.read(offset, Math.min(this.size - offset, Math.max(size, this.windowSize)), signal);
      this.offset = offset;
    }
    return this.bytes.subarray(offset - this.offset, offset - this.offset + size);
  }
}
