import {
  AddEquation, BufferAttribute, CustomBlending, DataTexture, DoubleSide, InstancedBufferGeometry, Mesh,
  MeshBasicNodeMaterial, NearestFilter, OneFactor, OneMinusSrcAlphaFactor, OrthographicCamera, QuadMesh, RedFormat,
  RenderTarget, RGBAFormat, StorageBufferAttribute, UnsignedByteType, Vector2,
  type Node, type Texture, type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn, If, Loop, Discard, float, floor, int, ivec2, positionGeometry, screenCoordinate, select, storage, textureLoad,
  uint, uniform, varying, vec4, instanceIndex,
} from 'three/tsl';
import type { AtlasRegion, IndexedImage } from './atlas.ts';

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
  private readonly instances: StorageBufferAttribute;
  private readonly spriteGeometry = new InstancedBufferGeometry();
  private readonly spriteMesh: Mesh;
  private readonly tilePass: QuadMesh;
  private readonly compositePass: QuadMesh;
  private readonly presentPass: QuadMesh;
  private readonly camera = new OrthographicCamera();
  private readonly capacity: number;
  private readonly renderer: WebGPURenderer;

  constructor(renderer: WebGPURenderer, setup: PaletteSetup) {
    this.renderer = renderer;
    const keep = (texture: DataTexture) => {
      this.textures.push(texture);
      return texture;
    };
    const palette = keep(dataTexture(setup.palette, 256, 1, RGBAFormat));
    const shadow = new Uint8Array(512);
    shadow.set(setup.shadowSources.map((value) => (value ? 1 : 0)));
    shadow.set(setup.shadowTable, 256);
    const shadowTexture = keep(dataTexture(shadow, 256, 2, RedFormat));
    const remaps = new Uint8Array(256 * setup.remaps.length);
    setup.remaps.forEach((table, row) => remaps.set(table, row * 256));
    const remapTexture = keep(dataTexture(remaps, 256, setup.remaps.length, RedFormat));
    const tileAtlas = keep(indexTexture(setup.tiles.atlas));
    const spriteAtlas = keep(indexTexture(setup.spriteAtlas));

    this.tilePass = new QuadMesh(this.tileMaterial(setup.tiles, tileAtlas));

    // Two vec4 per sprite: x, y, width, height; then atlas x, atlas y, remap row, shadow flag.
    this.capacity = setup.spriteCapacity;
    this.instances = new StorageBufferAttribute(new Float32Array(Math.max(1, this.capacity) * 8), 4);
    const corners = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    this.spriteGeometry.setAttribute('position', new BufferAttribute(corners, 3));
    this.spriteGeometry.setIndex([0, 2, 1, 2, 3, 1]);
    this.spriteGeometry.instanceCount = 0;
    this.spriteMesh = new Mesh(this.spriteGeometry, this.spriteMaterial(spriteAtlas, shadowTexture, remapTexture));
    this.spriteMesh.frustumCulled = false;

    this.compositePass = new QuadMesh(this.compositeMaterial(shadowTexture));
    this.presentPass = new QuadMesh(this.presentMaterial(palette));
  }

  private tileMaterial(tiles: TileMap, atlas: DataTexture) {
    const cells = storage(new StorageBufferAttribute(tiles.cells, 1), 'uint', tiles.cells.length).toReadOnly();
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
    const instances = storage(this.instances, 'vec4', Math.max(1, this.capacity) * 2).toReadOnly();
    const rect = instances.element(instanceIndex.mul(2));
    const info = instances.element(instanceIndex.mul(2).add(1));
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
      const isShadow = flatInfo.w.greaterThan(0.5).and(textureLoad(shadow, ivec2(source, 0)).r.greaterThan(0));
      const remapped = textureLoad(remaps, ivec2(source, int(flatInfo.z))).r;
      return select(isShadow, vec4(0, 1 / 255, 0, 0), vec4(remapped, 0, 0, 1));
    })();
    return material;
  }

  private compositeMaterial(shadow: DataTexture) {
    const material = new MeshBasicNodeMaterial();
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
      return vec4(float(index).div(255), 0, 0, 1);
    })();
    return material;
  }

  private presentMaterial(palette: DataTexture) {
    const material = new MeshBasicNodeMaterial();
    material.fragmentNode = Fn(() => {
      const pixel = floor(screenCoordinate.xy.div(this.scale));
      const index = loadIndex(this.indexTarget.texture, int(pixel.x), int(pixel.y));
      return vec4(textureLoad(palette, ivec2(index, 0)).rgb, 1);
    })();
    return material;
  }

  /**
   * Writes sprites into the draw list from position first on, and draws the list up to the last of
   * them. Only the written part is uploaded, so sprites that stay put are written once and later calls
   * rewrite the few after them.
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
      data.set([sprite.x, sprite.y, region.width, region.height, region.x, region.y, sprite.remap, shadow],
        (first + index) * 8);
    });
    if (sprites.length > 0) {
      this.instances.addUpdateRange(first * 8, sprites.length * 8);
      this.instances.needsUpdate = true;
    }
    this.spriteGeometry.instanceCount = count;
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
    for (const texture of this.textures) texture.dispose();
    for (const target of [this.tileTarget, this.spriteTarget, this.indexTarget]) target.dispose();
    for (const mesh of [this.tilePass, this.compositePass, this.presentPass, this.spriteMesh]) {
      (mesh.material as MeshBasicNodeMaterial).dispose();
    }
    this.spriteGeometry.dispose();
  }
}
