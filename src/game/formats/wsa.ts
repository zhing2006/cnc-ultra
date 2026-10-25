import { lcwUncompress } from './lcw.ts';
import { applyXorDelta } from './shp.ts';

/** WSA header and consecutive LCW/XOR deltas, checked against OpenRA WsaVideo. */
export class WsaVideo {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly frameCount: number;
  readonly palette: Uint8Array;
  readonly pixels: Uint8Array;
  private readonly offsets: number[];
  private readonly delta: Uint8Array;
  private frame = -1;
  constructor(private readonly bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.frameCount = view.getUint16(0, true);
    this.x = view.getInt16(2, true); this.y = view.getInt16(4, true);
    this.width = view.getUint16(6, true); this.height = view.getUint16(8, true);
    const paletteSize = view.getUint16(12, true) & 1 ? 768 : 0;
    const at = 14 + (this.frameCount + 2) * 4;
    this.palette = bytes.slice(at, at + paletteSize);
    this.offsets = Array.from({ length: this.frameCount + 2 }, (_, i) => view.getUint32(14 + i * 4, true) + paletteSize);
    this.pixels = new Uint8Array(this.width * this.height);
    this.delta = new Uint8Array(Math.max(this.pixels.length + 1024, view.getUint16(10, true)));
  }
  next() {
    this.frame++;
    if (this.frame >= this.frameCount) { this.frame = 0; this.pixels.fill(0); }
    lcwUncompress(this.bytes, this.offsets[this.frame], this.delta);
    applyXorDelta(this.pixels, this.delta, 0);
    return this.pixels;
  }
  frameAt(index: number) {
    if (index < 0 || index >= this.frameCount) throw new RangeError('WSA frame is outside the animation');
    if (index < this.frame) { this.frame = -1; this.pixels.fill(0); }
    while (this.frame < index) this.next();
    return this.pixels;
  }
}
