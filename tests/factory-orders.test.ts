import { describe, expect, it } from 'vitest';
import { factoryOrderFixture } from './factory-orders-fixture.ts';
import { SERVICE_BASE, SERVICE_WORDS, SFACILITY } from '../src/game/simulation/services-cpu.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';

describe('Player orders during factory exit', () => {
  for (const name of ['PYLE', 'HAND', 'WEAP']) it(`${name} keeps an attack order while completing its physical exit`, () => {
    const { cpu, services, target, step } = factoryOrderFixture(name);
    step(); step([{ frame: cpu.frame + 1, kind: 'attack-ground', target, ids: [1] }]);
    for (let tick = 0; tick < 800; tick++) step();
    expect(cpu.state[C.CWORDS + C.CMISSION]).toBe(C.ATTACK);
    expect(cpu.state[C.CWORDS + C.CTARGET]).toBe(-target - 2);
    expect(cpu.units[U.WORDS + U.UENTER]).toBe(0);
    expect(services[SERVICE_BASE + SERVICE_WORDS + SFACILITY]).toBe(0);
  });
  for (const name of ['PYLE', 'HAND', 'WEAP', 'PROC']) for (const timing of ['opening', 'moving']) {
    it(`${name} keeps a new move destination during ${timing} and releases production`, () => {
      // EVENT.CPP MEGAMISSION replaces NavCom. INFANTRY/UNIT.CPP Per_Cell_Process
      // releases the factory tether; it does not restore Exit_Object's old destination.
      const { cpu, services, target, step } = factoryOrderFixture(name);
      step();
      if (timing === 'moving') for (let tick = 0; tick < 100 && cpu.units[U.WORDS + U.UDEST] < 0; tick++) step();
      expect(cpu.units[U.WORDS + U.UENTER]).toBe(-1);
      step([{ frame: cpu.frame + 1, kind: 'move', target, ids: [1] }]);
      for (let tick = 0; tick < 800; tick++) step();
      expect(cpu.units[U.WORDS + U.UCELL]).toBe(target);
      expect(cpu.units[U.WORDS + U.UENTER]).toBe(0);
      expect(services[SERVICE_BASE + SERVICE_WORDS + SFACILITY]).toBe(0);
      for (let tick = 0; tick < 40; tick++) step();
      expect(cpu.units[U.WORDS + U.UCELL]).toBe(target);
      expect(cpu.state[C.CWORDS + C.CMISSION]).not.toBe(C.HARVEST);
    });
  }
});
