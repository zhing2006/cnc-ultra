// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, instanceIndex, int, storage, vec4 } from 'three/tsl';
import { GpuOrder } from '../../engine/simulation/order.ts';
import { GpuSimulation } from '../../engine/simulation/gpu.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { UNIT_WORDS, X, Y } from '../../engine/simulation/state.ts';
import type { PalettePipeline, Sprite } from '../../engine/indexed/pipeline.ts';
import type { GameScene } from '../scene.ts';
import { leptonToPixel } from '../coord.ts';

/** Ported from LAYER.CPP, LayerClass::Sort, and OBJECT.H, comparison operators. */
export function bubbleGround(order: Uint32Array, keys: Int32Array) {
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i] * 2, b = order[i + 1] * 2;
    if (keys[b + 1] < keys[a + 1] || (keys[b + 1] === keys[a + 1] && keys[b] < keys[a])) {
      [order[i], order[i + 1]] = [order[i + 1], order[i]];
    }
  }
}

/** Ported from LAYER.CPP, LayerClass::Sorted_Add, including insertion into a partly sorted layer. */
export function insertGround(order: number[], keys: Int32Array, id: number) {
  const at = order.findIndex(other => keys[other * 2 + 1] > keys[id * 2 + 1]
    || (keys[other * 2 + 1] === keys[id * 2 + 1] && keys[other * 2] > keys[id * 2]));
  order.splice(at < 0 ? order.length : at, 0, id);
}

/** Associates each original drawable object with its simulation unit, if any. */
export function groundLayout(scene: GameScene, initial: Int32Array) {
  const units = new Map(scene.scenario.units.map((u,i) => [`unit:${u.cell}:${u.type}`, i]));
  const slots = scene.objects.reduce((max, object) => Math.max(max, object.count), 1);
  const first = scene.objects[0]?.first ?? scene.sprites.length;
  const keys = new Int32Array(scene.objects.flatMap(o => [o.sortX, o.sortY]));
  const bindings = new Int32Array(scene.objects.flatMap(o => {
    const unit = units.get(o.key) ?? -1;
    return [unit, unit < 0 ? 0 : initial[unit * UNIT_WORDS + X], unit < 0 ? 0 : initial[unit * UNIT_WORDS + Y], o.sortX, o.sortY];
  }));
  const packed = new Float32Array((first + scene.objects.length * slots) * 12);
  const write = (sprite: Sprite, i: number) => packed.set([sprite.x, sprite.y, sprite.region.width, sprite.region.height,
    sprite.region.x, sprite.region.y, sprite.remap, sprite.shadow ? 1 : 0,
    sprite.filter === undefined ? 0 : sprite.filter + 2, sprite.displace ? 1 : 0, 0, 0], i * 12);
  scene.sprites.slice(0, first).forEach(write);
  scene.objects.forEach((o,id) => scene.sprites.slice(o.first, o.first + o.count).forEach((s,j) => write(s, first + id * slots + j)));
  return { slots, first, keys, bindings, packed, count: packed.length / 12 };
}

export function updateGroundKeys(layout: ReturnType<typeof groundLayout>, units: Int32Array, keys: Int32Array) {
  for (let id = 0; id < keys.length / 2; id++) {
    const at = id * 5, unit = layout.bindings[at];
    keys[id * 2] = layout.bindings[at + 3] + (unit < 0 ? 0 : units[unit * UNIT_WORDS] - layout.bindings[at + 1]);
    keys[id * 2 + 1] = layout.bindings[at + 4] + (unit < 0 ? 0 : units[unit * UNIT_WORDS + 1] - layout.bindings[at + 2]);
  }
}

/** CPU drawing reference; production animation uses GpuGround. */
export function groundSprites(scene: GameScene, layout: ReturnType<typeof groundLayout>, units: Int32Array, order: Uint32Array): Sprite[] {
  const sprites = scene.sprites.slice(0, layout.first);
  for (const id of order) {
    const o = scene.objects[id], at = id * 5, unit = layout.bindings[at];
    const dx = unit < 0 ? 0 : leptonToPixel(units[unit * UNIT_WORDS]) - leptonToPixel(layout.bindings[at + 1]);
    const dy = unit < 0 ? 0 : leptonToPixel(units[unit * UNIT_WORDS + 1]) - leptonToPixel(layout.bindings[at + 2]);
    sprites.push(...scene.sprites.slice(o.first, o.first + o.count).map(s => ({...s, x: s.x + dx, y: s.y + dy})));
  }
  return sprites;
}

export class GpuGround {
  readonly order: GpuOrder;
  readonly keys: StorageBufferAttribute;
  private readonly attributes: StorageBufferAttribute[];
  private readonly keyPass;
  private readonly spritePass;
  constructor(private readonly renderer: WebGPURenderer, private readonly simulation: GpuSimulation,
    private readonly pipeline: PalettePipeline, readonly layout: ReturnType<typeof groundLayout>) {
    const count = layout.keys.length / 2;
    this.keys = new StorageBufferAttribute(layout.keys.slice(), 1);
    const bindings = new StorageBufferAttribute(layout.bindings, 1), source = new StorageBufferAttribute(layout.packed, 4);
    this.attributes = [this.keys, bindings, source];
    this.order = new GpuOrder(renderer, this.keys, Uint32Array.from({length: count}, (_,i) => i));
    const key = storage(this.keys, 'int', count * 2);
    const meta = storage(bindings, 'int', layout.bindings.length).toReadOnly();
    const units = storage(simulation.units, 'int', simulation.units.count).toReadOnly();
    this.keyPass = Fn(() => {
      const id = instanceIndex, at = id.mul(5), unit = meta.element(at);
      const x = meta.element(at.add(3)).toVar(), y = meta.element(at.add(4)).toVar();
      If(unit.greaterThanEqual(0), () => {
        x.addAssign(units.element(unit.mul(UNIT_WORDS)).sub(meta.element(at.add(1))));
        y.addAssign(units.element(unit.mul(UNIT_WORDS).add(1)).sub(meta.element(at.add(2))));
      });
      key.element(id.mul(2)).assign(x); key.element(id.mul(2).add(1)).assign(y);
    })().compute(count);
    const order = storage(this.order.order, 'uint', count).toReadOnly();
    const original = storage(source, 'vec4', layout.count * 3).toReadOnly();
    const destination = storage(pipeline.spriteBuffer, 'vec4', pipeline.spriteBuffer.count);
    // Ported from FUNCTION.H, Lepton_To_Pixel; integer rounding precedes conversion for drawing.
    const pixel = (value: ReturnType<typeof int>) => value.mul(24).add(128).div(256);
    this.spritePass = Fn(() => {
      const index = int(instanceIndex), sourceIndex = index.toVar(), dx = int(0).toVar(), dy = int(0).toVar();
      If(index.greaterThanEqual(layout.first), () => {
        const relative = index.sub(layout.first), id = order.element(relative.div(layout.slots)), at = id.mul(5);
        sourceIndex.assign(int(id).mul(layout.slots).add(relative.mod(layout.slots)).add(layout.first));
        const unit = meta.element(at);
        If(unit.greaterThanEqual(0), () => {
          dx.assign(pixel(int(units.element(unit.mul(UNIT_WORDS)))).sub(pixel(int(meta.element(at.add(1))))));
          dy.assign(pixel(int(units.element(unit.mul(UNIT_WORDS).add(1)))).sub(pixel(int(meta.element(at.add(2))))));
        });
      });
      const rect = original.element(sourceIndex.mul(3));
      destination.element(index.mul(3)).assign(vec4(rect.x.add(dx), rect.y.add(dy), rect.zw));
      destination.element(index.mul(3).add(1)).assign(original.element(sourceIndex.mul(3).add(1)));
      destination.element(index.mul(3).add(2)).assign(original.element(sourceIndex.mul(3).add(2)));
    })().compute(layout.count);
    this.sort();
    this.updateSprites();
  }
  /** One bubble pass using the positions before this tick's simulation update. */
  sort() { this.renderer.compute(this.keyPass); this.order.step(); }
  /** Write the new positions with the order established before the simulation update. */
  updateSprites() {
    this.renderer.compute(this.spritePass); this.pipeline.updateGpuSprites(this.layout.count); this.pipeline.setFrame(this.simulation.frame);
  }
  dispose() { this.keyPass.dispose(); this.spritePass.dispose(); this.order.dispose(); releaseStorage(this.renderer, this.attributes); }
}
