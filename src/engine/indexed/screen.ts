import { DataTexture, MeshBasicNodeMaterial, NearestFilter, QuadMesh, RedFormat, RGBAFormat, UnsignedByteType, Vector2, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, int, ivec2, screenCoordinate, textureLoad, uniform, vec4 } from 'three/tsl';
import { intMin } from '../simulation/integer-nodes.ts';

/** A small indexed display. Rendering only submits when its contents or viewport change. */
export class IndexedScreen {
  private readonly image: DataTexture;
  private readonly palette: DataTexture;
  private readonly table: DataTexture;
  private readonly foreground: DataTexture;
  private readonly hasForeground = uniform(0, 'int');
  private readonly material = new MeshBasicNodeMaterial();
  private readonly quad: QuadMesh;
  private readonly origin = uniform(new Vector2());
  private readonly scale = uniform(1);
  private readonly doubled = uniform(0, 'int');
  private readonly scanlines = uniform(0, 'int');
  private readonly brightness = uniform(1);
  private readonly overlay = uniform(0, 'int');
  private dirty = true;
  private lastWidth = 0;
  private lastHeight = 0;
  private lastTable?: Uint8Array;
  constructor(private readonly renderer: WebGPURenderer, readonly width = 640, readonly height = 400) {
    const make = (data: Uint8Array, width: number, height: number, rgba = false) => {
      const texture = new DataTexture(data, width, height, rgba ? RGBAFormat : RedFormat, UnsignedByteType);
      texture.minFilter = texture.magFilter = NearestFilter;
      texture.generateMipmaps = false; texture.needsUpdate = true;
      return texture;
    };
    this.image = make(new Uint8Array(width * height), width, height);
    this.palette = make(new Uint8Array(1024), 256, 1, true);
    this.table = make(new Uint8Array(65536), 256, 256);
    this.foreground = make(new Uint8Array(width * height).fill(255), width, height);
    this.material.transparent = true;
    this.material.depthTest = this.material.depthWrite = false;
    const sample = (x: Node<'int'>, y: Node<'int'>) => int(textureLoad(this.image, ivec2(x, y)).r.mul(255).round());
    this.material.fragmentNode = Fn(() => {
      const p = screenCoordinate.sub(this.origin).div(this.scale).floor();
      const color = vec4(0, 0, 0, 1).toVar();
      If(this.overlay.equal(1), () => { color.a.assign(0); });
      If(p.x.greaterThanEqual(0).and(p.y.greaterThanEqual(0)).and(p.x.lessThan(width)).and(p.y.lessThan(height)), () => {
        const x = int(p.x).toVar(), y = int(p.y).toVar();
        If(this.doubled.equal(1), () => { x.divAssign(2); y.divAssign(2); });
        const index = sample(x, y).toVar();
        If(this.doubled.equal(1).and(int(p.x).mod(2).equal(1)), () => {
          const right = sample(intMin(x.add(1), int(width / 2 - 1)), y);
          index.assign(int(textureLoad(this.table, ivec2(index, right)).r.mul(255).round()));
        });
        color.assign(textureLoad(this.palette, ivec2(index, 0)));
        If(this.overlay.equal(1).and(index.equal(255)), () => { color.a.assign(0); });
        If(this.scanlines.equal(1).and(int(p.y).mod(2).equal(1)), () => { color.assign(vec4(0, 0, 0, 1)); });
        If(this.hasForeground.equal(1), () => {
          const ink=int(textureLoad(this.foreground,ivec2(p)).r.mul(255).round());
          If(ink.notEqual(255),()=>{color.assign(textureLoad(this.palette,ivec2(ink,0)));});
        });
      });
      return vec4(color.rgb.mul(this.brightness), color.a);
    })();
    this.quad = new QuadMesh(this.material);
  }
  set(pixels: Uint8Array, palette: Uint8Array, width: number, height: number, table?: Uint8Array, x = 0, y = 0) {
    this.hasForeground.value=0;
    const image = this.image.image.data as Uint8Array;
    image.fill(0);
    for (let row = 0; row < height; row++) image.set(pixels.subarray(row * width, (row + 1) * width), (row + y) * this.width + x);
    const rgba = this.palette.image.data as Uint8Array;
    for (let index = 0; index < 256; index++) {
      for (let channel = 0; channel < 3; channel++) rgba[index * 4 + channel] = palette[index * 3 + channel] << 2;
      rgba[index * 4 + 3] = 255;
    }
    this.image.needsUpdate = this.palette.needsUpdate = true;
    this.doubled.value = table ? 1 : 0;
    this.scanlines.value = table ? 1 : 0;
    if (table && table !== this.lastTable) { (this.table.image.data as Uint8Array).set(table); this.table.needsUpdate = true; this.lastTable = table; }
    this.dirty = true;
  }
  /** Native-resolution indexed foreground, with index 255 transparent. */
  setForeground(pixels: Uint8Array) {
    (this.foreground.image.data as Uint8Array).set(pixels);this.foreground.needsUpdate=true;
    this.hasForeground.value=1;this.dirty=true;
  }
  draw(width: number, height: number) {
    if (!this.dirty && width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width; this.lastHeight = height; this.dirty = false;
    const fit = Math.min(width / this.width, height / this.height);
    this.scale.value = fit >= 1 ? Math.floor(fit) : fit;
    this.origin.value.set(Math.floor((width - this.width * this.scale.value) / 2), Math.floor((height - this.height * this.scale.value) / 2));
    this.renderer.setRenderTarget(null);
    const clear = this.renderer.autoClear;
    if (this.overlay.value) this.renderer.autoClear = false;
    this.quad.render(this.renderer);
    this.renderer.autoClear = clear;
  }
  setOverlay(enabled: boolean) { this.overlay.value = Number(enabled); this.dirty = true; }
  get fadeLevel() { return this.brightness.value; }
  fade(value: number) { this.brightness.value = value; this.dirty = true; }
  dispose() { this.image.dispose(); this.palette.dispose(); this.table.dispose(); this.foreground.dispose(); this.material.dispose(); }
}
