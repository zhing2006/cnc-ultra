import type { WebGPURenderer } from 'three/webgpu';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import * as U from '../src/game/simulation/units-state.ts';
import { movingCombatScenario } from './moving-combat-scenario.ts';

/** Independent lanes share one simulation while retaining both player and computer orders. */
export async function compareMovingCombat(renderer: WebGPURenderer) {
  const cases = [
    ...['MTNK', 'E1'].flatMap(name => [0, 1].map(owner => ({ name, owner }))),
    ...['FTNK', 'MSAM'].map(name => ({ name, owner: 1 })),
  ].map(test => ({ ...test, ...movingCombatScenario(test.name, test.owner), first: 0, firstTarget: -1, shots: 0, arrived: false }));
  const width = 32, height = cases.length * 10;
  const setup: C.CombatSetup = {
    grid: { width, height, edges: new Uint32Array(width * height) }, passable: new Uint8Array(width * height),
    land: new Uint8Array(width * height), units: [], missions: [], seed: 1995, multiplayer: true,
  };
  cases.forEach((test, index) => {
    const offset = index * 10 * width;
    test.first = setup.units.length; test.goal += offset;
    setup.grid.edges.set(test.setup.grid.edges, offset); setup.passable!.set(test.setup.passable!, offset);
    setup.units = [...setup.units, ...test.setup.units.map(unit => ({ ...unit, cell: unit.cell + offset }))];
    setup.missions = [...setup.missions!, ...test.setup.missions!];
  });
  const cpu = new CpuCombat(setup), gpu = new GpuCombat(renderer, setup);
  try {
    await gpu.prepareForPlay();
    for (let frame = 1; frame <= 1600; frame++) {
      const commands: U.UnitCommand[] = frame === 1 ? cases.map(test => ({ frame, kind: 'move', ids: [test.first], target: test.goal })) : [];
      cpu.step(commands); if (frame === 1) gpu.step(commands);
      for (const test of cases) {
        const at = test.first * U.WORDS, c = test.first * C.CWORDS, locked = test.name === 'FTNK' || test.name === 'MSAM';
        if (test.firstTarget < 0 && cpu.state[c + C.CTARGET] >= 0) test.firstTarget = frame;
        if (cpu.units[at + U.UCELL] === test.goal) test.arrived = true;
        if (cpu.state[c + C.CLAST_FIRE] === frame) {
          test.shots++;
          if (cpu.state[c + C.CMISSION] === C.MOVE) {
            if (!test.owner || locked) throw new Error(`${test.name}/${test.owner} fired during a restricted move`);
            if ((test.name === 'E1') !== (cpu.units[at + U.UDEST] < 0)) throw new Error(`${test.name} used the wrong move/fire behavior`);
          }
        }
        if (test.owner && locked && !test.arrived && test.firstTarget >= 0 && cpu.state[c + C.CTARGET] !== test.first + 1)
          throw new Error(`${test.name} replaced a still-valid movement target at tick ${frame}: target ${cpu.state[c+C.CTARGET]}, expected ${test.first+1}, mission ${cpu.state[c+C.CMISSION]}, cell ${cpu.units[at+U.UCELL]}, first acquisition ${test.firstTarget}, health ${cpu.units[(test.first+1)*U.WORDS+U.UHEALTH]}`);
      }
      if (frame <= 24 || frame % 18 === 0 || frame === 1600) {
        gpu.stepMany(frame - gpu.frame);
        const expected = cpu.buffers(), actual = await gpu.snapshot();
        actual.forEach((values, b) => {
          for (let i = 0; i < values.length; i++) if (values[i] !== expected[b][i])
            throw new Error(`Moving combat tick ${frame}, buffer ${b}/${i}: GPU ${values[i]}, CPU ${expected[b][i]}`);
        });
      }
    }
    for (const test of cases) {
      const at = test.first * U.WORDS, c = test.first * C.CWORDS, locked = test.name === 'FTNK' || test.name === 'MSAM';
      if (!test.arrived) throw new Error(`${test.name}/${test.owner} lost its original movement destination`);
      if (!test.owner) {
        if (test.shots || test.firstTarget >= 0) throw new Error('A player move automatically acquired an enemy');
      } else if (locked) {
        if (cpu.state[c + C.CMISSION] !== C.ATTACK) throw new Error(`${test.name} did not attack its retained target after arrival`);
      } else if (test.firstTarget < 2 || (test.firstTarget - 2) % 18 || test.shots < 2 ||
        [1, 2].some(offset => cpu.units[(test.first + offset) * U.WORDS + U.UHEALTH] > 0)) {
        throw new Error(`${test.name} did not acquire and destroy targets along its route`);
      }
    }
  } finally { gpu.dispose(); }
}
