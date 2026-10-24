import {
  AddEquation, BufferAttribute, CustomBlending, DataTexture, DoubleSide, InstancedBufferGeometry, Mesh,
  MeshBasicNodeMaterial, NearestFilter, OneFactor, OneMinusSrcAlphaFactor, OrthographicCamera, QuadMesh, RedFormat,
  RenderTarget, RGBAFormat, StorageBufferAttribute, UnsignedByteType, UnsignedIntType, RedIntegerFormat, Vector2,
  type Node, type Texture, type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn, If, Loop, Discard, float, floor, int, ivec2, positionGeometry, screenCoordinate, select, storage, textureLoad,
  uint, uniform, varying, vec4, instanceIndex, Break,
} from 'three/tsl';
import type { AtlasRegion, IndexedImage } from './atlas.ts';
import { composeFilters } from './filters.ts';
import { BIN_SIZE, GpuSpatialIndex } from './spatial-index.ts';
import { releaseStorage } from '../simulation/resources.ts';

/** The tile value for a cell that draws palette index 0. */
export const NO_TILE = 0xffffffff;

/** A grid of square tiles, such as terrain. */
export interface TileMap {
  /** Tile side in pixels. */
  tileSize: number;
  /** Every tile, packed row by row; its width is a multiple of tileSize. */
  atlas: IndexedImage;
  /** Tile number for each cell, row by row, or NO_TILE. */
  cells: Uint32Array;
  columns: number;
  rows: number;
}

/** One sprite to draw. Sprites are drawn in the order given, each over the ones before it. */
export interface Sprite {
  /** Top-left corner in world pixels. */
  x: number;
  y: number;
  /** The image in the sprite atlas. */
  region: AtlasRegion;
  /** Which remap table converts the sprite's indices before they are drawn. */
  remap: number;
  /** Whether shadow pixels darken what lies under them. Otherwise they are drawn as plain indices. */
  shadow: boolean;
  /** Apply this filter to the destination, using filters from PaletteSetup. */
  filter?: number;
  /** Sample the destination at the offset supplied by PaletteSetup.displacement. */
  displace?: boolean;
}

export interface DisplacementInput {
  local: Node<'ivec2'>;
  rect: Node<'vec4'>;
  atlas: Node<'vec4'>;
  origin: Node<'vec2'>;
  size: Node<'vec2'>;
  time: Node<'float'>;
  /** Negative in time-driven asset previews; otherwise the actual simulation tick. */
  frame: Node<'int'>;
}

export interface PaletteSetup {
  /** 256 RGBA colors. */
  palette: Uint8Array;
  /** 256 entries; a sprite pixel whose index has a non-zero entry is a shadow pixel. */
  shadowSources: Uint8Array;
  /** 256 entries: the index a shadow turns the index under it into. */
  shadowTable: Uint8Array;
  /** Remap tables of 256 entries each. */
  remaps: readonly Uint8Array[];
  tiles: TileMap;
  spriteAtlas: IndexedImage;
  /** The most sprites setSprites() may be given. */
  spriteCapacity: number;
  filters?: readonly Uint8Array[];
  /** Optional ordered filter used at most once along a pixel's contributors, after filters[]. */
  singleUseFilter?: Uint8Array;
  /** Game-supplied pixel offset shader, owned and disposed by this pipeline. */
  displacement?: { offset(input: DisplacementInput): Node<'ivec2'>; dispose(): void };
  dynamicSprites?: { maxWidth: number; maxHeight: number };
  /** Optional diagnostic overlay in world pixel coordinates, applied after palette lookup. */
  overlay?: (pixel: Node<'vec2'>, color: Node<'vec4'>) => Node<'vec4'>;
  /** Game-supplied indexed effect, before the palette lookup (for example unexplored terrain). */
  indexEffect?: (pixel: Node<'ivec2'>, index: Node<'int'>) => Node<'int'>;
}

/** The part of the world the view shows: top-left in world pixels and size in image pixels. */
export interface View {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A sprite pixel can lie under this many shadows at most before more are ignored.
const MAX_SHADOWS = 4;
const LOOKUP_WIDTH = 1024;

function indexTexture(image: IndexedImage): DataTexture {
  return dataTexture(image.pixels, image.width, image.height, RedFormat);
}

function dataTexture(data: Uint8Array, width: number, height: number, format: typeof RedFormat | typeof RGBAFormat) {
  const texture = new DataTexture(data, width, height, format, UnsignedByteType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function indexTarget(format: typeof RedFormat | typeof RGBAFormat) {
  return new RenderTarget(1, 1, {
    format, type: UnsignedByteType, depthBuffer: false, generateMipmaps: false,
    minFilter: NearestFilter, magFilter: NearestFilter,
  });
}

/** Reads an index from a single-channel 8-bit texture. */
const loadIndex = (texture: Texture, x: Node<'int'>, y: Node<'int'>) =>
  int(textureLoad(texture, ivec2(x, y)).r.mul(255).round());

/**
 * Draws palette-indexed images (technical constitution, article 3). Every pass up to the last keeps
 * indices: the tile map goes into one target, the sprites into another, and a composite pass merges
 * them into the index image. Only the present pass looks colors up in the palette.
 *
 * A shadow turns the index under it into a darker one, so it has to read what has been drawn before
 * it, and a pass cannot read the target it draws into. The sprite pass therefore keeps two channels:
 * the index of the topmost sprite pixel, and how many shadow pixels have been drawn over that pixel
 * since. Blending keeps both in draw order, because fixed-function blending follows the order the
 * sprites are drawn in. The composite pass then applies the shadow table that many times to the
 * sprite index, or to the tile index where no sprite pixel was drawn. This matches drawing every
 * sprite in turn onto the finished image, as long as the remap tables leave the indices the shadow
 * table produces alone.
 */
export class PalettePipeline {
  private readonly tileTarget = indexTarget(RedFormat);
  // Blending reads the alpha the sprite pass writes, so its target needs all four channels.
  private readonly spriteTarget = indexTarget(RGBAFormat);
  private readonly indexTarget = indexTarget(RedFormat);
  private readonly origin = uniform(new Vector2());
  private readonly size = uniform(new Vector2(1, 1));
  private readonly scale = uniform(1);
  private readonly textures: DataTexture[] = [];
  private readonly buffers: StorageBufferAttribute[] = [];
  private readonly instances: StorageBufferAttribute;
  private readonly spriteGeometry = new InstancedBufferGeometry();
  private readonly spriteMesh: Mesh;
  private readonly tilePass: QuadMesh;
  private readonly compositePass: QuadMesh;
  private readonly presentPass: QuadMesh;
  private readonly camera = new OrthographicCamera();
  private readonly capacity: number;
  private readonly renderer: WebGPURenderer;
  private readonly palette: DataTexture;
  private readonly time = uniform(0);
  private readonly frame = uniform(-1, 'int');
  private readonly count = uniform(0, 'int');
  private readonly lookup: DataTexture;
  private readonly binColumns: number;
  private readonly binRows: number;
  private readonly worldSprites: Sprite[] = [];
  private readonly setup: PaletteSetup;
  private readonly spatial?: GpuSpatialIndex;
  private dynamicCount = 0;

  get spriteBuffer() { return this.instances; }

  constructor(renderer: WebGPURenderer, setup: PaletteSetup) {
    this.renderer = renderer;
    this.setup = setup;
    const keep = (texture: DataTexture) => {
      this.textures.push(texture);
      return texture;
    };
    const palette = keep(dataTexture(setup.palette, 256, 1, RGBAFormat));
    this.palette = palette;
    const shadow = new Uint8Array(512);
    shadow.set(setup.shadowSources.map((value) => (value ? 1 : 0)));
    shadow.set(setup.shadowTable, 256);
    const shadowTexture = keep(dataTexture(shadow, 256, 2, RedFormat));
    const remaps = new Uint8Array(256 * setup.remaps.length);
    setup.remaps.forEach((table, row) => remaps.set(table, row * 256));
    const remapTexture = keep(dataTexture(remaps, 256, setup.remaps.length, RedFormat));
    const tileAtlas = keep(indexTexture(setup.tiles.atlas));
    const spriteAtlas = keep(indexTexture(setup.spriteAtlas));
    this.binColumns = Math.ceil(setup.tiles.columns * setup.tiles.tileSize / BIN_SIZE);
    this.binRows = Math.ceil(setup.tiles.rows * setup.tiles.tileSize / BIN_SIZE);
    this.lookup = keep(new DataTexture(new Uint32Array(LOOKUP_WIDTH), LOOKUP_WIDTH, 1, RedIntegerFormat, UnsignedIntType));
    this.lookup.needsUpdate = true;

    this.tilePass = new QuadMesh(this.tileMaterial(setup.tiles, tileAtlas));

    // Three vec4 per sprite: rectangle; atlas position, remap, shadow; filter and displacement flags.
    this.capacity = setup.spriteCapacity;
    this.instances = new StorageBufferAttribute(new Float32Array(Math.max(1, this.capacity) * 12), 4);
    this.buffers.push(this.instances);
    if (setup.dynamicSprites) this.spatial = new GpuSpatialIndex(renderer, this.instances, this.capacity,
      this.binColumns, this.binRows, setup.dynamicSprites.maxWidth, setup.dynamicSprites.maxHeight);
    const corners = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    this.spriteGeometry.setAttribute('position', new BufferAttribute(corners, 3));
    this.spriteGeometry.setIndex([0, 2, 1, 2, 3, 1]);
    this.spriteGeometry.instanceCount = 0;
    this.spriteMesh = new Mesh(this.spriteGeometry, this.spriteMaterial(spriteAtlas, shadowTexture, remapTexture));
    this.spriteMesh.frustumCulled = false;

    this.compositePass = new QuadMesh(this.compositeMaterial(shadowTexture, spriteAtlas, remapTexture, keep));
    this.presentPass = new QuadMesh(this.presentMaterial(palette));
  }

  private tileMaterial(tiles: TileMap, atlas: DataTexture) {
    const attribute = new StorageBufferAttribute(tiles.cells, 1);
    this.buffers.push(attribute);
    const cells = storage(attribute, 'uint', tiles.cells.length).toReadOnly();
    const perRow = Math.floor(tiles.atlas.width / tiles.tileSize);
    const material = new MeshBasicNodeMaterial();
    material.fragmentNode = Fn(() => {
      const pixel = floor(screenCoordinate.xy).add(this.origin);
      const cellX = int(floor(pixel.x.div(tiles.tileSize)));
      const cellY = int(floor(pixel.y.div(tiles.tileSize)));
      const inside = cellX.greaterThanEqual(0).and(cellY.greaterThanEqual(0))
        .and(cellX.lessThan(tiles.columns)).and(cellY.lessThan(tiles.rows));
      const tile = cells.element(select(inside, uint(cellY.mul(tiles.columns).add(cellX)), uint(0))).toVar();
      If(inside.not(), () => {
        tile.assign(uint(NO_TILE));
      });
      const index = float(0).toVar();
      If(tile.notEqual(uint(NO_TILE)), () => {
        const x = int(tile.mod(uint(perRow))).mul(tiles.tileSize).add(int(pixel.x).sub(cellX.mul(tiles.tileSize)));
        const y = int(tile.div(uint(perRow))).mul(tiles.tileSize).add(int(pixel.y).sub(cellY.mul(tiles.tileSize)));
        index.assign(textureLoad(atlas, ivec2(x, y)).r);
      });
      return vec4(index, 0, 0, 1);
    })();
    return material;
  }

  private spriteMaterial(atlas: DataTexture, shadow: DataTexture, remaps: DataTexture) {
    const instances = storage(this.instances, 'vec4', Math.max(1, this.capacity) * 3).toReadOnly();
    const rect = instances.element(instanceIndex.mul(3));
    const info = instances.element(instanceIndex.mul(3).add(1));
    const effect = varying(instances.element(instanceIndex.mul(3).add(2))).setInterpolation('flat');
    const flatRect = varying(rect).setInterpolation('flat');
    const flatInfo = varying(info).setInterpolation('flat');

    const material = new MeshBasicNodeMaterial();
    material.side = DoubleSide;
    material.depthTest = false;
    material.depthWrite = false;
    // Sprite pixels replace the index and reset the shadow count (alpha 1); shadow pixels keep the
    // index and add one to the count (alpha 0).
    material.blending = CustomBlending;
    material.blendEquation = AddEquation;
    material.blendSrc = OneFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
    material.blendEquationAlpha = AddEquation;
    material.blendSrcAlpha = OneFactor;
    material.blendDstAlpha = OneMinusSrcAlphaFactor;
    material.vertexNode = Fn(() => {
      const world = rect.xy.add(positionGeometry.xy.mul(rect.zw));
      const screen = world.sub(this.origin).div(this.size);
      return vec4(screen.x.mul(2).sub(1), screen.y.mul(-2).add(1), 0, 1);
    })();
    material.fragmentNode = Fn(() => {
      const local = floor(screenCoordinate.xy).add(this.origin).sub(flatRect.xy);
      const source = loadIndex(atlas, int(flatInfo.x.add(local.x)), int(flatInfo.y.add(local.y)));
      Discard(source.equal(0));
      // A destination-dependent pixel marks the slow path. Later opaque pixels clear that mark.
      const isShadow = flatInfo.w.greaterThan(0.5).and(textureLoad(shadow, ivec2(source, 0)).r.greaterThan(0));
      const remapped = textureLoad(remaps, ivec2(source, int(flatInfo.z))).r;
      return select(effect.x.greaterThan(0).or(effect.y.greaterThan(0)), vec4(0, 0, 1, 1),
        select(isShadow, vec4(0, 1 / 255, 0, 0), vec4(remapped, 0, 0, 1)));
    })();
    return material;
  }

  private compositeMaterial(shadow: DataTexture, atlas: DataTexture, remaps: DataTexture,
    keep: (texture: DataTexture) => DataTexture) {
    const material = new MeshBasicNodeMaterial();
    const filters = [this.setup.shadowTable, ...(this.setup.filters ?? [])];
    const composition = composeFilters(filters);
    const maps = keep(dataTexture(composition.maps, 256, composition.count, RedFormat));
    const transitions = keep(dataTexture(composition.transitions, filters.length, composition.count, RedFormat));
    const singleFilter = this.setup.singleUseFilter && keep(dataTexture(this.setup.singleUseFilter, 256, 1, RedFormat));
    const instances = storage(this.instances, 'vec4', Math.max(1, this.capacity) * 3).toReadOnly();
    const staticEntry = (index: Node<'int'>) => int(textureLoad(this.lookup,
      ivec2(index.mod(LOOKUP_WIDTH), index.div(LOOKUP_WIDTH))).r);
    const offsets = this.spatial && storage(this.spatial.offsets, 'uint', this.spatial.offsets.count).toReadOnly();
    const items = this.spatial && storage(this.spatial.items, 'uint', this.spatial.items.count).toReadOnly();
    const entry = (index: Node<'int'>) => offsets ? int(offsets.element(index)) : staticEntry(index);
    const spriteAt = (index: Node<'int'>) => items ? int(items.element(index)) : staticEntry(index);
    // Only bins touched by a displacement/filter are visited. Each bin lists its sprites in draw
    // order. Following a displacement lowers the order limit, so foreground objects cannot leak in.
    const resolve = Fn(([start]: [Node<'ivec2'>]) => {
      const pixel = start.toVar();
      const limit = this.count.toVar();
      const mapping = int(0).toVar();
      const outerMapping = int(-1).toVar();
      const color = int(0).toVar();
      Loop(this.count.add(1), () => {
        // The sampled image is the clipped view. A displaced read must not resurrect sprites
        // beyond its edges, even when the spatial index also contains those sprites.
        const screen = pixel.sub(ivec2(this.origin));
        If(screen.x.lessThan(0).or(screen.y.lessThan(0)).or(screen.x.greaterThanEqual(int(this.size.x)))
          .or(screen.y.greaterThanEqual(int(this.size.y))), () => { Break(); });
        const found = int(-1).toVar();
        const source = int(0).toVar();
        const bin = ivec2(floor(pixel.toVec2().div(BIN_SIZE))).toVar();
        If(bin.x.greaterThanEqual(0).and(bin.y.greaterThanEqual(0))
          .and(bin.x.lessThan(this.binColumns)).and(bin.y.lessThan(this.binRows)), () => {
          const cell = bin.y.mul(this.binColumns).add(bin.x);
          Loop({ start: entry(cell.add(1)).sub(1), end: entry(cell), condition: '>=', update: '--', type: 'int' }, ({ i }) => {
            const id = spriteAt(i);
            If(id.lessThan(limit).and(id.greaterThan(found)), () => {
              const rect = instances.element(id.mul(3));
              const info = instances.element(id.mul(3).add(1));
              const local = pixel.sub(ivec2(rect.xy));
              If(local.x.greaterThanEqual(0).and(local.y.greaterThanEqual(0))
                .and(local.x.lessThan(int(rect.z))).and(local.y.lessThan(int(rect.w))), () => {
                const index = loadIndex(atlas, int(info.x).add(local.x), int(info.y).add(local.y));
                If(index.notEqual(0), () => {
                  found.assign(id); source.assign(index);
                  if (!this.spatial) Break();
                });
              });
            });
          });
        });
        If(found.lessThan(0), () => {
          const local = pixel.sub(ivec2(this.origin));
          color.assign(loadIndex(this.tileTarget.texture, local.x, local.y));
          Break();
        });
        const rect = instances.element(found.mul(3));
        const info = instances.element(found.mul(3).add(1));
        const effect = instances.element(found.mul(3).add(2));
        limit.assign(found);
        const filter = int(effect.x).sub(1).toVar();
        If(effect.y.greaterThan(0), () => {
          if (this.setup.displacement) pixel.addAssign(this.setup.displacement.offset({
            local: pixel.sub(ivec2(rect.xy)), rect, atlas: info, origin: this.origin, size: this.size, time: this.time, frame: this.frame,
          }));
        }).Else(() => {
          If(filter.lessThan(0).and(info.w.greaterThan(0.5))
            .and(textureLoad(shadow, ivec2(source, 0)).r.greaterThan(0)), () => { filter.assign(0); });
          If(filter.greaterThanEqual(0), () => {
            if(singleFilter){
              If(filter.equal(filters.length),()=>{outerMapping.assign(mapping);mapping.assign(0);})
                .Else(()=>{mapping.assign(loadIndex(transitions,filter,mapping));});
            }else mapping.assign(loadIndex(transitions, filter, mapping));
          }).Else(() => {
            color.assign(loadIndex(remaps, source, int(info.z)));
            Break();
          });
        });
      });
      const resolved=loadIndex(maps,color,mapping).toVar();
      if(singleFilter) If(outerMapping.greaterThanEqual(0),()=>{
        resolved.assign(loadIndex(maps,loadIndex(singleFilter,resolved,int(0)),outerMapping));
      });
      return resolved;
    });
    material.fragmentNode = Fn(() => {
      const x = int(screenCoordinate.x);
      const y = int(screenCoordinate.y);
      const sprite = textureLoad(this.spriteTarget.texture, ivec2(x, y));
      const spriteIndex = int(sprite.r.mul(255).round());
      const index = select(spriteIndex.greaterThan(0), spriteIndex, loadIndex(this.tileTarget.texture, x, y)).toVar();
      const shadows = int(sprite.g.mul(255).round());
      Loop(MAX_SHADOWS, ({ i }) => {
        If(int(i).lessThan(shadows), () => {
          index.assign(loadIndex(shadow, index, int(1)));
        });
      });
      If(sprite.b.greaterThan(0.5), () => { index.assign(resolve(ivec2(x, y).add(ivec2(this.origin)))); });
      return vec4(float(index).div(255), 0, 0, 1);
    })();
    return material;
  }

  private presentMaterial(palette: DataTexture) {
    const material = new MeshBasicNodeMaterial();
    material.fragmentNode = Fn(() => {
      const pixel = floor(screenCoordinate.xy.div(this.scale));
      const sampled = loadIndex(this.indexTarget.texture, int(pixel.x), int(pixel.y));
      const index = this.setup.indexEffect ? this.setup.indexEffect(ivec2(pixel.add(this.origin)), sampled) : sampled;
      const color = vec4(textureLoad(palette, ivec2(index, 0)).rgb, 1);
      return this.setup.overlay ? this.setup.overlay(pixel.add(this.origin), color) : color;
    })();
    return material;
  }

  /**
   * Writes sprites into the draw list from position first on, and draws the list up to the last of
   * them. Only that part of the instance buffer is uploaded. When effects are enabled this also
   * rebuilds the static spatial index; use setOverlay for a cursor that changes every frame.
   */
  setSprites(sprites: readonly Sprite[], first = 0) {
    const count = first + sprites.length;
    if (count > this.capacity) {
      throw new Error(`${count} sprites exceed the capacity of ${this.capacity}`);
    }
    const data = this.instances.array as Float32Array;
    sprites.forEach((sprite, index) => {
      const { region } = sprite;
      const shadow = sprite.shadow ? 1 : 0;
      data.set([sprite.x, sprite.y, region.width, region.height, region.x, region.y, sprite.remap, shadow,
        sprite.filter === undefined ? 0 : sprite.filter + 2, sprite.displace ? 1 : 0, 0, 0], (first + index) * 12);
      this.worldSprites[first + index] = sprite;
    });
    if (sprites.length > 0) {
      this.instances.addUpdateRange(first * 12, sprites.length * 12);
      this.instances.needsUpdate = true;
    }
    this.spriteGeometry.instanceCount = count;
    this.count.value = count;
    this.worldSprites.length = count;
    if (this.setup.displacement || this.setup.filters?.length) this.indexSprites();
  }

  private indexSprites() {
    const bins: number[][] = Array.from({ length: this.binColumns * this.binRows }, () => []);
    this.worldSprites.forEach((sprite, i) => {
      const left = Math.max(0, Math.floor(sprite.x / BIN_SIZE)), top = Math.max(0, Math.floor(sprite.y / BIN_SIZE));
      const right = Math.min(this.binColumns - 1, Math.floor((sprite.x + sprite.region.width - 1) / BIN_SIZE));
      const bottom = Math.min(this.binRows - 1, Math.floor((sprite.y + sprite.region.height - 1) / BIN_SIZE));
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) bins[y * this.binColumns + x].push(i);
    });
    const values = new Array<number>(bins.length + 1);
    bins.forEach((bin, i) => { values[i] = values.length; values.push(...bin); });
    values[bins.length] = values.length;
    const height = Math.max(1, Math.ceil(values.length / LOOKUP_WIDTH));
    if (this.lookup.image.height !== height) this.lookup.dispose();
    const data = new Uint32Array(LOOKUP_WIDTH * height);
    data.set(values);
    this.lookup.image = { data, width: LOOKUP_WIDTH, height };
    this.lookup.needsUpdate = true;
  }

  /** A final screen overlay does not participate in destination lookups behind world sprites. */
  setOverlay(sprite: Sprite | null) {
    const first = this.spatial ? this.dynamicCount : this.worldSprites.length;
    if (first + (sprite ? 1 : 0) > this.capacity) throw new Error('no capacity for the overlay');
    this.spriteGeometry.instanceCount = first + (sprite ? 1 : 0);
    if (!sprite) return;
    const r = sprite.region;
    (this.instances.array as Float32Array).set([sprite.x, sprite.y, r.width, r.height, r.x, r.y, sprite.remap, 0, 0, 0, 0, 0], first * 12);
    this.instances.addUpdateRange(first * 12, 12);
    this.instances.needsUpdate = true;
  }

  setTime(time: number) { this.time.value = time; }

  setFrame(frame: number) { this.frame.value = frame; }

  /** Call after compute has written the draw list, once per simulation tick. */
  updateGpuSprites(count: number) {
    if (!this.spatial || count > this.capacity) throw new Error('Invalid dynamic sprite count');
    this.dynamicCount = count; this.count.value = count;
    this.spriteGeometry.instanceCount = count;
    this.spatial.rebuild(count);
  }

  /** Draws the index image of the view, without presenting it. */
  private drawIndices(view: View) {
    for (const target of [this.tileTarget, this.spriteTarget, this.indexTarget]) {
      if (target.width !== view.width || target.height !== view.height) target.setSize(view.width, view.height);
    }
    this.origin.value.set(view.x, view.y);
    this.size.value.set(view.width, view.height);
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.tileTarget);
    this.tilePass.render(this.renderer);
    this.renderer.setRenderTarget(this.spriteTarget);
    this.renderer.render(this.spriteMesh, this.camera);
    this.renderer.setRenderTarget(this.indexTarget);
    this.compositePass.render(this.renderer);
    this.renderer.setRenderTarget(previous);
  }

  /** Changes presentation colors without changing any index image or sprite data. */
  setPalette(colors: Uint8Array) {
    (this.palette.image.data as Uint8Array).set(colors);
    this.palette.needsUpdate = true;
  }

  /** Draws the view and presents it on the canvas, each image pixel as scale × scale device pixels. */
  render(view: View, scale: number) {
    this.drawIndices(view);
    this.scale.value = scale;
    this.presentPass.render(this.renderer);
  }

  /** Draws the view and reads its index image back, row by row from the top. */
  async readIndices(view: View): Promise<Uint8Array> {
    this.drawIndices(view);
    const { width, height } = view;
    const data = await this.renderer.readRenderTargetPixelsAsync(this.indexTarget, 0, 0, width, height) as Uint8Array;
    // Rows come back padded to a multiple of 256 bytes.
    const stride = Math.ceil(width / 256) * 256;
    const pixels = new Uint8Array(width * height);
    for (let row = 0; row < height; row++) pixels.set(data.subarray(row * stride, row * stride + width), row * width);
    return pixels;
  }

  dispose() {
    this.spatial?.dispose();
    this.setup.displacement?.dispose();
    for (const texture of this.textures) texture.dispose();
    for (const target of [this.tileTarget, this.spriteTarget, this.indexTarget]) target.dispose();
    for (const mesh of [this.tilePass, this.compositePass, this.presentPass, this.spriteMesh]) {
      (mesh.material as MeshBasicNodeMaterial).dispose();
    }
    this.spriteGeometry.dispose();
    releaseStorage(this.renderer, this.buffers);
  }
}
