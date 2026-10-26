import { ivec2 } from 'three/tsl';
import { createRenderer } from '../src/engine/renderer.ts';
import { NO_TILE, PalettePipeline, type PaletteSetup, type Sprite } from '../src/engine/indexed/pipeline.ts';

/** Compare integer zoom-out with native pixels, including both destination-dependent resolvers. */
export async function checkMapSampling() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!wrapper) { canvas.remove(); throw new Error('No WebGPU'); }
  const identity = Uint8Array.from({ length: 256 }, (_, i) => i);
  const palette = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) palette.set([i, i, i, 255], i * 4);
  const tileSize = 24, columns = 512, rows = 256;
  const tileInk = (tile: number, x: number, y: number) => 16 + (tile * 29 + x * 3 + y * 7) % 112;
  const tilePixels = new Uint8Array(48 * 24);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 48; x++) {
    tilePixels[y * 48 + x] = tileInk(Math.floor(x / 24), x % 24, y);
  }
  const cells = Uint32Array.from({ length: columns * rows }, (_, i) => (i % columns + Math.floor(i / columns)) % 2);
  cells[cells.length - 1] = NO_TILE;
  const spritePixels = new Uint8Array(72 * 24);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    spritePixels[y * 72 + x] = (x + y) % 5 === 0 ? 0 : 128 + (x * 7 + y * 3) % 127;
    spritePixels[y * 72 + 24 + x] = (x + y) % 7 === 0 ? 0 : 2;
    spritePixels[y * 72 + 48 + x] = 1;
  }
  const shadowSources = new Uint8Array(256); shadowSources[2] = 1;
  const setup: PaletteSetup = {
    palette, shadowSources, shadowTable: identity.map(i => i & 127),
    remaps: [identity, identity.map(i => i === 0 ? 0 : i ^ 64)],
    tiles: { tileSize, columns, rows, cells, atlas: { width: 48, height: 24, pixels: tilePixels } },
    spriteAtlas: { width: 72, height: 24, pixels: spritePixels }, spriteCapacity: 16,
    filters: [identity.map(i => i ^ 32)],
    // Deliberately off the step-3/4 sampling lattice: terrain must use the exact displaced pixel.
    displacement: { offset: () => ivec2(5, 0), dispose() {} },
  };
  // Keep R8 readbacks four-byte aligned at all three scales (the Three.js readback requirement).
  const view = { x: 9001, y: 53, width: 288, height: 144 };
  const sprite = (x: number, y: number, atlasX: number, flags: Partial<Sprite> = {}): Sprite => ({
    x: view.x + x, y: view.y + y, region: { x: atlasX, y: 0, width: 24, height: 24 },
    remap: 0, shadow: false, ...flags,
  });
  const sprites: Sprite[] = [
    sprite(7, 9, 0, { remap: 1 }), sprite(13, 17, 24, { shadow: true }),
    sprite(51, 9, 48, { filter: 0 }),
    sprite(94, 15, 0), sprite(86, 9, 48, { displace: true }),
    sprite(125, 17, 0), sprite(129, 21, 48, { filter: 0 }),
    sprite(133, 25, 24, { shadow: true }),
    // Destination reads must clip to the world span, not the smaller target size.
    sprite(264, 9, 48, { displace: true }),
    sprite(292, 9, 0),
  ];
  let comparisons = 0;
  try {
    for (const blended of [false, true]) {
      const indexedBlend = new Uint8Array(512).fill(255);
      indexedBlend[1] = 0; indexedBlend.set(identity.map(i => i ^ 16), 256);
      const pipeline = new PalettePipeline(wrapper.three, { ...setup, indexedBlend: blended ? indexedBlend : undefined });
      try {
        pipeline.setSprites(blended ? [...sprites, sprite(137, 29, 48, { blend: true })] : sprites);
        // This native image stays within texture limits and has a nonzero, unaligned world origin.
        const native = await pipeline.readIndices(view);
        for (const step of [4, 3, 1]) {
          const width = view.width / step | 0, height = view.height / step | 0;
          // Use an identical clipped world span for both images when the dimensions do not divide evenly.
          const reference = width * step === view.width && height * step === view.height ? native
            : await pipeline.readIndices({ ...view, width: width * step, height: height * step });
          const sampled = await pipeline.readIndices({ ...view, width, height }, step);
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const wx = Math.floor((x + 0.5) * step), wy = Math.floor((y + 0.5) * step);
            const expected = reference[wy * width * step + wx], actual = sampled[y * width + x];
            if (actual !== expected) throw new Error(`Map sampling ${blended ? 'blended' : 'filtered'} step ${step} at ${x},${y}: ${actual} != ${expected}`);
            comparisons++;
          }
        }
        pipeline.setSprites([]);
        // The entire 12288 × 6144 world fits in 512 × 256 index targets, below baseline limits.
        const overview = await pipeline.readIndices({ x: 0, y: 0, width: columns, height: rows }, tileSize);
        for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
          const tile = cells[y * columns + x];
          const expected = tile === NO_TILE ? 0 : tileInk(tile, 12, 12);
          if (overview[y * columns + x] !== expected) throw new Error(`Map overview at ${x},${y}: ${overview[y * columns + x]} != ${expected}`);
          comparisons++;
        }
      } finally { pipeline.dispose(); }
    }
    return { comparisons, worldWidth: columns * tileSize, worldHeight: rows * tileSize };
  } finally { wrapper.dispose(); canvas.remove(); }
}
