import { lcwUncompress } from './lcw.ts';
import { ImaStream } from './aud.ts';
import type { ByteSource } from './remote-mix.ts';

const tag = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
export interface VqaFrame {
  pixels: Uint8Array;
  palette: Uint8Array;
  paletteIndex: number;
  audio: Uint8Array[];
}

/** Indexed C&C VQA v2. Chunk layout and codebook timing cross-checked against OpenRA VqaVideo. */
export class VqaVideo {
  private frame = 0;
  private paletteIndex = -1;
  private readonly palette = new Uint8Array(768);
  private readonly pixels: Uint8Array;
  private readonly book: Uint8Array;
  private readonly partial: Uint8Array;
  private readonly pointers: Uint8Array;
  private partialCount = 0;
  private partialSize = 0;
  private compressedPartial = false;
  private readonly ima = new ImaStream();
  private constructor(private readonly source: ByteSource, readonly width: number, readonly height: number,
    readonly fps: number, readonly frameCount: number, readonly sampleRate: number, readonly sampleBits: number,
    readonly channels: number, private readonly blockWidth: number, private readonly blockHeight: number,
    private readonly parts: number, private readonly offsets: number[]) {
    this.pixels = new Uint8Array(width * height);
    this.book = new Uint8Array(width * height);
    this.partial = new Uint8Array(width * height);
    this.pointers = new Uint8Array(width * height * 2 / (blockWidth * blockHeight));
  }
  static async open(source: ByteSource, signal?: AbortSignal) {
    const start = await source.read(0, 20, signal);
    if (tag(start, 0) !== 'FORM' || tag(start, 8) !== 'WVQA' || tag(start, 12) !== 'VQHD')
      throw new Error('Invalid VQA header');
    const length = new DataView(start.buffer, start.byteOffset, start.byteLength).getUint32(16);
    const header = await source.read(20, length, signal), view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint16(2, true) & 0x10) throw new Error('High-color VQA is not a C&C Gold format');
    const count = view.getUint16(4, true), width = view.getUint16(6, true), height = view.getUint16(8, true);
    let at = 20 + length;
    while (at + 8 <= source.size) {
      const chunk = await source.read(at, 8, signal);
      const size = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint32(4);
      if (tag(chunk, 0) === 'FINF') {
        const table = await source.read(at + 8, count * 4, signal);
        const words = new DataView(table.buffer, table.byteOffset, table.byteLength);
        const offsets = Array.from({ length: count }, (_, i) => (words.getUint32(i * 4, true) & 0x3fffffff) * 2);
        offsets.push(source.size);
        return new VqaVideo(source, width, height, header[12], count, view.getUint16(24, true), header[27], header[26], header[10], header[11], header[13], offsets);
      }
      at += 8 + size + (size & 1);
    }
    throw new Error('VQA frame directory missing');
  }
  /** Buffers are reused; callers that retain a frame must copy its pixels and palette. */
  async next(signal?: AbortSignal): Promise<VqaFrame | undefined> {
    if (this.frame === this.frameCount) return undefined;
    const offset = this.offsets[this.frame], end = this.offsets[++this.frame];
    const bytes = await this.source.read(offset, end - offset, signal);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), audio: Uint8Array[] = [];
    for (let at = 0; at + 8 <= bytes.length;) {
      if (bytes[at] === 0) { at++; continue; }
      const type = tag(bytes, at), size = view.getUint32(at + 4), data = bytes.subarray(at + 8, at + 8 + size);
      if (at + 8 + size > bytes.length) throw new Error('Truncated VQA frame');
      if (type === 'VQFR' || type === 'VQFL') this.decode(data);
      else if (type === 'SND0') audio.push(data.slice());
      else if (type === 'SND2') {
        if (this.channels !== 1) throw new Error('C&C Gold movies require mono IMA audio');
        audio.push(this.ima.decode(data));
      }
      at += 8 + size;
    }
    const blockPixels = this.blockWidth * this.blockHeight, columns = this.width / this.blockWidth, blocks = this.pointers.length / 2;
    for (let block = 0; block < blocks; block++) {
      const low = this.pointers[block], high = this.pointers[block + blocks], book = (low + high * 256) * blockPixels;
      const x = (block % columns) * this.blockWidth, y = Math.trunc(block / columns) * this.blockHeight;
      for (let dy = 0; dy < this.blockHeight; dy++) for (let dx = 0; dx < this.blockWidth; dx++)
        this.pixels[(y + dy) * this.width + x + dx] = high === 15 ? low : this.book[book + dy * this.blockWidth + dx];
    }
    return { pixels: this.pixels, palette: this.palette, paletteIndex: this.paletteIndex, audio };
  }
  private decode(bytes: Uint8Array) {
    if (this.parts && this.partialCount === this.parts) {
      if (this.compressedPartial) lcwUncompress(this.partial, 0, this.book);
      else this.book.set(this.partial.subarray(0, this.partialSize));
      this.partialCount = this.partialSize = 0;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 8 <= bytes.length;) {
      if (bytes[at] === 0) { at++; continue; }
      const type = tag(bytes, at), size = view.getUint32(at + 4), data = bytes.subarray(at + 8, at + 8 + size);
      if (at + 8 + size > bytes.length) throw new Error('Truncated VQA chunk');
      switch (type) {
        case 'CPL0': this.palette.set(data); this.paletteIndex++; break;
        case 'CBF0': this.book.set(data); break;
        case 'CBFZ': this.book.fill(0); lcwUncompress(data, data[0] === 0 ? 1 : 0, this.book, data[0] === 0); break;
        case 'CBP0': case 'CBPZ':
          this.partial.set(data, this.partialSize); this.partialSize += size; this.partialCount++;
          this.compressedPartial = type === 'CBPZ'; break;
        case 'VPTZ': lcwUncompress(data, 0, this.pointers); break;
        default: throw new Error(`Unsupported C&C VQA chunk: ${type}`);
      }
      at += 8 + size;
    }
  }
}

/** Ported from CONQUER.CPP, Load_Interpolated_Palettes/Rebuild_Interpolated_Palette. */
export function vqpTable(bytes: Uint8Array, index: number): Uint8Array {
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (index < 0 || index >= count) throw new Error('VQP palette index out of range');
  let at = 4 + index * 32896;
  if (at + 32896 > bytes.length) throw new Error('Truncated VQP table');
  const table = new Uint8Array(65536);
  for (let y = 0; y < 256; y++) for (let x = 0; x <= y; x++) {
    table[y * 256 + x] = table[x * 256 + y] = bytes[at++];
  }
  return table;
}
