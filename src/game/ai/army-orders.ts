// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { Fn, If, Break, int, uint, ivec2, storage, uniform, array, instanceIndex } from 'three/tsl';
import { StorageBufferAttribute, Vector3, type Node } from 'three/webgpu';
import { randomNode, intMin, intMax } from '../../engine/simulation/integer-nodes.ts';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { randomWord } from '../../engine/simulation/fixed.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { combatTypes } from '../data/combat.ts';
import { movementType } from '../data/movement.ts';
import { movePoint } from '../coord.ts';
import { unitDistance } from '../simulation/units-nodes.ts';
import { defenseValues, randomCellInZone, whichZone } from './base-planning.ts';
import type { GpuCombat } from '../simulation/combat-gpu.ts';
import type { CpuCombat } from '../simulation/combat-cpu.ts';
import type { ArmyOrder } from './commander.ts';
import * as U from '../simulation/units-state.ts';
import * as C from '../simulation/combat-state.ts';
type I = Node<'int'>;

/** Remaster MAP.CPP Nearby_Location, preserving ring order and repeated corner entries. */
export function nearbyGuardPost(battle: CpuCombat, cell: number, frame: number) {
  const { width, height, edges } = battle.setup.grid;
  const bounds = battle.setup.bounds ?? { x: 0, y: 0, width, height };
  const x = cell % width, y = Math.trunc(cell / width), candidates: number[] = [];
  const visit = (xx: number, yy: number) => {
    if (candidates.length === 10 || xx < bounds.x || yy < bounds.y || xx >= bounds.x + bounds.width || yy >= bounds.y + bounds.height) return;
    const target = yy * width + xx;
    // Static scenery is represented by the runtime's terrain mask, not occupier objects.
    if (!(battle.setup.passable?.[target] ?? edges[target]) || battle.movement.occupancy.subarray(target * 5, target * 5 + 5).some(Boolean)) return;
    candidates.push(target);
  };
  for (let radius = 0; radius < width; radius++) {
    for (let xx = x - radius; xx <= x + radius && candidates.length < 10; xx++) { visit(xx, y - radius); visit(xx, y + radius); }
    if (candidates.length < 10) for (let yy = y - radius; yy <= y + radius && candidates.length < 10; yy++) { visit(x - radius, yy); visit(x + radius, yy); }
    if (candidates.length) return candidates[frame % candidates.length];
  }
  return -1;
}

/** Remaster HOUSE.CPP AI_Attack: attack participation, or reposition guards that stay home. */
export function applyArmyOrder(battle: CpuCombat, order: ArmyOrder) {
  const { width, height } = battle.setup.grid;
  const bounds = battle.setup.bounds ?? { x: 0, y: 0, width, height };
  const playable = new Uint8Array(width * height);
  if (order.base) for (let y = bounds.y; y < bounds.y + bounds.height; y++) playable.fill(1, y * width + bounds.x, y * width + bounds.x + bounds.width);
  for (let id = 0; id < battle.setup.units.length; id++) {
    const at = id * U.WORDS, state = id * C.CWORDS, type = battle.units[at + U.UTYPE];
    if (battle.units[at + U.UOWNER] !== order.owner || battle.units[at + U.UHEALTH] <= 0 || battle.units[at + U.UATTACHED]
      || battle.units[at + U.UDOMAIN] === 2 || !order.all && combatTypes[type].primary < 0 && type !== movementType('E6')) continue;
    const pick = (stream: number, count: number) => randomWord(battle.setup.seed, order.frame, id, stream) % count;
    if (order.attack && (order.forced || pick(408, 100) < 75)) {
      battle.state[state + C.CMISSION] = C.HUNT; battle.state[state + C.CTARGET] = -1; battle.state[state + C.CSCAN] = 0;
      battle.state[state + C.CSUSPENDED_MISSION] = 0; battle.units[at + U.UOBSTRUCTION] = 0;
      battle.movement.goals[id] = battle.movement.pathGoals[id] = -1;
    } else if (order.base && battle.units[at + U.UDOMAIN] === 0 && battle.state[state + C.CMISSION] === C.GUARD_AREA
      && pick(460, 100) < 20 && whichZone(order.base, battle.units[at], battle.units[at + 1]) >= 0) {
      const zone = defenseValues(combatTypes[type].name).some(value => value > 0) ? 1 + pick(461, 4) : 0;
      const cell = randomCellInZone(order.base, zone, { width, height, playable }, pick, 462);
      battle.state[state + C.CGUARD_CELL] = nearbyGuardPost(battle, cell, order.frame) + 1;
    }
  }
}

export class GpuArmyOrders {
  private readonly owner = uniform(0, 'int');
  private readonly frame = uniform(0, 'int');
  private readonly attack = uniform(0, 'int');
  private readonly forced = uniform(0, 'int');
  private readonly all = uniform(0, 'int');
  private readonly hasBase = uniform(0, 'int');
  private readonly base = uniform(new Vector3(), 'ivec3');
  private readonly types: StorageBufferAttribute;
  private readonly mapChanged: (edges: Uint32Array, passable: Uint8Array) => void;
  private readonly pass;
  constructor(private readonly battle: GpuCombat) {
    const { width, height } = battle.setup.grid;
    const bounds = battle.setup.bounds ?? { x: 0, y: 0, width, height };
    const left = bounds.x, right = left + bounds.width, top = bounds.y, bottom = top + bounds.height;
    const trig = combatTypes.length * 2, open = trig + 512;
    this.types = new StorageBufferAttribute(Int32Array.from([
      ...combatTypes.flatMap(type => [type.primary, Number(defenseValues(type.name).some(value => value > 0))]),
      ...Array.from({ length: 256 }, (_, facing) => { const [x, y] = movePoint(0, 0, facing, 128); return [x, -y]; }).flat(),
      ...Array.from(battle.setup.passable ?? battle.setup.grid.edges, value => Number(value !== 0)),
    ]), 1);
    this.mapChanged = (_edges, passable) => {
      (this.types.array as Int32Array).set(passable, open);
      this.types.addUpdateRange(open, passable.length); this.types.needsUpdate = true;
    };
    battle.movement.mapObservers.add(this.mapChanged);
    const data = storage(this.types, 'int', this.types.count).toReadOnly();
    const units = storage(battle.units, 'int', battle.units.count), state = storage(battle.state, 'int', battle.state.count);
    const goals = storage(battle.movement.goals, 'int', battle.movement.goals.count), paths = storage(battle.movement.pathGoals, 'int', battle.movement.pathGoals.count);
    const occupancy = storage(battle.movement.occupancy, 'uint', battle.movement.occupancy.count).toReadOnly();
    this.pass = Fn(() => {
      const id = int(instanceIndex), at = id.mul(U.WORDS), c = id.mul(C.CWORDS), type = units.element(at.add(U.UTYPE));
      const pick = (stream: number, count: I) => int(randomNode(uint(battle.setup.seed), uint(this.frame), uint(id), uint(stream)).mod(uint(count)));
      const inside = (x: I, y: I) => x.greaterThanEqual(int(left)).and(x.lessThan(int(right))).and(y.greaterThanEqual(int(top))).and(y.lessThan(int(bottom)));
      If(units.element(at.add(U.UOWNER)).equal(this.owner).and(units.element(at.add(U.UHEALTH)).greaterThan(int(0)))
        .and(units.element(at.add(U.UATTACHED)).equal(int(0))).and(units.element(at.add(U.UDOMAIN)).notEqual(int(2)))
        .and(this.all.notEqual(int(0)).or(data.element(type.mul(2)).greaterThanEqual(int(0))).or(type.equal(int(movementType('E6'))))), () => {
        If(this.attack.notEqual(int(0)).and(this.forced.notEqual(int(0)).or(pick(408, int(100)).lessThan(int(75)))), () => {
          state.element(c.add(C.CMISSION)).assign(C.HUNT); state.element(c.add(C.CTARGET)).assign(-1);
          state.element(c.add(C.CSCAN)).assign(0); goals.element(id).assign(-1); paths.element(id).assign(-1);
          state.element(c.add(C.CSUSPENDED_MISSION)).assign(0); units.element(at.add(U.UOBSTRUCTION)).assign(0);
        }).ElseIf(this.hasBase.notEqual(int(0)).and(units.element(at.add(U.UDOMAIN)).equal(int(0)))
          .and(state.element(c.add(C.CMISSION)).equal(int(C.GUARD_AREA))).and(pick(460, int(100)).lessThan(int(20)))
          .and(unitDistance(ivec2(units.element(at), units.element(at.add(1))), this.base.xy).lessThanEqual(this.base.z.mul(4))), () => {
          const zone = int(0).toVar();
          If(data.element(type.mul(2).add(1)).notEqual(int(0)), () => { zone.assign(pick(461, int(4)).add(1)); });
          const facing = pick(462, int(256)).toVar(), radius = pick(463, this.base.z.add(1)).toVar(), fallback = int(0).toVar();
          If(zone.notEqual(int(0)), () => {
            const edge = this.base.y.sub(top * 256).toVar();
            If(zone.equal(int(2)), () => { edge.assign(int(right * 256).sub(this.base.x)); });
            If(zone.equal(int(3)), () => { edge.assign(int(bottom * 256).sub(this.base.y)); });
            If(zone.equal(int(4)), () => { edge.assign(this.base.x.sub(left * 256)); });
            const maximum = intMin(this.base.z.mul(3), edge.sub(256)).toVar();
            If(maximum.greaterThanEqual(int(0)), () => {
              const minimum = intMin(this.base.z.mul(2), maximum).toVar();
              facing.assign(zone.sub(1).mul(64).sub(32).add(pick(462, int(65))));
              radius.assign(minimum.add(pick(463, maximum.sub(minimum).add(1))));
            }).Else(() => { fallback.assign(1); });
          });
          const x = int(0).toVar(), y = int(0).toVar();
          const locate = () => {
            x.assign(this.base.x.add(data.element(facing.bitAnd(255).mul(2).add(trig)).mul(radius).shiftRight(7)).div(256));
            y.assign(this.base.y.sub(data.element(facing.bitAnd(255).mul(2).add(trig + 1)).mul(radius).shiftRight(7)).div(256));
          };
          locate();
          If(zone.notEqual(int(0)).and(fallback.notEqual(int(0)).or(inside(x, y).not())), () => {
            facing.assign(pick(464, int(256))); radius.assign(pick(465, this.base.z.add(1))); locate();
          });
          If(inside(x, y).not(), () => { x.assign(this.base.x.div(256)); y.assign(this.base.y.div(256)); });
          x.assign(intMax(int(left), intMin(int(right - 1), x))); y.assign(intMax(int(top), intMin(int(bottom - 1), y)));
          const candidates = array('int', 10).toVar() as unknown as { element(index: I): I };
          const count = int(0).toVar();
          const visit = (xx: I, yy: I) => {
            If(count.lessThan(int(10)).and(inside(xx, yy)), () => {
              const cell = yy.mul(width).add(xx).toVar(), free = int(1).toVar();
              If(data.element(cell.add(open)).equal(int(0)), () => { free.assign(0); });
              Loop(5, ({ i: slot }) => { If(occupancy.element(cell.mul(5).add(slot)).notEqual(uint(0)), () => { free.assign(0); }); });
              If(free.notEqual(int(0)), () => { candidates.element(count).assign(cell); count.addAssign(1); });
            });
          };
          Loop(width, ({ i: r }) => {
            Loop({ start: x.sub(r), end: x.add(r), condition: '<=', type: 'int' }, ({ i: xx }) => {
              visit(xx, y.sub(r)); visit(xx, y.add(r)); If(count.equal(int(10)), () => { Break(); });
            });
            If(count.lessThan(int(10)), () => {
              Loop({ start: y.sub(r), end: y.add(r), condition: '<=', type: 'int' }, ({ i: yy }) => {
                visit(x.sub(r), yy); visit(x.add(r), yy); If(count.equal(int(10)), () => { Break(); });
              });
            });
            If(count.greaterThan(int(0)), () => { Break(); });
          });
          state.element(c.add(C.CGUARD_CELL)).assign(0);
          If(count.greaterThan(int(0)), () => { state.element(c.add(C.CGUARD_CELL)).assign(candidates.element(this.frame.mod(count)).add(1)); });
        });
      });
    })().compute(battle.setup.units.length);
  }
  prepare() { return this.battle.renderer.compileComputeAsync(this.pass); }
  issue(order: ArmyOrder) {
    this.owner.value = order.owner; this.frame.value = order.frame; this.attack.value = Number(order.attack);
    this.forced.value = Number(order.forced); this.all.value = Number(!!order.all); this.hasBase.value = Number(!!order.base);
    if (order.base) this.base.value.set(order.base.x, order.base.y, order.base.radius);
    this.battle.renderer.compute(this.pass);
  }
  dispose() { this.battle.movement.mapObservers.delete(this.mapChanged); this.pass.dispose(); releaseStorage(this.battle.renderer, [this.types]); }
}
