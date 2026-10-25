import { StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, int, instanceIndex, storage, vec4 } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import type { PalettePipeline } from '../../engine/indexed/pipeline.ts';
import type { GameScene } from '../scene.ts';
import type { EconomyRuntime } from './economy-runtime.ts';
import { SUPER_SHAPES, SUPER_SPRITES, SUPER_VISUAL_WORDS } from './super-weapons.ts';

/** Pure projection of the small CPU-owned superweapon timelines. */
export class SuperView {
  private readonly records: StorageBufferAttribute;
  private readonly shapes: StorageBufferAttribute;
  private readonly pass;
  constructor(private readonly economy: EconomyRuntime, pipeline: PalettePipeline, scene: GameScene, start: number) {
    this.records = new StorageBufferAttribute(economy.supers.visuals.slice(), 1);
    const rects: number[] = [], starts: number[] = [];
    for (const name of SUPER_SHAPES) {
      starts.push(rects.length / 4);
      for (const region of scene.animation!.frames.get(name) ?? []) rects.push(region.x, region.y, region.width, region.height);
    }
    this.shapes = new StorageBufferAttribute(Int32Array.from([...starts, ...rects]), 1);
    const records = storage(this.records, 'int', this.records.count).toReadOnly(), shapes = storage(this.shapes, 'int', this.shapes.count).toReadOnly();
    const sprites = storage(pipeline.spriteBuffer, 'vec4', pipeline.spriteBuffer.count);
    this.pass = Fn(() => {
      const id = int(instanceIndex), at = id.mul(SUPER_VISUAL_WORDS), dst = id.add(start).mul(3), kind = records.element(at);
      sprites.element(dst).assign(vec4(0)); sprites.element(dst.add(1)).assign(vec4(0)); sprites.element(dst.add(2)).assign(vec4(0));
      If(kind.greaterThanEqual(0), () => {
        const rect = shapes.element(kind).add(records.element(at.add(1))).mul(4).add(SUPER_SHAPES.length);
        const width = shapes.element(rect.add(2)), height = shapes.element(rect.add(3));
        const x = records.element(at.add(2)).mul(24).add(128).div(256), y = records.element(at.add(3)).mul(24).add(128).div(256);
        sprites.element(dst).assign(vec4(x.sub(width.div(2)), y.sub(height.div(2)), width, height));
        sprites.element(dst.add(1)).assign(vec4(shapes.element(rect), shapes.element(rect.add(1)), scene.plainRemap, 0));
      });
    })().compute(SUPER_SPRITES);
  }
  update() {
    const values = this.records.array as Int32Array, current = this.economy.supers.visuals;
    if (current.some((value, index) => values[index] !== value)) { values.set(current); this.records.needsUpdate = true; }
    this.economy.battle.renderer.compute(this.pass);
  }
  dispose() { this.pass.dispose(); releaseStorage(this.economy.battle.renderer, [this.records, this.shapes]); }
}
