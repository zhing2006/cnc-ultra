import { WebGPURenderer } from 'three/webgpu';
import { ivec2 } from 'three/tsl';
import { PalettePipeline } from '../src/engine/indexed/pipeline.ts';
/** Independent synthetic palette arithmetic for mixed filter/displacement composition. */
export async function verifyCombatComposition(shared?: WebGPURenderer) {
  const renderer = shared ?? new WebGPURenderer();
  if (!shared)
    await renderer.init();
  const identity = Uint8Array.from({ length: 256 }, (_, i) => i);
  const white = identity.map(i => (i + 1) % 256), blend = new Uint8Array(512);
  blend.fill(255, 0, 256);
  blend[10] = 0;
  blend.set(identity.map(i => (i + 10) % 256), 256);
  const pipeline = new PalettePipeline(renderer, {
    palette: new Uint8Array(1024), shadowSources: new Uint8Array(256),
    shadowTable: identity, remaps: [identity], spriteAtlas: { width: 1, height: 1, pixels: new Uint8Array([10]) },
    tiles: { tileSize: 1, atlas: { width: 4, height: 1, pixels: new Uint8Array([17, 18, 19, 20]) }, cells: new Uint32Array([0, 1, 2, 3]), columns: 4, rows: 1 },
    spriteCapacity: 40, singleUseFilter: white, indexedBlend: blend, displacement: { offset: () => ivec2(-1, 0), dispose() { } }
  });
  try {
    const sprite = { y: 0, region: { x: 0, y: 0, width: 1, height: 1 }, shadow: false, remap: 0 };
    pipeline.setSprites([{ ...sprite, x: 0, filter: 0 }, { ...sprite, x: 0, filter: 0 },
    { ...sprite, x: 2, blend: true }, { ...sprite, x: 3, displace: true }]);
    const actual = await pipeline.readIndices({ x: 0, y: 0, width: 4, height: 1 });
    const expected = [18, 18, 29, 29];
    if (!actual.every((n, i) => n === expected[i]))
      throw new Error(`Mixed indexed effects: ${actual}; expected ${expected}`);
    // More contributors than the shader's scratch chunk must remain exact.
    pipeline.setSprites(Array.from({ length: 40 }, () => ({ ...sprite, x: 2, blend: true })));
    const deep = await pipeline.readIndices({ x: 0, y: 0, width: 4, height: 1 });
    if (deep[2] !== 163)
      throw new Error(`Deep indexed effects: ${deep[2]}; expected (19+400)%256`);
  }
  finally {
    pipeline.dispose();
    if (!shared)
      renderer.dispose();
  }
}
