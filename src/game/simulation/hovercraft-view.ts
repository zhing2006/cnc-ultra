// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type ComputeNode } from 'three/webgpu';
import { Fn, If, int, uint, instanceIndex, storage, vec4, select, atomicStore, atomicMax } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import type { PalettePipeline } from '../../engine/indexed/pipeline.ts';
import { movementType } from '../data/movement.ts';
import type { GpuCombat } from './combat-gpu.ts';
import type { GpuGround } from './ground.ts';
import * as U from './units-state.ts';

/** Ported from UNIT.CPP, UnitClass::Draw_It: attached cargo is part of the hull's draw group. */
export class HovercraftView {
  private readonly attributes: StorageBufferAttribute[];
  private readonly passes: ComputeNode[];
  constructor(private readonly battle: GpuCombat, ground: GpuGround, pipeline: PalettePipeline) {
    const { layout } = ground, count = battle.setup.units.length;
    const images = new StorageBufferAttribute(new Float32Array(count * 4 * 12), 4);
    const passengers = new StorageBufferAttribute(new Uint32Array(count * 5), 1);
    this.attributes = [images, passengers];
    const u = storage(battle.units, 'int', battle.units.count).toReadOnly();
    const bindings = storage(ground.bindings, 'int', ground.bindings.count).toReadOnly();
    const order = storage(ground.order.order, 'uint', ground.order.order.count).toReadOnly();
    const sprites = storage(pipeline.spriteBuffer, 'vec4', pipeline.spriteBuffer.count);
    const source = storage(images, 'vec4', images.count);
    const cargo = storage(passengers, 'uint', passengers.count).toAtomic();
    const deck = storage(passengers, 'uint', passengers.count).toReadOnly();
    const snapshot = Fn(() => {
      const object = int(instanceIndex), id = bindings.element(int(order.element(object)).mul(5));
      If(id.greaterThanEqual(0), () => {
        for (let slot = 0; slot < 5; slot++) atomicStore(cargo.element(id.mul(5).add(slot)), uint(0));
        If(u.element(id.mul(U.WORDS).add(U.UATTACHED)).notEqual(0), () => {
          // Keep the already projected body, turret, remap and cloak layers. Hide
          // their independent ground records only after preserving all four parts.
          const base = object.mul(layout.slots).add(layout.first).mul(3);
          for (let part = 0; part < 4; part++) for (let word = 0; word < 3; word++)
            source.element(id.mul(12).add(part * 3 + word)).assign(sprites.element(base.add(part * 3 + word)));
          for (let part = 0; part < layout.slots; part++) sprites.element(base.add(part * 3)).assign(vec4(0));
        });
      });
    })().compute(ground.order.order.count);
    const collect = Fn(() => {
      const id = int(instanceIndex), at = id.mul(U.WORDS), parent = u.element(at.add(U.UATTACHED)).sub(1);
      If(parent.greaterThanEqual(0).and(u.element(at.add(U.UHEALTH)).greaterThan(0)), () => {
        If(u.element(parent.mul(U.WORDS).add(U.UTYPE)).equal(movementType('LST'))
          .and(u.element(parent.mul(U.WORDS).add(U.UHEALTH)).greaterThan(0)), () => {
          // REINF.CPP Do_Reinforcements links cargo in reverse creation order.
          // Five atomic insertion slots retain that order without scanning all actors per ship.
          const candidate = uint(id.add(1)).toVar();
          for (let slot = 0; slot < 5; slot++) {
            const prior = atomicMax(cargo.element(parent.mul(5).add(slot)), candidate).toVar();
            candidate.assign(select(prior.lessThan(candidate), prior, candidate));
          }
        });
      });
    })().compute(count);
    const draw = Fn(() => {
      const object = int(instanceIndex), id = bindings.element(int(order.element(object)).mul(5));
      If(id.greaterThanEqual(0), () => {
        const at = id.mul(U.WORDS);
        If(u.element(at.add(U.UTYPE)).equal(movementType('LST')).and(u.element(at.add(U.UHEALTH)).greaterThan(0)), () => {
          const next = int(1).toVar(), base = object.mul(layout.slots).add(layout.first).mul(3);
          Loop(5, ({ i: slot }) => {
            const passenger = int(deck.element(id.mul(5).add(slot))).sub(1);
            If(passenger.greaterThanEqual(0), () => {
              // CONST.CPP StoppingCoordAbs, relative to the center of the moving hull.
              const dx = select(slot.equal(0), int(0), slot.sub(1).mod(2).mul(128).sub(64));
              const dy = select(slot.equal(0), int(0), slot.sub(1).div(2).mul(128).sub(64));
              const pixel = (value: import('three/webgpu').Node<'int'>) => value.mul(24).add(128).div(256);
              const x = pixel(u.element(at).add(dx)).sub(pixel(u.element(passenger.mul(U.WORDS))));
              const y = pixel(u.element(at.add(1)).add(dy)).sub(pixel(u.element(passenger.mul(U.WORDS).add(1))));
              for (let part = 0; part < 4; part++) {
                const from = passenger.mul(12).add(part * 3), rect = source.element(from);
                If(rect.z.greaterThan(0).and(rect.w.greaterThan(0)).and(next.lessThan(layout.slots)), () => {
                  const to = base.add(next.mul(3));
                  sprites.element(to).assign(vec4(rect.x.add(x), rect.y.add(y), rect.zw));
                  sprites.element(to.add(1)).assign(source.element(from.add(1)));
                  sprites.element(to.add(2)).assign(source.element(from.add(2)));
                  next.addAssign(1);
                });
              }
            });
          });
        });
      });
    })().compute(ground.order.order.count);
    this.passes = [snapshot, collect, draw];
  }
  update() { this.battle.renderer.compute(this.passes); }
  dispose() {
    for (const pass of this.passes) pass.dispose();
    releaseStorage(this.battle.renderer, this.attributes);
  }
}
