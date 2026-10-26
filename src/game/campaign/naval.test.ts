import { describe, expect, it } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { movementType } from '../data/movement.ts';
import { CpuCombat } from '../simulation/combat-cpu.ts';
import * as U from '../simulation/units-state.ts';
import { landingCell, NAVAL_WORDS, stepNaval, type NavalMap } from './naval.ts';

export function navalFixture(passengers: string[]) {
  const width = 24, height = 16, land = new Uint8Array(width * height);
  land.fill(2, width * 10);
  const map: NavalMap = { width, land, clear: new Uint8Array(width * height).fill(1), bounds: { x: 3, y: 3, width: 18, height: 10 }, desert: false };
  const setup = { grid: gridEdges(width, height, map.clear, true), land, bounds: map.bounds, seed: 1995,
    units: [{ type: movementType('LST'), cell: 0, facing: 0 },
      ...passengers.map(type => ({ type: movementType(type), cell: 0, attached: 1 })),
      { type: movementType('BOAT'), cell: 12 * width + 10, facing: 192 }],
  };
  return { map, setup };
}

describe('Original beach delivery', () => {
  it('releases the hovercraft draw tether when its vehicle reaches land before the next mission poll', () => {
    const { map, setup } = navalFixture(['JEEP']);
    const battle = new CpuCombat(setup), state = new Int32Array(setup.units.length * NAVAL_WORDS);
    for (let tick = 0; tick < 400; tick++) {
      stepNaval(battle, state, map); battle.movement.occupy(); battle.step();
      if (state[0] === 3 && battle.units[U.WORDS + U.UCELL] !== battle.units[U.UCELL] && battle.units[U.WORDS + U.UDEST] < 0) break;
    }
    expect(state[0]).toBe(3);
    expect(battle.frame).toBeLessThan(state[2]);
    // UNIT.CPP Per_Cell_Process -> TECHNO.CPP RADIO_UNLOADED clears the tether
    // on arrival. The next ground sort must not wait for Mission_Unload's timer.
    stepNaval(battle, state, map);
    expect(battle.units[U.UFLAGS] & U.HOVER_TETHERED).toBe(0);
    expect(battle.units[U.WORDS + U.UFLAGS] & U.UNLOADING).toBe(0);
  });
  it('waits for a blocker in the adjacent return column before leaving the beach', () => {
    const { map, setup } = navalFixture(['JEEP']);
    const blocker = setup.units.length;
    setup.units.push({ type: movementType('MCV'), cell: 0, facing: 0, health: 0 } as typeof setup.units[number]);
    const battle = new CpuCombat(setup), state = new Int32Array(setup.units.length * NAVAL_WORDS);
    const step = () => { stepNaval(battle, state, map); battle.movement.occupy(); battle.step(); };
    for (let tick = 0; tick < 400 && state[0] !== 3; tick++) step();
    expect(state[0]).toBe(3);
    const cell = battle.units[U.UCELL], at = blocker * U.WORDS, obstacle = cell + map.width * 2 + 1;
    battle.units[at + U.UHEALTH] = 600; battle.units[at + U.UCELL] = obstacle;
    battle.units[at + U.UX] = obstacle % map.width * 256 + 128;
    battle.units[at + U.UY] = Math.trunc(obstacle / map.width) * 256 + 128;
    battle.movement.occupy();
    for (let tick = 0; tick < 90; tick++) step();
    expect(battle.units[U.UCELL]).toBe(cell); expect(state[0]).toBe(4);
    battle.units[at + U.UHEALTH] = 0; battle.movement.occupy();
    for (let tick = 0; tick < 400; tick++) step();
    expect(battle.units[U.UHEALTH]).toBe(0);
  });
  it('prefers three adjacent landing columns and the three-quarter entry', () => {
    const { map } = navalFixture([]);
    // DISPLAY.CPP: 18 candidates, 16 middle columns, index 16-16/4 = 12.
    expect(landingCell(map, () => false)).toBe(9 * map.width + 16);
    // Occupation two cells inland excludes the corresponding beach, not just water entry.
    expect(landingCell(map, cell => cell === 7 * map.width + 16)).toBe(9 * map.width + 14);
    expect(landingCell({ ...map, desert: true }, () => false)).toBe(10 * map.width + 16);
  });
  for (const passengers of [['E1', 'E1', 'E1'], ['JEEP']]) it(`lands ${passengers.join(', ')}, unloads and leaves the map`, () => {
    const { map, setup } = navalFixture(passengers), battle = new CpuCombat(setup);
    const state = new Int32Array(setup.units.length * NAVAL_WORDS);
    for (let frame = 0; frame < 900; frame++) { stepNaval(battle, state, map); battle.movement.occupy(); battle.step(); }
    expect(battle.units[U.UHEALTH]).toBe(0);
    for (let id = 1; id <= passengers.length; id++) {
      expect(battle.units[id * U.WORDS + U.UHEALTH]).toBeGreaterThan(0);
      expect(battle.units[id * U.WORDS + U.UATTACHED]).toBe(0);
      expect(Math.trunc(battle.units[id * U.WORDS + U.UCELL] / map.width)).toBe(8);
    }
    const boat = (setup.units.length - 1) * U.WORDS;
    expect(battle.units[boat + U.UHEALTH]).toBeGreaterThan(0);
    expect(battle.units[boat + U.UCELL]).not.toBe(setup.units.at(-1)!.cell);
  });
});
