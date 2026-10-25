import { WebGPURenderer } from 'three/webgpu';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import type { CombatSetup, AttackCommand } from '../src/game/simulation/combat-state.ts';
import { WORDS, UHEALTH } from '../src/game/simulation/units-state.ts';
import { loadData } from '../src/game/data-files.ts';
import { combatScene } from '../src/demo/combat-scene.ts';
import { PalettePipeline, type Sprite } from '../src/engine/indexed/pipeline.ts';
import { animations, ANIMATION_IDS } from '../src/game/data/combat.ts';
import { compareCombatWorld } from './combat-world.ts';
import { verifyCombatSprites } from './combat-rendering.ts';
import { GpuSight } from '../src/game/simulation/sight.ts';
import { GpuSelection } from '../src/game/simulation/selection.ts';
import { verifyCombatComposition } from './combat-composition.ts';
import { verifyCombatAudio } from './combat-audio.ts';
import { combatHotspots } from './combat-performance.ts';
export async function compareCombat(beforePerformance: () => Promise<void> = () => Promise.resolve(), acceptance=false) {
  const renderer = new WebGPURenderer();
  await renderer.init();
  try {
    await verifyCombatComposition(renderer);
    const regressions = await compareCombatWorld(renderer);
    const demo = combatScene(await loadData(false, true));
    const marchCpu = new CpuCombat(demo.setup), marchGpu = new GpuCombat(renderer, demo.setup);
    await verifyCombatSprites(renderer, demo, marchGpu);
    await verifyCombatAudio(renderer,marchGpu,await loadData(false,true));
    const sight = new GpuSight(renderer, demo.setup.grid.width, demo.setup.grid.height, marchGpu.units);
    const selection = new GpuSelection(renderer, marchGpu.movement, sight, true);
    // Use the actual selection-command path with a visible enemy, not only the
    // direct CPU/GPU command injection used by the rule fixtures.
    (sight.shadow.array as Int32Array).fill(0);
    sight.shadow.needsUpdate = true;
    selection.apply({action:'box',x:0,y:0,x2:16384,y2:16384});
    await selection.read();
    selection.apply({action:'point',x:128,y:128,modifier:2});
    if((await selection.read())[2]!==3) throw new Error('Force attack did not request an attack response');
    selection.apply({action:'point',x:marchCpu.units[6 * WORDS],y:marchCpu.units[6 * WORDS + 1]});
    await selection.read();
    const imageScene = demo.scene, base = 17, size = 96;
    const imagePipeline = new PalettePipeline(renderer, { ...imageScene.setup, spriteCapacity: 3,
      tiles: { tileSize: 24, atlas: { width: 24, height: 24, pixels: new Uint8Array(24 * 24).fill(base) }, cells: new Uint32Array(16), columns: 4, rows: 4 } });
    try {
      const smoke = imageScene.animation!.frames.get(animations[ANIMATION_IDS.ANIM_SMOKE_M].name)![2];
      const flame = imageScene.animation!.frames.get(animations[ANIMATION_IDS.ANIM_NAPALM1].name)![3];
      const sprites: Sprite[] = [{ x: 30, y: 30, region: imageScene.animation!.frames.get('MTNK')![0], shadow: true, remap: imageScene.plainRemap },
        { x: 25, y: 25, region: flame, shadow: false, blend: true, remap: imageScene.plainRemap },
        { x: 28, y: 28, region: smoke, shadow: false, blend: true, remap: imageScene.plainRemap }];
      const expected = new Uint8Array(size * size).fill(base), blend = imageScene.setup.indexedBlend!, atlas = imageScene.setup.spriteAtlas;
      // KEYFBUFF.ASM SHAPE_GHOST: select a row with the source, then map the destination.
      for (const sprite of sprites)
        for (let y = 0; y < sprite.region.height; y++)
          for (let x = 0; x < sprite.region.width; x++) {
            const xx = sprite.x + x, yy = sprite.y + y;
            if (xx < 0 || yy < 0 || xx >= size || yy >= size)
              continue;
            const ink = atlas.pixels[(sprite.region.y + y) * atlas.width + sprite.region.x + x], at = yy * size + xx;
            if (!ink)
              continue;
            if (sprite.blend)
              expected[at] = blend[ink] === 255 ? ink : blend[(blend[ink] + 1) * 256 + expected[at]];
            else
              expected[at] = sprite.shadow && imageScene.setup.shadowSources[ink] ? imageScene.setup.shadowTable[expected[at]] : ink;
          }
      imagePipeline.setSprites(sprites);
      const actual = await imagePipeline.readIndices({ x: 0, y: 0, width: size, height: size });
      for (let i = 0; i < expected.length; i++)
        if (expected[i] !== actual[i])
          throw new Error(`Original translucent composition differs at ${i}: ${expected[i]}/${actual[i]}`);
    }
    finally {
      imagePipeline.dispose();
    }
    try {
      for (let tick = 1; tick <= 1200; tick++) {
        const commands: AttackCommand[] = tick === 1 ? [{ frame: 1, kind: 'attack', target: 6, ids: demo.setup.units.flatMap((u, id) => u.owner === 0 && u.health !== 0 ? [id] : []) }] : [];
        marchCpu.step(commands);
        if (tick % 30 === 0) {
          marchGpu.stepMany(tick - marchGpu.frame);
          const expected = marchCpu.buffers(), actual = await marchGpu.snapshot();
          for (let i = 0; i < expected.length; i++)
            for (let j = 0; j < expected[i].length; j++)
              if (expected[i][j] !== actual[i][j])
                throw new Error(`Battle march tick ${tick}: buffer ${i}, word ${j}, CPU ${expected[i][j]}, GPU ${actual[i][j]}`);
        }
      }
      for (const infantry of [false, true]) {
        const enemy = demo.setup.units.some((unit, id) => unit.owner === 1 && unit.health !== 0 &&
          (unit.type >= movementType('E1')) === infantry && marchCpu.units[id * WORDS + UHEALTH] === 0);
        if (!enemy) throw new Error(`Selection attack did not destroy enemy ${infantry ? 'infantry' : 'vehicles'}`);
      }
    }
    finally {
      marchGpu.dispose();
      selection.dispose();
      sight.dispose();
    }
    const backend = renderer.backend as unknown as {
      trackTimestamp: boolean;
      device: GPUDevice;
    };
    const gpuMs: number[] = [];
    if(acceptance)await beforePerformance();
    let hotspots:Awaited<ReturnType<typeof combatHotspots>>|undefined;
    if (acceptance && backend.device.features.has('timestamp-query')) {
      const large: CombatSetup = { grid: gridEdges(256, 256, new Uint8Array(256 * 256).fill(1), true), land: new Uint8Array(256 * 256), seed: 0x1995,
        units: Array.from({ length: 20000 }, (_, id) => ({ cell: (2 + Math.floor(id / 200)) * 256 + 2 + id % 200,
          type: movementType(id % 3 ? 'MTNK' : 'E1'), owner: id % 2, facing: id % 2 ? 192 : 64 })) };
      const many = new GpuCombat(renderer, large);
      try {
        many.step();
        many.step();
        await renderer.getArrayBufferAsync(many.movement.control);
        backend.trackTimestamp = true;
        for (let i = 0; i < 3; i++) {
          many.step();
          gpuMs.push((await renderer.resolveTimestampsAsync('compute'))!);
        }
        backend.trackTimestamp=false;
        hotspots=await combatHotspots(renderer,many);
      }
      finally {
        backend.trackTimestamp = false;
        many.dispose();
      }
    }
    return { ...regressions, mixedTicks:780, marchTicks:1200, gpuUnits:acceptance?20000:0, gpuMs, hotspots };
  }
  finally {
    renderer.dispose();
  }
}
