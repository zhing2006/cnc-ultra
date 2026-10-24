// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { Fn, If, int, uint, storage } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { MOVEMENT, GROUND_SPEED } from '../data/movement.ts';
import { WORDS, UTYPE } from './units-state.ts';
import type { GpuUnits } from './units-gpu.ts';

/** Ported from UNIT.CPP/INFANTRY.CPP, Can_Enter_Cell: the non-combat MOVE_OK cases. */
export function cellEntryNode(simulation: GpuUnits, keep: (attribute: StorageBufferAttribute) => void,
  unitBuffer?: {element(index:Node<'int'>):Node<'int'>}, occupiedBuffer?: {element(index:Node<'int'>):Node<'uint'>}) {
  const { grid, land, passable } = simulation.setup;
  const values = [...MOVEMENT.flatMap(t => [t.infantry, t.locomotion]), ...GROUND_SPEED.flat(),
    ...land, ...Array.from(passable ?? grid.edges, value => value ? 1 : 0)];
  const attribute = new StorageBufferAttribute(Int32Array.from(values), 1); keep(attribute);
  const data = storage(attribute, 'int', values.length).toReadOnly();
  const speedBase = MOVEMENT.length * 2, landBase = speedBase + GROUND_SPEED.length * 7;
  const openBase = landBase + land.length;
  const units = unitBuffer ?? storage(simulation.units, 'int', simulation.units.count).toReadOnly();
  const occupancy = occupiedBuffer ?? storage(simulation.occupancy, 'uint', grid.edges.length * 5).toReadOnly();
  return (id: Node<'int'>, cell: Node<'int'>) => Fn(() => {
    const type = units.element(id.mul(int(WORDS)).add(int(UTYPE))).mul(int(2));
    const free = int(0).toVar();
    Loop(5, ({ i: slot }) => {
      const owner = occupancy.element(cell.mul(int(5)).add(slot));
      If(owner.equal(uint(0)).or(owner.equal(uint(id.add(int(1))))), () => { free.addAssign(int(1)); });
    });
    const terrain = data.element(cell.add(int(landBase)));
    const speed = data.element(terrain.mul(int(7)).add(data.element(type.add(int(1)))).add(int(speedBase)));
    return data.element(cell.add(int(openBase))).notEqual(int(0)).and(speed.notEqual(int(0)))
      .and(data.element(type).notEqual(int(0)).and(free.greaterThan(int(0))).or(free.equal(int(5))));
  })();
}
