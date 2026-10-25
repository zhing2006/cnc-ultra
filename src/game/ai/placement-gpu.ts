// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { Fn, If, Break, int, uint, ivec2, storage, uniform, array, atomicLoad, atomicStore, atomicAdd, atomicOr, atomicAnd, atomicMax,
  instanceIndex, localId, workgroupId, workgroupArray, workgroupBarrier, wgslFn } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { randomNode, intMax, intMin, trailingZeros } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { combatTypes, weapons } from '../data/combat.ts';
import { placementOffsets } from '../simulation/building-rules.ts';
import { unitDirection, unitDistance } from '../simulation/units-nodes.ts';
import type { GpuCombat } from '../simulation/combat-gpu.ts';
import * as U from '../simulation/units-state.ts';
import * as C from '../simulation/combat-state.ts';
type I = Node<'int'>;
type LocalArray = { element(index: I): I };
const exchange = wgslFn('fn defenseExchange(p: ptr<storage, atomic<u32>, read_write>, value: u32) -> u32 { return atomicExchange(p, value); }');
const uniformShared = wgslFn('fn defenseUniform(p: ptr<workgroup, u32>) -> u32 { return workgroupUniformLoad(p); }');
const REGION = 8, LANES = 64, TOP = 6, TYPE_WORDS = 5;

/** BUILDING.CPP Flush_For_Placement and TECHNO.CPP Base_Is_Attacked, without actor readback. */
export class GpuPlacementFlush {
  /** First N words are persistent cooldowns; the rest holds the index and bounded query scratch. */
  readonly cooldown: StorageBufferAttribute;
  private readonly table: StorageBufferAttribute;
  /** Striped spatial lists are scratch; ranking never depends on their insertion order. */
  private readonly members: StorageBufferAttribute;
  private readonly reset;
  private readonly index;
  private readonly seed;
  private readonly regions;
  private readonly finish;
  private preparedFrame = -1;
  private readonly target = uniform(-1, 'int');
  private readonly owner = uniform(0, 'int');
  private readonly origin = uniform(0, 'int');
  private readonly mapChanged: (edges: Uint32Array) => void;
  constructor(private readonly battle: GpuCombat) {
    const m = battle.movement, n = battle.setup.units.length, w = battle.setup.grid.width, h = battle.setup.grid.height;
    const rows = MOVEMENT.flatMap((t, id) => {
      const combat = combatTypes[id];
      return [combat.risk, weapons[combat.primary]?.range ?? 0, combat.primary, t.speed, combat.crusher];
    });
    const edges = rows.length, directions = edges + w * h;
    rows.push(...battle.setup.grid.edges, 0,-1, 1,-1, 1,0, 1,1, 0,1, -1,1, -1,0, -1,-1);
    const words = Math.ceil(n * 2 / 32), groups = Math.ceil(words / 32), readyBase = n * 2, summaryBase = readyBase + words * 2;
    const columns = Math.ceil(w / REGION), regionCount = columns * Math.ceil(h / REGION) + 1, outside = regionCount - 1;
    const statsBase = summaryBase + groups * 2, work = statsBase + regionCount * 3 * 2;
    // Active, enemy, required risk, sixth seed score; then six (score,key) pairs and regional pairs.
    const seedBase = work + 4, outputBase = seedBase + TOP * 2;
    this.table = new StorageBufferAttribute(Int32Array.from(rows), 1);
    this.cooldown = new StorageBufferAttribute(new Uint32Array(outputBase + regionCount * TOP * 2), 1);
    const heads = regionCount * LANES * 2;
    this.members = new StorageBufferAttribute(new Uint32Array(n + heads), 1);
    this.mapChanged = values => {
      (this.table.array as Int32Array).set(values, edges); this.table.addUpdateRange(edges, values.length); this.table.needsUpdate = true;
    };
    m.mapObservers.add(this.mapChanged);
    const u = storage(battle.units, 'int', battle.units.count), c = storage(battle.state, 'int', battle.state.count);
    const data = storage(this.table, 'int', this.table.count).toReadOnly();
    const goals = storage(m.goals, 'int', n), paths = storage(m.pathGoals, 'int', n);
    const occupancy = storage(m.occupancy, 'uint', m.occupancy.count).toReadOnly();
    const indexed = storage(this.cooldown, 'uint', this.cooldown.count).toAtomic();
    const members = storage(this.members, 'uint', this.members.count).toAtomic();
    const clock = storage(m.control, 'int', m.control.count).toReadOnly();
    const load = (at: I) => int(atomicLoad(indexed.element(at)));
    const maskAt = (at: I) => atomicLoad(indexed.element(at));
    const store = (at: I, value: I) => { atomicStore(indexed.element(at), uint(value)); };
    const unit = (id: I, field: number) => u.element(id.mul(U.WORDS).add(field));
    const state = (id: I, field: number) => c.element(id.mul(C.CWORDS).add(field));
    const type = (id: I, field: number) => data.element(unit(id, U.UTYPE).mul(TYPE_WORDS).add(field));
    const position = (id: I) => ivec2(unit(id, U.UX), unit(id, U.UY));
    const keyOf = (id: I) => int(1).sub(unit(id, U.UKIND)).mul(n).add(id);
    const anchor = (id: I) => {
      const cell = unit(id, U.UCELL).toVar();
      If(unit(id, U.UKIND).notEqual(int(0)).and(unit(id, U.UDEST).greaterThanEqual(int(0))), () => { cell.assign(unit(id, U.UDEST)); });
      return cell;
    };
    const ready = (key: I) => maskAt(this.owner.mul(words).add(readyBase).add(key.div(32))).bitAnd(uint(1).shiftLeft(uint(key.mod(32)))).notEqual(uint(0));
    const scoreOf = (id: I, enemy: I) => {
      const d = unitDistance(position(id), position(enemy)).sub(type(id, 1)), score = type(id, 0).mul(256).toVar();
      If(d.greaterThan(int(0)), () => { score.assign(intMax(int(1), score.div(intMax(int(1), d.div(intMax(int(1), type(id, 3))))))); });
      return score;
    };
    const insert = (scores: LocalArray, keys: LocalArray, score: I, key: I) => {
      const slot = int(TOP).toVar();
      Loop(TOP, ({ i }) => {
        If(slot.equal(int(TOP)).and(score.greaterThan(scores.element(i)).or(score.equal(scores.element(i)).and(key.lessThan(keys.element(i))))), () => { slot.assign(i); });
      });
      If(slot.lessThan(int(TOP)), () => {
        Loop({ start: int(TOP - 1), end: slot, condition: '>', update: '--', type: 'int' }, ({ i }) => {
          scores.element(i).assign(scores.element(i.sub(1))); keys.element(i).assign(keys.element(i.sub(1)));
        });
        scores.element(slot).assign(score); keys.element(slot).assign(key);
      });
    };
    const scatter = (id: I) => {
      const cell = unit(id, U.UCELL), start = unit(id, U.UFACE).add(16).bitAnd(255).div(32).toVar();
      If(unit(id, U.UKIND).notEqual(int(0)), () => {
        const local = position(id).mod(256);
        If(local.x.notEqual(int(128)).or(local.y.notEqual(int(128))), () => { start.assign(unitDirection(ivec2(128), local).add(16).bitAnd(255).div(32)); });
        start.assign(start.add(int(randomNode(uint(battle.setup.seed), uint(clock.element(0)), uint(id), uint(1)).mod(uint(5)))).add(6).bitAnd(7));
      });
      Loop(8, ({ i }) => {
        const dir = start.add(i).bitAnd(7);
        If(data.element(cell.add(edges)).bitAnd(int(1).shiftLeft(dir)).notEqual(int(0)), () => {
          const next = cell.add(data.element(dir.mul(2).add(directions))).add(data.element(dir.mul(2).add(directions + 1)).mul(w));
          const mask = int(0).toVar(), hostile = int(0).toVar();
          Loop(5, ({ i: slot }) => {
            const owner = int(occupancy.element(next.mul(5).add(slot))), other = owner.sub(1);
            const free = int(owner.equal(int(0)).or(owner.equal(id.add(1)))).toVar();
            If(owner.greaterThan(int(0)), () => {
              If(type(id, 4).notEqual(int(0)).and(unit(other, U.UKIND).notEqual(int(0))).and(unit(other, U.UOWNER).notEqual(unit(id, U.UOWNER))), () => { free.assign(1); });
              If(free.equal(int(0)).and(unit(other, U.UOWNER).notEqual(unit(id, U.UOWNER))), () => { hostile.assign(1); });
            });
            If(free.notEqual(int(0)), () => { mask.bitOrAssign(int(1).shiftLeft(slot)); });
          });
          If(hostile.equal(int(0)).and(unit(id, U.UKIND).notEqual(int(0)).and(mask.notEqual(int(0))).or(mask.equal(int(31)))), () => { goals.element(id).assign(next);unit(id,U.USCATTER_GOAL).assign(next.add(1)); });
        });
      });
      unit(id, U.UROUTE).assign(-1); unit(id, U.USTALLED).assign(0); paths.element(id).assign(-1);
    };
    this.reset = Fn(() => {
      const i = int(instanceIndex);
      If(i.lessThan(int(this.cooldown.count - n)), () => { store(i.add(n), int(0)); });
      If(i.lessThan(int(heads)), () => { atomicStore(members.element(i.add(n)), uint(0)); });
    })().compute(Math.max(this.cooldown.count - n, heads));
    this.index = Fn(() => {
      const id = int(instanceIndex), owner = unit(id, U.UOWNER), target = state(id, C.CTARGET), busy = int(0).toVar();
      If(unit(id, U.UHEALTH).greaterThan(int(0)).and(unit(id, U.UATTACHED).equal(int(0))).and(unit(id, U.UDOMAIN).equal(int(0)))
        .and(owner.greaterThanEqual(int(0))).and(owner.lessThan(int(2))), () => {
        If(target.greaterThanEqual(int(0)), () => {
          If(unit(target, U.UOWNER).notEqual(owner), () => { atomicAdd(indexed.element(target.add(n)), uint(type(id, 0))); });
          busy.assign(int(type(target, 2).greaterThanEqual(int(0))));
        });
        If(busy.equal(int(0)).and(type(id, 0).greaterThan(int(0))).and(unit(id, U.UTYPE).notEqual(int(movementType('HARV')))), () => {
          const key = keyOf(id), word = key.div(32), cell = anchor(id), region = int(outside).toVar();
          atomicOr(indexed.element(owner.mul(words).add(readyBase).add(word)), uint(1).shiftLeft(uint(key.mod(32))));
          atomicOr(indexed.element(owner.mul(groups).add(summaryBase).add(word.div(32))), uint(1).shiftLeft(uint(word.mod(32))));
          If(cell.greaterThanEqual(int(0)).and(cell.lessThan(int(w * h))), () => { region.assign(cell.div(w).div(REGION).mul(columns).add(cell.mod(w).div(REGION))); });
          const bucket = owner.mul(regionCount).add(region);
          const previous = exchange(members.element(bucket.mul(LANES).add(id.mod(LANES)).add(n)), uint(id.add(1)));
          atomicStore(members.element(id), previous);
          const at = bucket.mul(3).add(statsBase);
          atomicMax(indexed.element(at), uint(type(id, 0))); atomicMax(indexed.element(at.add(1)), uint(type(id, 1))); atomicMax(indexed.element(at.add(2)), uint(type(id, 3)));
        });
      });
    })().compute(n);
    this.seed = Fn(() => {
      store(int(work), int(0)); store(int(work + 3), int(0));
      Loop(TOP, ({ i }) => { store(i.mul(2).add(seedBase), int(0)); store(i.mul(2).add(seedBase + 1), int(n * 2)); });
      const enemy = this.target.toVar();
      If(enemy.lessThan(int(0)), () => {
        Loop(5, ({ i }) => { const id = int(occupancy.element(this.origin.mul(5).add(i))).sub(1); If(enemy.lessThan(int(0)).and(id.greaterThanEqual(int(0))), () => { enemy.assign(id); }); });
        If(enemy.greaterThanEqual(int(0)), () => {
          If(unit(enemy, U.UOWNER).equal(this.owner), () => {
            Loop(5, ({ i: slot }) => {
              const id = int(occupancy.element(this.origin.mul(5).add(slot))).sub(1), seen = int(0).toVar();
              Loop({ start: int(0), end: slot, type: 'int' }, ({ i }) => { If(occupancy.element(this.origin.mul(5).add(i)).equal(uint(id.add(1))), () => { seen.assign(1); }); });
              If(id.greaterThanEqual(int(0)).and(seen.equal(int(0))), () => { If(unit(id, U.UDOMAIN).equal(int(0)).and(unit(id, U.UATTACHED).equal(int(0))), () => { scatter(id); }); });
            });
            enemy.assign(-1);
          });
        });
      });
      If(enemy.greaterThanEqual(int(0)), () => {
        If(unit(enemy, U.UOWNER).notEqual(this.owner).and(unit(enemy, U.UHEALTH).greaterThan(int(0))).and(unit(enemy, U.UDOMAIN).equal(int(0)))
          .and(unit(enemy, U.UTYPE).notEqual(int(movementType('BOAT')))).and(unit(enemy, U.UTYPE).notEqual(int(movementType('LST')))).and(load(enemy).lessThanEqual(clock.element(0))), () => {
          const desired = type(enemy, 0).mul(2).sub(load(enemy.add(n))).toVar();
          store(int(work), int(1)); store(int(work + 1), enemy); store(int(work + 2), desired);
          If(desired.greaterThan(int(0)), () => {
            const scores = array(Array.from({ length: TOP }, () => int(0))).toVar() as unknown as LocalArray;
            const keys = array(Array.from({ length: TOP }, () => int(n * 2))).toVar() as unknown as LocalArray;
            const found = int(0).toVar();
            Loop(groups, ({ i: group }) => {
              If(found.equal(int(TOP)), () => { Break(); });
              const occupied = maskAt(this.owner.mul(groups).add(summaryBase).add(group)).toVar();
              Loop(() => {
                If(occupied.equal(uint(0)).or(found.equal(int(TOP))), () => { Break(); });
                const word = group.mul(32).add(int(trailingZeros(occupied))), bits = maskAt(this.owner.mul(words).add(readyBase).add(word)).toVar();
                Loop(() => {
                  If(bits.equal(uint(0)).or(found.equal(int(TOP))), () => { Break(); });
                  const key = word.mul(32).add(int(trailingZeros(bits))).toVar(), id = key.mod(n);
                  If(state(id, C.CTARGET).notEqual(enemy), () => { const score = scoreOf(id, enemy); insert(scores, keys, score, key); found.addAssign(1); });
                  bits.bitAndAssign(bits.sub(uint(1)));
                });
                occupied.bitAndAssign(occupied.sub(uint(1)));
              });
            });
            Loop(TOP, ({ i }) => { store(i.mul(2).add(seedBase), scores.element(i)); store(i.mul(2).add(seedBase + 1), keys.element(i)); });
            store(int(work + 3), scores.element(int(TOP - 1)));
          });
        });
      });
    })().compute(1);
    const lane = int(localId.x);
    const flag = workgroupArray('uint', 1) as unknown as { element(index: I): Node<'uint'> };
    const sharedScores = workgroupArray('int', LANES) as unknown as LocalArray;
    const sharedKeys = workgroupArray('int', LANES) as unknown as LocalArray;
    const winners = workgroupArray('int', TOP) as unknown as LocalArray;
    const active = () => (uniformShared({ p: flag.element(int(0)) }) as Node<'uint'>).notEqual(uint(0));
    const reduce = (score: I, key: I) => {
      sharedScores.element(lane).assign(score); sharedKeys.element(lane).assign(key); workgroupBarrier();
      for (let stride = LANES / 2; stride; stride >>= 1) {
        If(lane.lessThan(int(stride)), () => {
          const other = lane.add(stride), s = sharedScores.element(other), k = sharedKeys.element(other);
          If(s.greaterThan(sharedScores.element(lane)).or(s.equal(sharedScores.element(lane)).and(k.lessThan(sharedKeys.element(lane)))), () => {
            sharedScores.element(lane).assign(s); sharedKeys.element(lane).assign(k);
          });
        });
        workgroupBarrier();
      }
      const bestScore = sharedScores.element(int(0)).toVar(), bestKey = sharedKeys.element(int(0)).toVar();
      workgroupBarrier(); return [bestScore, bestKey] as const;
    };
    this.regions = Fn(() => {
      const region = int(workgroupId.x), enemy = load(int(work + 1)), threshold = load(int(work + 3));
      If(lane.lessThan(int(TOP)), () => { store(region.mul(TOP * 2).add(lane.mul(2)).add(outputBase), int(0)); store(region.mul(TOP * 2).add(lane.mul(2)).add(outputBase + 1), int(n * 2)); });
      If(lane.equal(int(0)), () => {
        const at = this.owner.mul(regionCount).add(region).mul(3).add(statsBase), risk = load(at), bound = int(0).toVar();
        If(risk.greaterThan(int(0)), () => {
          bound.assign(risk.mul(256));
          If(region.notEqual(int(outside)), () => {
            // Reservations can precede the physical position; extend the cell block by two cells.
            const left = region.mod(columns).mul(REGION * 256).sub(512), top = region.div(columns).mul(REGION * 256).sub(512);
            const nearest = ivec2(intMax(left, intMin(left.add((REGION + 4) * 256), unit(enemy, U.UX))), intMax(top, intMin(top.add((REGION + 4) * 256), unit(enemy, U.UY))));
            const d = unitDistance(position(enemy), nearest).sub(load(at.add(1)));
            If(d.greaterThan(int(0)), () => { bound.assign(intMax(int(1), bound.div(intMax(int(1), d.div(intMax(int(1), load(at.add(2)))))))); });
          });
        });
        flag.element(int(0)).assign(uint(load(int(work)).notEqual(int(0)).and(threshold.greaterThan(int(0))).and(bound.greaterThan(threshold))));
      });
      If(active(), () => {
        const scores = array(Array.from({ length: TOP }, () => int(0))).toVar() as unknown as LocalArray;
        const keys = array(Array.from({ length: TOP }, () => int(n * 2))).toVar() as unknown as LocalArray;
        const consider = (id: I) => {
          const key = keyOf(id).toVar(), seeded = int(0).toVar();
          Loop(TOP, ({ i }) => { If(load(i.mul(2).add(seedBase + 1)).equal(key), () => { seeded.assign(1); }); });
          If(seeded.equal(int(0)).and(ready(key)).and(state(id, C.CTARGET).notEqual(enemy)), () => { const score = scoreOf(id, enemy); insert(scores, keys, score, key); });
        };
        const member = atomicLoad(members.element(this.owner.mul(regionCount).add(region).mul(LANES).add(lane).add(n))).toVar();
        Loop(() => {
          If(member.equal(uint(0)), () => { Break(); });
          const id = int(member).sub(1).toVar();
          consider(id); member.assign(atomicLoad(members.element(id)));
        });
        Loop(TOP, ({ i: rank }) => {
          const [score, key] = reduce(scores.element(int(0)), keys.element(int(0)));
          If(lane.equal(int(0)), () => { store(region.mul(TOP * 2).add(rank.mul(2)).add(outputBase), score); store(region.mul(TOP * 2).add(rank.mul(2)).add(outputBase + 1), key); });
          If(keys.element(int(0)).equal(key), () => {
            Loop(TOP - 1, ({ i }) => { scores.element(i).assign(scores.element(i.add(1))); keys.element(i).assign(keys.element(i.add(1))); });
            scores.element(int(TOP - 1)).assign(0); keys.element(int(TOP - 1)).assign(n * 2);
          });
        });
      });
    })().compute(regionCount * LANES, [LANES]);
    this.finish = Fn(() => {
      If(lane.equal(int(0)), () => { flag.element(int(0)).assign(uint(load(int(work)).notEqual(int(0)))); });
      If(active(), () => {
        const enemy = load(int(work + 1)), desired = load(int(work + 2));
        const scores = array(Array.from({ length: TOP }, () => int(0))).toVar() as unknown as LocalArray;
        const keys = array(Array.from({ length: TOP }, () => int(n * 2))).toVar() as unknown as LocalArray;
        Loop({ start: lane, end: int((regionCount + 1) * TOP), update: '+= 64', type: 'int' }, ({ i }) => {
          const at = int(seedBase).add(i.mul(2)), score = load(at).toVar(), key = load(at.add(1)).toVar();
          If(score.greaterThan(int(0)), () => { insert(scores, keys, score, key); });
        });
        Loop(TOP, ({ i: rank }) => {
          const [, winner] = reduce(scores.element(int(0)), keys.element(int(0)));
          If(lane.equal(int(0)), () => { winners.element(rank).assign(winner); });
          If(keys.element(int(0)).equal(winner), () => {
            Loop(TOP - 1, ({ i }) => { scores.element(i).assign(scores.element(i.add(1))); keys.element(i).assign(keys.element(i.add(1))); });
            scores.element(int(TOP - 1)).assign(0); keys.element(int(TOP - 1)).assign(n * 2);
          });
          workgroupBarrier();
        });
        If(lane.equal(int(0)), () => {
          const total = int(0).toVar(), ownerWords = this.owner.mul(words).add(readyBase), ownerGroups = this.owner.mul(groups).add(summaryBase);
          If(desired.greaterThan(int(0)), () => {
            Loop(TOP, ({ i }) => {
              const key = winners.element(i); If(key.greaterThanEqual(int(n * 2)), () => { Break(); });
              const id = key.mod(n), previous = state(id, C.CTARGET).toVar();
              If(previous.greaterThanEqual(int(0)), () => { If(unit(previous, U.UOWNER).notEqual(this.owner), () => { atomicAdd(indexed.element(previous.add(n)), uint(type(id, 0).negate())); }); });
              atomicAdd(indexed.element(enemy.add(n)), uint(type(id, 0)));
              If(type(enemy, 2).greaterThanEqual(int(0)), () => {
                const word = key.div(32), at = ownerWords.add(word);
                atomicAnd(indexed.element(at), uint(1).shiftLeft(uint(key.mod(32))).bitNot());
                If(maskAt(at).equal(uint(0)), () => { atomicAnd(indexed.element(ownerGroups.add(word.div(32))), uint(1).shiftLeft(uint(word.mod(32))).bitNot()); });
              });
              state(id, C.CMISSION).assign(C.ATTACK); state(id, C.CTARGET).assign(enemy); state(id, C.CSCAN).assign(0); state(id, C.CLOCAL_ROUTE).assign(0); state(id, C.CROUTE_LENGTH).assign(0);
              state(id, C.CSUSPENDED_MISSION).assign(0); unit(id, U.UOBSTRUCTION).assign(0); goals.element(id).assign(-1); paths.element(id).assign(-1);
              total.addAssign(type(id, 0)); If(total.greaterThan(desired), () => { Break(); });
            });
          });
          If(total.greaterThan(desired), () => { store(enemy, clock.element(0).add(225)); });
        });
      });
    })().compute(LANES, [LANES]);
  }
  private refresh() {
    if (this.preparedFrame !== this.battle.frame) { this.battle.renderer.compute([this.reset, this.index]); this.preparedFrame = this.battle.frame; }
  }
  flush(owner: number, name: string, cell: number) {
    this.refresh(); this.target.value = -1; this.owner.value = owner;
    const { width, height } = this.battle.setup.grid;
    for (const [dx, dy] of placementOffsets(name)) {
      const x = cell % width + dx, y = Math.trunc(cell / width) + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      this.origin.value = y * width + x; this.battle.renderer.compute([this.seed, this.regions, this.finish]);
    }
  }
  respond(owner: number, enemy: number) {
    this.refresh(); this.owner.value = owner; this.target.value = enemy; this.battle.renderer.compute([this.seed, this.regions, this.finish]);
  }
  prepare() { return this.battle.renderer.compileComputeAsync([this.reset, this.index, this.seed, this.regions, this.finish]); }
  dispose() {
    this.battle.movement.mapObservers.delete(this.mapChanged);
    for (const pass of [this.reset, this.index, this.seed, this.regions, this.finish]) pass.dispose();
    releaseStorage(this.battle.renderer, [this.cooldown, this.table, this.members]);
  }
}
