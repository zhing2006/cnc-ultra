// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type ComputeNode, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, int, uint, storage, instanceIndex, vec4, ivec4, atomicMin, atomicAdd, atomicStore, atomicLoad, select, abs } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import type { PalettePipeline } from '../../engine/indexed/pipeline.ts';
import type { GameScene } from '../scene.ts';
import { BODY_SHAPE, HUMAN_SHAPE, facingTo32 } from '../coord.ts';
import { combatTypes, animations, bullets, weapons, ANIMATION_IDS } from '../data/combat.ts';
import { MOVEMENT } from '../data/movement.ts';
import type { GpuGround } from './ground.ts';
import type { GpuCombat } from './combat-gpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
import { deathAnimation } from './combat-effects.ts';
function trailLayout(setup: C.CombatSetup, scene: GameScene) {
  const frames = scene.animation!.frames.get('SMOKEY')?.length ?? 0;
  const history = Math.ceil(frames / 2), starts = new Int32Array(setup.units.length * C.SHOTS_PER_UNIT).fill(-1);
  let count = 0;
  setup.units.forEach((unit, id) => {
    const type = combatTypes[unit.type];
    if (![type.primary, type.secondary].some(w => w >= 0 && bullets[weapons[w].bullet].smoke))
      return;
    for (let shot = 0; shot < C.SHOTS_PER_UNIT; shot++) {
      starts[id * C.SHOTS_PER_UNIT + shot] = count;
      count += history;
    }
  });
  return { history, starts, count };
}
export function combatExtraSprites(setup: C.CombatSetup, scene: GameScene) {
  return setup.units.length * (C.SHOTS_PER_UNIT + 3) + trailLayout(setup, scene).count;
}
export class CombatView {
  readonly count: number;
  private readonly attributes: StorageBufferAttribute[] = [];
  private readonly passes: ComputeNode[];
  constructor(private readonly renderer: WebGPURenderer, battle: GpuCombat, ground: GpuGround, private readonly pipeline: PalettePipeline, scene: GameScene, decalStart: number) {
    const units = battle.setup.units.length, shots = units * C.SHOTS_PER_UNIT, cells = battle.setup.grid.edges.length;
    const trails = trailLayout(battle.setup, scene), mainCount = ground.layout.count + shots + units;
    this.count = ground.layout.count + combatExtraSprites(battle.setup, scene);
    const keep = (a: Int32Array | Uint32Array, size = 1) => { const b = new StorageBufferAttribute(a, size); this.attributes.push(b); return b; };
    const u = storage(battle.units, 'int', battle.units.count).toReadOnly();
    const c = storage(battle.state, 'int', battle.state.count).toReadOnly();
    const p = storage(battle.projectiles, 'int', battle.projectiles.count).toReadOnly();
    const clock = storage(battle.movement.control, 'int', 2).toReadOnly();
    const order = storage(ground.order.order, 'uint', ground.order.order.count).toReadOnly();
    const dest = storage(pipeline.spriteBuffer, 'vec4', pipeline.spriteBuffer.count);
    const values: number[] = [], rects: number[] = [];
    const append = (a: readonly number[]) => { const offset = values.length; values.push(...a); return offset; };
    const frames = (name: string) => {
      const offset = rects.length / 4, regions = scene.animation!.frames.get(name) ?? [];
      for (const r of regions)
        rects.push(r.x, r.y, r.width, r.height);
      return [offset, regions.length];
    };
    const typeBase = append(combatTypes.flatMap((t, i) => [...frames(t.name), t.explosion, MOVEMENT[i].infantry,
    ...Array.from({ length: 34 * 3 }, (_, j) => t.actions[j] ?? 0)]));
    const typeWords = 106;
    const deathBase = append(combatTypes.flatMap((_, i) => [deathAnimation(i, 0), deathAnimation(i, 1)]));
    const healthBase = append(MOVEMENT.flatMap((t, i) => [t.strength, Number(!t.infantry && !['VICE', 'TRIC', 'TREX', 'RAPT', 'STEG'].includes(t.name))]));
    const trailBase = append(Array.from(trails.starts));
    const animBase = append(animations.flatMap(a => {
      const [start, count] = frames(a.name);
      return [start, count, a.start, a.count < 0 ? count - a.start : a.count, a.rate || 1, a.scorch, a.crater, a.biggest, a.translucent];
    }));
    const bulletBase = append(bullets.flatMap(b => [...frames(b.name), b.invisible, b.faceless, b.explosion]));
    const weaponBase = append(weapons.flatMap(w => [w.animation]));
    const facingBase = append(Array.from({ length: 256 }, (_, d) => [BODY_SHAPE[facingTo32(d)], HUMAN_SHAPE[facingTo32(d)]]).flat());
    const decalBase = append([...Array.from({ length: 6 }, (_, i) => frames(`CR${i + 1}`)[0]),
    ...Array.from({ length: 6 }, (_, i) => frames(`SC${i + 1}`)[0]), frames('SQUISH')[0]]);
    const bindingBase = append(Array.from(ground.layout.bindings));
    const rectBase = append(rects);
    const data = storage(keep(Int32Array.from(values)), 'int', values.length).toReadOnly();
    const binding = { element: (i: import('three/webgpu').Node<'int'>) => data.element(i.add(bindingBase)) };
    const rectangles = {
      element: (i: import('three/webgpu').Node<'int'>) => {
        const at = i.mul(4).add(rectBase);
        return ivec4(data.element(at), data.element(at.add(1)), data.element(at.add(2)), data.element(at.add(3)));
      }
    };
    const smudges = storage(keep(new Uint32Array(cells)), 'uint', cells).toAtomic();
    const pending = storage(keep(new Uint32Array(cells * 2)), 'uint', cells * 2).toAtomic();
    const clear = Fn(() => { atomicStore(pending.element(instanceIndex.mul(2)), uint(0xffffffff)); atomicStore(pending.element(instanceIndex.mul(2).add(1)), uint(0)); })().compute(cells);
    const mark = Fn(() => {
      const id = int(instanceIndex), animation = int(-1).toVar(), age = int(-1).toVar(), x = int(0).toVar(), y = int(0).toVar();
      If(id.lessThan(shots), () => {
        const b = id.mul(C.BWORDS);
        animation.assign(data.element(p.element(b.add(C.BTYPE)).mul(5).add(bulletBase + 4)));
        If(p.element(b.add(C.BEXPLODED)).greaterThanEqual(0), () => { age.assign(clock.element(0).sub(p.element(b.add(C.BEXPLODED)))); });
        x.assign(p.element(b));
        y.assign(p.element(b.add(1)));
      }).Else(() => {
        const unit = id.sub(shots), at = unit.mul(U.WORDS), state = unit.mul(C.CWORDS);
        animation.assign(data.element(u.element(at.add(U.UTYPE)).mul(2).add(deathBase).add(int(c.element(state.add(C.CAMMO)).greaterThan(0)))));
        If(c.element(state.add(C.CDEATH)).greaterThanEqual(0), () => { age.assign(clock.element(0).sub(c.element(state.add(C.CDEATH)))); });
        x.assign(u.element(at));
        y.assign(u.element(at.add(1)));
        If(c.element(state.add(C.CWARHEAD)).equal(C.CRUSHED).and(age.equal(0)), () => {
          // DRIVE.CPP, Overrun_Square leaves OVERLAY_SQUISH instead of a death animation.
          const cell = y.div(256).mul(battle.setup.grid.width).add(x.div(256));
          atomicMin(pending.element(cell.mul(2)), uint(id.mul(16).add(13)));
          animation.assign(-1);
        });
      });
      If(animation.greaterThanEqual(0), () => {
        const a = animation.mul(9).add(animBase), scorch = data.element(a.add(5)), crater = data.element(a.add(6));
        If(age.equal(data.element(a.add(7)).mul(data.element(a.add(4)))).and(scorch.notEqual(0).or(crater.notEqual(0))), () => {
          const cell = y.div(256).mul(battle.setup.grid.width).add(x.div(256));
          const dx = abs(x.mod(256).sub(128)), dy = abs(y.mod(256).sub(128));
          const near = select(dx.greaterThan(dy), dx.add(dy.div(2)), dy.add(dx.div(2))).lessThan(60);
          const spot = select(near, int(0), int(1).add(int(x.mod(256).greaterThan(128))).add(int(y.mod(256).greaterThan(128)).mul(2)));
          const variant = select(scorch.notEqual(0), id.mod(6).add(7), spot.add(1));
          atomicMin(pending.element(cell.mul(2)), uint(id.mul(16).add(variant)));
          If(crater.notEqual(0), () => { atomicAdd(pending.element(cell.mul(2).add(1)), uint(1)); });
        });
      });
    })().compute(shots + units);
    const settle = Fn(() => {
      const cell = int(instanceIndex), candidate = atomicLoad(pending.element(cell.mul(2)));
      If(candidate.notEqual(uint(0xffffffff)), () => {
        const old = int(atomicLoad(smudges.element(cell))).toVar();
        const fresh = int(old.equal(0)).toVar();
        If(fresh.notEqual(0).or(int(candidate).mod(16).equal(13)), () => { old.assign(int(candidate).mod(16)); });
        const variant = old.mod(16), hits = int(atomicLoad(pending.element(cell.mul(2).add(1))));
        If(variant.lessThanEqual(6), () => {
          const level = old.div(16).add(hits).sub(fresh).toVar();
          old.assign(select(level.greaterThan(4), int(4), level).mul(16).add(variant));
        });
        atomicStore(smudges.element(cell), uint(old));
      });
    })().compute(cells);
    const draw = Fn(() => {
      const index = int(instanceIndex), x = int(0).toVar(), y = int(0).toVar();
      const blend = int(0).toVar();
      const shape = int(-1).toVar(), remap = int(scene.plainRemap).toVar(), shadow = int(0).toVar();
      const animation = int(-1).toVar(), age = int(0).toVar(), replace = int(0).toVar();
      const pixel = (v: import('three/webgpu').Node<'int'>) => v.mul(24).add(128).div(256);
      If(index.greaterThanEqual(decalStart).and(index.lessThan(decalStart + cells)), () => {
        replace.assign(1);
        const cell = index.sub(decalStart), mark = int(atomicLoad(smudges.element(cell))), value = mark.mod(16);
        If(value.greaterThan(0), () => { shape.assign(data.element(value.sub(1).add(decalBase)).add(mark.div(16))); });
        x.assign(cell.mod(battle.setup.grid.width).mul(24).add(12));
        y.assign(cell.div(battle.setup.grid.width).mul(24).add(12));
      }).ElseIf(index.greaterThanEqual(ground.layout.first).and(index.lessThan(ground.layout.count)), () => {
        const relative = index.sub(ground.layout.first), entry = int(order.element(relative.div(ground.layout.slots)));
        const id = binding.element(entry.mul(5)).toVar();
        If(id.greaterThanEqual(0), () => {
          // Initialize shared addresses before branching. TSL can otherwise cache an
          // expression inside the infantry branch and reuse that unset value for turrets.
          const at = id.mul(U.WORDS).toVar(), state = id.mul(C.CWORDS).toVar();
          const type = u.element(at.add(U.UTYPE)).mul(typeWords).add(typeBase).toVar();
          const part = relative.mod(ground.layout.slots).toVar(), dead = u.element(at.add(U.UHEALTH)).lessThanEqual(0);
          If(dead, () => {
            replace.assign(1);
            x.assign(pixel(u.element(at)));
            y.assign(pixel(u.element(at.add(1))));
            If(c.element(state.add(C.CDEATH)).greaterThanEqual(0).and(part.equal(0))
              .and(c.element(state.add(C.CWARHEAD)).notEqual(C.CRUSHED)), () => {
                age.assign(clock.element(0).sub(c.element(state.add(C.CDEATH))));
                If(data.element(type.add(3)).notEqual(0), () => {
                  const wh = c.element(state.add(C.CWARHEAD)), action = select(wh.equal(1), int(23), select(wh.equal(2), int(25), select(wh.equal(3).or(wh.equal(4)).or(wh.equal(5)), int(26), int(22))));
                  const a = type.add(4).add(action.mul(3)), frame = age.div(2);
                  If(frame.lessThan(data.element(a.add(1))), () => { shape.assign(data.element(type).add(data.element(a)).add(frame)); });
                  remap.assign(int(dest.element(index.mul(3).add(1)).z));
                  x.subAssign(2);
                  y.addAssign(4);
                }).Else(() => {
                  animation.assign(data.element(u.element(at.add(U.UTYPE)).mul(2).add(deathBase).add(int(c.element(state.add(C.CAMMO)).greaterThan(0)))));
                });
              });
          }).ElseIf(data.element(type.add(3)).notEqual(0), () => {
            // INFANTRY.CPP, Draw_It draws one body. Other parts are empty padding for
            // vehicle turrets and carry no house remap.
            const animated = c.element(state.add(C.CFIRE)).greaterThanEqual(0)
              .or(c.element(state.add(C.CPRONE)).notEqual(0)).or(c.element(state.add(C.CACTION)).notEqual(0));
            If(part.equal(0).and(animated), () => {
              replace.assign(1);
              x.assign(pixel(u.element(at)).sub(2));
              y.assign(pixel(u.element(at.add(1))).add(4));
              const action = select(c.element(state.add(C.CFIRE)).greaterThanEqual(0), select(c.element(state.add(C.CPRONE)).notEqual(0), int(8), int(4)), select(u.element(at.add(U.UDEST)).greaterThanEqual(0), int(6), int(2))).toVar();
              If(c.element(state.add(C.CACTION)).notEqual(0), () => { action.assign(c.element(state.add(C.CACTION))); });
              const a = type.add(4).add(action.mul(3)), face = data.element(u.element(at.add(U.UFACE)).mul(2).add(facingBase + 1));
              const stage = select(c.element(state.add(C.CFIRE)).greaterThanEqual(0), c.element(state.add(C.CFIRE)), select(u.element(at.add(U.UDEST)).greaterThanEqual(0), u.element(at.add(U.UWALK)).div(2).mod(data.element(a.add(1))), int(0))).toVar();
              If(c.element(state.add(C.CACTION)).notEqual(0), () => { stage.assign(c.element(state.add(C.CSTAGE)).div(select(action.equal(7), int(3), int(2)))); });
              shape.assign(data.element(type).add(data.element(a)).add(face.mul(data.element(a.add(2)))).add(stage));
              remap.assign(int(dest.element(index.mul(3).add(1)).z));
              shadow.assign(1);
            });
          }).ElseIf(part.greaterThan(0).and(dest.element(index.mul(3)).z.greaterThan(0)), () => {
            // TURRET.CPP / UNIT.CPP Draw_It: the turret uses SecondaryFacing independently.
            const face = data.element(c.element(state.add(C.CTURRET)).mul(2).add(facingBase));
            const r = rectangles.element(data.element(type).add(face).add(32));
            const old = dest.element(index.mul(3)), atlas = dest.element(index.mul(3).add(1));
            dest.element(index.mul(3)).assign(vec4(old.x, old.y, r.z, r.w));
            dest.element(index.mul(3).add(1)).assign(vec4(r.x, r.y, atlas.z, atlas.w));
          });
        });
      }).ElseIf(index.greaterThanEqual(ground.layout.count), () => {
        replace.assign(1);
        shadow.assign(1);
        const relative = index.sub(ground.layout.count);
        If(relative.lessThan(shots), () => {
          const b = relative.mul(C.BWORDS), bt = p.element(b.add(C.BTYPE)).mul(5).add(bulletBase);
          x.assign(pixel(p.element(b)));
          y.assign(pixel(p.element(b.add(1))).sub(pixel(p.element(b.add(C.BALTITUDE)))));
          If(p.element(b.add(C.BACTIVE)).notEqual(0), () => {
            If(data.element(bt.add(2)).equal(0), () => {
              const frame = select(data.element(bt.add(3)).notEqual(0), int(0), data.element(p.element(b.add(C.BFACE)).mul(2).add(facingBase)));
              shape.assign(data.element(bt).add(frame));
            });
          }).ElseIf(p.element(b.add(C.BEXPLODED)).greaterThanEqual(0), () => {
            animation.assign(data.element(bt.add(4)));
            age.assign(clock.element(0).sub(p.element(b.add(C.BEXPLODED))));
            y.assign(pixel(p.element(b.add(1))));
          });
        }).Else(() => {
          const id = relative.sub(shots), state = id.mul(C.CWORDS);
          const slot = c.element(state.add(C.CCURSOR)).add(C.SHOTS_PER_UNIT - 1).mod(C.SHOTS_PER_UNIT);
          const b = id.mul(C.SHOTS_PER_UNIT).add(slot).mul(C.BWORDS);
          If(c.element(state.add(C.CLAST_FIRE)).greaterThanEqual(0), () => {
            animation.assign(data.element(p.element(b.add(C.BWEAPON)).add(weaponBase)));
            // ADATA.CPP directional muzzle/flame animations occupy eight consecutive entries.
            If(animation.equal(ANIMATION_IDS.ANIM_GUN_N).or(animation.equal(ANIMATION_IDS.ANIM_FLAME_N)).or(animation.equal(ANIMATION_IDS.ANIM_CHEM_N)), () => {
              animation.addAssign(p.element(b.add(C.BFIRE_FACE)).add(16).bitAnd(255).shiftRight(5));
            });
            age.assign(clock.element(0).sub(c.element(state.add(C.CLAST_FIRE))));
            x.assign(pixel(p.element(b.add(C.BFIRE_X))));
            y.assign(pixel(p.element(b.add(C.BFIRE_Y))));
          });
        });
      });
      If(animation.greaterThanEqual(0), () => {
        const a = animation.mul(9).add(animBase), frame = age.div(data.element(a.add(4)));
        If(frame.lessThan(data.element(a.add(3))), () => { blend.assign(data.element(a.add(8))); shadow.assign(0); shape.assign(data.element(a).add(data.element(a.add(2))).add(frame)); });
      });
      If(replace.notEqual(0), () => {
        dest.element(index.mul(3)).assign(vec4(0));
        dest.element(index.mul(3).add(2)).assign(vec4(0, 0, blend, 0));
        If(shape.greaterThanEqual(0), () => {
          const r = rectangles.element(shape);
          dest.element(index.mul(3)).assign(vec4(x.sub(r.z.div(2)), y.sub(r.w.div(2)), r.z, r.w));
          dest.element(index.mul(3).add(1)).assign(vec4(r.x, r.y, remap, shadow));
        });
      });
    })().compute(mainCount);
    const smokeFrames = scene.animation!.frames.get('SMOKE_M')?.length ?? 0;
    const smokeLoop = 67, smokeEnd = Math.max(smokeLoop + 1, smokeFrames - 1);
    const smokeDuration = smokeFrames + (smokeEnd - smokeLoop) * 5;
    const stateArray = new Int32Array(units * 2 + trails.count * 3).fill(-1);
    const effects = storage(keep(stateArray), 'int', stateArray.length);
    const stamp = Fn(() => {
      const id = int(instanceIndex);
      If(id.lessThan(units), () => {
        const at = id.mul(U.WORDS), t = u.element(at.add(U.UTYPE)), hp = u.element(at.add(U.UHEALTH));
        const born = effects.element(id.mul(2));
        If(data.element(t.mul(2).add(healthBase + 1)).notEqual(0).and(hp.greaterThan(0))
          .and(hp.mul(2).lessThan(data.element(t.mul(2).add(healthBase))))
          .and(effects.element(id.mul(2).add(1)).greaterThan(hp).or(effects.element(id.mul(2).add(1)).equal(-1)))
          .and(born.lessThan(0).or(clock.element(0).sub(born).greaterThanEqual(smokeDuration))), () => { born.assign(clock.element(0)); });
        effects.element(id.mul(2).add(1)).assign(hp);
      });
      if (trails.count) {
        const first = data.element(id.add(trailBase)), b = id.mul(C.BWORDS);
        If(first.greaterThanEqual(0).and(p.element(b.add(C.BTRAIL_TICK)).equal(clock.element(0)))
          .and(clock.element(0).greaterThan(0)), () => {
            const record = first.add(clock.element(0).div(2).mod(trails.history)).mul(3).add(units * 2);
            effects.element(record).assign(p.element(b.add(C.BTRAIL_X)));
            effects.element(record.add(1)).assign(p.element(b.add(C.BTRAIL_Y)));
            effects.element(record.add(2)).assign(clock.element(0));
          });
      }
    })().compute(shots);
    const extra = Fn(() => {
      const id = int(instanceIndex), index = id.add(mainCount), animation = int(-1).toVar();
      const age = int(0).toVar(), x = int(0).toVar(), y = int(0).toVar();
      const pixel = (v: import('three/webgpu').Node<'int'>) => v.mul(24).add(128).div(256);
      If(id.lessThan(units * 2), () => {
        const unit = id.mod(units), at = unit.mul(U.WORDS), state = unit.mul(C.CWORDS), type = u.element(at.add(U.UTYPE));
        x.assign(pixel(u.element(at)));
        y.assign(pixel(u.element(at.add(1))));
        If(id.lessThan(units), () => {
          const born = effects.element(unit.mul(2));
          If(born.greaterThanEqual(0).and(u.element(at.add(U.UHEALTH)).greaterThan(0))
            .and(clock.element(0).sub(born).lessThan(smokeDuration)), () => {
              animation.assign(ANIMATION_IDS.ANIM_SMOKE_M);
              age.assign(clock.element(0).sub(born));
              y.subAssign(8);
              If(age.greaterThanEqual(smokeEnd).and(age.lessThan(smokeEnd + (smokeEnd - smokeLoop) * 5)), () => {
                age.assign(age.sub(smokeLoop).mod(smokeEnd - smokeLoop).add(smokeLoop));
              }).ElseIf(age.greaterThanEqual(smokeEnd + (smokeEnd - smokeLoop) * 5), () => { age.subAssign((smokeEnd - smokeLoop) * 5); });
            });
        }).ElseIf(u.element(at.add(U.UKIND)).notEqual(0).and(c.element(state.add(C.CDEATH)).greaterThanEqual(0))
          .and(c.element(state.add(C.CWARHEAD)).notEqual(C.CRUSHED)), () => {
            animation.assign(data.element(type.mul(2).add(deathBase).add(int(c.element(state.add(C.CAMMO)).greaterThan(0)))));
            age.assign(clock.element(0).sub(c.element(state.add(C.CDEATH))));
          });
      }).Else(() => {
        const record = id.sub(units * 2).mul(3).add(units * 2), born = effects.element(record.add(2));
        If(born.greaterThanEqual(0), () => {
          animation.assign(ANIMATION_IDS.ANIM_SMOKE_PUFF);
          age.assign(clock.element(0).sub(born));
          x.assign(pixel(effects.element(record)));
          y.assign(pixel(effects.element(record.add(1))));
        });
      });
      dest.element(index.mul(3)).assign(vec4(0));
      dest.element(index.mul(3).add(2)).assign(vec4(0));
      If(animation.greaterThanEqual(0), () => {
        const a = animation.mul(9).add(animBase), frame = age.div(data.element(a.add(4)));
        If(frame.lessThan(data.element(a.add(3))), () => {
          const r = rectangles.element(data.element(a).add(data.element(a.add(2))).add(frame));
          dest.element(index.mul(3)).assign(vec4(x.sub(r.z.div(2)), y.sub(r.w.div(2)), r.z, r.w));
          dest.element(index.mul(3).add(1)).assign(vec4(r.x, r.y, scene.plainRemap, 0));
          dest.element(index.mul(3).add(2)).assign(vec4(0, 0, data.element(a.add(8)), 0));
        });
      });
    })().compute(units * 2 + trails.count);
    this.passes = [clear, mark, settle, draw, stamp, extra];
    this.update();
  }
  update() { this.renderer.compute(this.passes); this.pipeline.updateGpuSprites(this.count); }
  dispose() {
    for (const p of this.passes)
      p.dispose();
    releaseStorage(this.renderer, this.attributes);
  }
}
