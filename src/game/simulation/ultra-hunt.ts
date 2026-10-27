// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, int, uint, storage, instanceIndex, atomicStore, atomicOr } from 'three/tsl';
import { CpuMultiFlowFields, GpuMultiFlowFields } from '../../engine/simulation/flow.ts';
import { DIRECTIONS, UNREACHABLE } from '../../engine/simulation/state.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { combatTypes } from '../data/combat.ts';
import { WALLS } from '../data/overlays.ts';
import { areAllied, alliedOwners } from './alliances.ts';
import type { CpuCombat } from './combat-cpu.ts';
import type { GpuCombat } from './combat-gpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';

// Design constitution, article 5: local THREAT_AREA acquisition, then a shared
// nearest-enemy field. FOOT.CPP Mission_Hunt supplies the 20-tick refresh period.
// Endpoint eligibility is ported from TECHNO.CPP, Evaluate_Object.
export class CpuUltraHunt {
  readonly flow: CpuMultiFlowFields;
  readonly mask: Uint32Array;
  constructor(readonly combat: CpuCombat) {
    this.flow = new CpuMultiFlowFields(combat.setup.grid, 2, 20);
    this.mask = new Uint32Array(combat.setup.grid.edges.length * 2);
  }
  update() {
    const { combat } = this, { units: u, setup } = combat, cells = setup.grid.edges.length;
    this.mask.fill(0);
    for (let id = 0; id < setup.units.length; id++) {
      const at = id * U.WORDS, type = combatTypes[u[at + U.UTYPE]];
      if (u[at + U.UHEALTH] <= 0 || u[at + U.UATTACHED] || u[at + U.UCLOAK] === 2 || u[at + U.UALTITUDE] > 0 ||
        !type.targetable || WALLS[type.name] || type.name === 'BOAT' || type.name === 'LST') continue;
      const cell = Math.trunc(u[at + 1] / 256) * setup.grid.width + Math.trunc(u[at] / 256);
      for (let owner = 0; owner < 2; owner++) if (!areAllied(setup, owner, u[at + U.UOWNER]) &&
        !(owner === combat.humanOwner && u[at + U.UDOMAIN] === 2 && type.primary < 0)) this.mask[owner * cells + cell] = 1;
    }
    this.flow.step(this.mask, combat.frame);
  }
  advance() {
    const { combat } = this, { units: u, state, movement: m, setup } = combat, cells = setup.grid.edges.length;
    for (let id = 0; id < setup.units.length; id++) {
      const at = id * U.WORDS, c = id * C.CWORDS, type = MOVEMENT[u[at + U.UTYPE]];
      if (u[at + U.UHEALTH] <= 0 || u[at + U.UATTACHED] || type.domain || type.locomotion >= 5 || type.name === 'E6' ||
        state[c + C.CMISSION] !== C.HUNT || state[c + C.CTARGET] !== -1 || u[at + U.UDEST] >= 0 || m.goals[id] >= 0) continue;
      const field = this.flow.status[u[at + U.UOWNER] * 4];
      if (field < 0) continue;
      const cell = u[at + U.UCELL], base = field * cells;
      let chosen = -1, best = UNREACHABLE;
      for (let d = 0; d < 8; d++) if (setup.grid.edges[cell] & (1 << d)) {
        const other = cell + DIRECTIONS[d][1] * setup.grid.width + DIRECTIONS[d][0];
        let free = 0;
        for (let slot = 0; slot < 5; slot++) if (!m.occupancy[other * 5 + slot] || m.occupancy[other * 5 + slot] === id + 1) free++;
        const value = this.flow.distance[base + other], cost = value + (d & 1 ? 362 : 256);
        if (free >= (type.infantry ? 1 : 5) && value < this.flow.distance[base + cell] && cost < best) { best = cost; chosen = other; }
      }
      if (chosen >= 0) { m.goals[id] = chosen; m.pathGoals[id] = U.DIRECT_STEP; u[at + U.UROUTE] = -1; }
    }
  }
  buffers() { return this.flow.buffers(); }
}

export class GpuUltraHunt {
  readonly flow: GpuMultiFlowFields;
  readonly kernels;
  readonly advance;
  private readonly attributes: StorageBufferAttribute[] = [];
  constructor(private readonly renderer: WebGPURenderer, combat: GpuCombat) {
    const { setup, movement } = combat, cells = setup.grid.edges.length, count = setup.units.length;
    const mask = new StorageBufferAttribute(new Uint32Array(cells * 2), 1);
    const typeValues = MOVEMENT.flatMap((type, i) => [
      Number(!!combatTypes[i].targetable && !WALLS[type.name] && type.name !== 'BOAT' && type.name !== 'LST'),
      combatTypes[i].primary, type.locomotion,
    ]);
    const packed = new Int32Array(typeValues.length + cells); packed.set(typeValues); packed.set(setup.grid.edges, typeValues.length);
    const data = new StorageBufferAttribute(packed, 1);
    this.attributes.push(mask, data);
    const seeds = storage(mask, 'uint', mask.count).toAtomic(), types = storage(data, 'int', data.count).toReadOnly();
    const u = storage(combat.units, 'int', combat.units.count), s = storage(combat.state, 'int', combat.state.count).toReadOnly();
    const goals = storage(movement.goals, 'int', count), paths = storage(movement.pathGoals, 'int', count);
    const occupancy = storage(movement.occupancy, 'uint', cells * 5).toReadOnly();
    movement.mapObservers.add(value => { packed.set(value,typeValues.length); data.needsUpdate = true; this.flow.updateEdges(value); });
    const edge = {element:(cell:import('three/webgpu').Node<'int'>)=>types.element(cell.add(typeValues.length))};
    this.flow = new GpuMultiFlowFields(renderer, setup.grid, mask, movement.control, 2, 20);
    const distance = storage(this.flow.distance, 'int', this.flow.distance.count).toReadOnly(), status = storage(this.flow.status, 'int', 8).toReadOnly();
    const clear = Fn(() => { atomicStore(seeds.element(instanceIndex), uint(0)); })().compute(cells * 2);
    const fill = Fn(() => {
      const id = int(instanceIndex), at = id.mul(U.WORDS), type = u.element(at.add(U.UTYPE)).mul(3);
      If(u.element(at.add(U.UHEALTH)).greaterThan(int(0)).and(u.element(at.add(U.UATTACHED)).equal(int(0))).and(u.element(at.add(U.UCLOAK)).notEqual(int(2)))
        .and(u.element(at.add(U.UALTITUDE)).equal(int(0))).and(types.element(type).notEqual(int(0))), () => {
        const cell = u.element(at.add(1)).div(256).mul(setup.grid.width).add(u.element(at).div(256));
        for (let owner = 0; owner < 2; owner++) If(alliedOwners(setup, int(owner), u.element(at.add(U.UOWNER))).not()
          .and(int(owner).notEqual(combat.humanOwner).or(u.element(at.add(U.UDOMAIN)).notEqual(int(2))).or(types.element(type.add(1)).greaterThanEqual(int(0)))), () => {
          atomicOr(seeds.element(cell.add(owner * cells)), uint(1));
        });
      });
    })().compute(count);
    this.kernels = [clear, fill];
    this.advance = Fn(() => {
      const id = int(instanceIndex), at = id.mul(U.WORDS), c = id.mul(C.CWORDS);
      If(u.element(at.add(U.UHEALTH)).greaterThan(int(0)).and(u.element(at.add(U.UATTACHED)).equal(int(0))).and(u.element(at.add(U.UDOMAIN)).equal(int(0)))
        .and(types.element(u.element(at.add(U.UTYPE)).mul(3).add(2)).lessThan(int(5))).and(u.element(at.add(U.UTYPE)).notEqual(int(movementType('E6'))))
        .and(s.element(c.add(C.CMISSION)).equal(int(C.HUNT))).and(s.element(c.add(C.CTARGET)).equal(int(-1)))
        .and(u.element(at.add(U.UDEST)).lessThan(int(0))).and(goals.element(id).lessThan(int(0))), () => {
        const field = status.element(u.element(at.add(U.UOWNER)).mul(4)).toVar();
        If(field.greaterThanEqual(int(0)), () => {
          const cell = u.element(at.add(U.UCELL)).toVar(), base = field.mul(cells).toVar(), chosen = int(-1).toVar(), best = int(UNREACHABLE).toVar();
          for (let d = 0; d < 8; d++) If(edge.element(cell).bitAnd(1 << d).notEqual(int(0)), () => {
            const other = cell.add(DIRECTIONS[d][1] * setup.grid.width + DIRECTIONS[d][0]), free = int(0).toVar();
            for (let slot = 0; slot < 5; slot++) {
              const owner = occupancy.element(other.mul(5).add(slot));
              If(owner.equal(uint(0)).or(owner.equal(uint(id.add(1)))), () => { free.addAssign(1); });
            }
            const value = distance.element(base.add(other)), cost = value.add(d & 1 ? 362 : 256);
            If(free.equal(int(5)).or(free.greaterThan(int(0)).and(u.element(at.add(U.UKIND)).notEqual(int(0))))
              .and(value.lessThan(distance.element(base.add(cell)))).and(cost.lessThan(best)), () => { best.assign(cost); chosen.assign(other); });
          });
          If(chosen.greaterThanEqual(int(0)), () => { goals.element(id).assign(chosen); paths.element(id).assign(U.DIRECT_STEP); u.element(at.add(U.UROUTE)).assign(-1); });
        });
      });
    })().compute(count);
  }
  get saveBuffers() { return [...this.attributes, ...this.flow.saveBuffers]; }
  async prepare() { await this.renderer.compileComputeAsync([...this.kernels, ...this.flow.prepare, ...this.flow.kernels, this.advance]); }
  update() { this.renderer.compute(this.kernels); this.flow.step(); }
  dispose() { for (const k of [...this.kernels, this.advance]) k.dispose(); this.flow.dispose(); releaseStorage(this.renderer, this.attributes); }
}
