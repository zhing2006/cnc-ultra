import type { Node } from 'three/webgpu';
import { int, select } from 'three/tsl';
import type { UnitsSetup } from './units-state.ts';

/** HOUSE.CPP Is_Ally/Make_Ally: campaign alliances are directed and always include the house itself. */
export function areAllied(setup: UnitsSetup, source: number, target: number) {
  return source === target || !!((setup.allies?.[source] ?? 0) & 1 << target);
}

/** No extra storage binding; skirmishes without alliances retain the original equality comparison. */
export function alliedOwners(setup: UnitsSetup, source: Node<'int'>, target: Node<'int'>) {
  if (!setup.allies) return source.equal(target);
  let mask: Node<'int'> = int(0);
  setup.allies.forEach((value, owner) => { mask = select(source.equal(int(owner)), int(value | 1 << owner), mask); });
  return source.equal(target).or(mask.bitAnd(int(1).shiftLeft(target)).notEqual(int(0)));
}
