import { expect, it } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { randomWord } from '../../engine/simulation/fixed.ts';
import { movementType } from '../data/movement.ts';
import { CpuCombat } from '../simulation/combat-cpu.ts';
import * as C from '../simulation/combat-state.ts';
import * as U from '../simulation/units-state.ts';
import { applyArmyOrder, nearbyGuardPost } from './army-orders.ts';

it('keeps the original Nearby_Location ring order, including repeated corners', () => {
  const battle = new CpuCombat({ grid: gridEdges(8, 8, new Uint8Array(64).fill(1), true),
    land: new Uint8Array(64), seed: 1995, units: [{ cell: 45, type: movementType('MTNK') }] });
  // MAP.CPP Nearby_Location: first ten candidates around occupied cell (5,5).
  const candidates = [36, 52, 37, 53, 38, 54, 36, 38, 44, 46];
  candidates.forEach((cell, frame) => expect(nearbyGuardPost(battle, 45, frame)).toBe(cell));
});

it('repositions a base guard when the house elects not to attack', () => {
  const seed = 1995, width = 32, cell = 16 * width + 16;
  const battle = new CpuCombat({ grid: gridEdges(width, width, new Uint8Array(width * width).fill(1), true),
    land: new Uint8Array(width * width), seed, units: [{ cell, type: movementType('MTNK') }] });
  battle.state[C.CMISSION] = C.GUARD_AREA; battle.state[C.CGUARD_CELL] = cell + 1;
  const frame = Array.from({ length: 100 }, (_, i) => i + 1).find(frame => randomWord(seed, frame, 0, 460) % 100 < 20)!;
  applyArmyOrder(battle, { owner: 0, frame, attack: false, forced: false,
    base: { x: 16 * 256 + 128, y: 16 * 256 + 128, radius: 512 } });
  expect(battle.state[C.CGUARD_CELL]).not.toBe(cell + 1);
  expect(battle.state[C.CGUARD_CELL]).toBeGreaterThan(0);
  expect(battle.state[C.CMISSION]).toBe(C.GUARD_AREA);
  expect(battle.units[U.UCELL]).toBe(cell);
});

it('returns an area guard toward its post after losing a pursued enemy', () => {
  const width = 32, home = 4 * width + 5;
  const battle = new CpuCombat({ grid: gridEdges(width, 9, new Uint8Array(width * 9).fill(1), true),
    land: new Uint8Array(width * 9), seed: 1995, multiplayer: true,
    units: [{ cell: home + 4, type: movementType('E1'), owner: 1 }] });
  battle.state[C.CMISSION] = C.GUARD_AREA; battle.state[C.CGUARD_CELL] = home + 1;
  for (let frame = 0; frame < 300; frame++) battle.step();
  expect(battle.state[C.CMISSION]).toBe(C.GUARD_AREA);
  expect(battle.units[U.UCELL]).toBe(home);
});
