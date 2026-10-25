import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';

export interface ReviewScenario {
  name: string; units: U.UnitPlacement[]; ticks?: number; resolveOnly?: boolean; corridor?: boolean;
  configure(battle: CpuCombat): void; verify(battle: CpuCombat): void;
}
function require(value: boolean, message: string) { if (!value) throw new Error(message); }
const unit = (name: string, cell: number, owner = 0, altitude = 0): U.UnitPlacement => ({ type: movementType(name), cell, owner, altitude, facing: 64 });
const overrun = (b: CpuCombat, vehicle: number, victim: number) => {
  const at = vehicle * U.WORDS, p = victim * U.WORDS;
  b.units[at + U.UOVERRUN_CELL] = b.units[p + U.UCELL];
  b.units[at + U.UOVERRUN_X] = b.units[p + U.UX]; b.units[at + U.UOVERRUN_Y] = b.units[p + U.UY];
};
export const reviewScenarios: ReviewScenario[] = [
  {
    name: 'AI cloak scatter uses crushable infantry cells', units: [unit('STNK', 88), unit('E1', 69, 1)],
    configure(b) { b.units[U.UCLOAK] = 1; b.units[U.UCLOAK_STAGE] = 37; },
    verify(b) { require(b.movement.goals[0] === 69, 'Cloak scatter did not select the crushable final neighbor'); },
  },
  {
    name: 'commando scans ground infantry below an aircraft', units: [unit('RMBO', 88), unit('ORCA', 90, 1, 24), unit('E1', 90, 1)],
    configure(b) { b.state[C.CSCAN] = 0; },
    verify(b) { require(b.state[C.CTARGET] === 2, 'Airborne occupant hid a ground target from the commando'); },
  },
  {
    name: 'anti-air scan finds aircraft above a cloaked ground unit', units: [unit('MSAM', 88), unit('STNK', 90, 1), unit('ORCA', 90, 1, 24)],
    configure(b) { b.state[C.CSCAN] = 0; b.units[U.WORDS + U.UCLOAK] = 2; },
    verify(b) { require(b.state[C.CTARGET] === 2, 'Cloaked ground occupant hid an aircraft'); },
  },
  {
    name: 'capture detaches current and suspended attack targets', resolveOnly: true,
    units: [unit('E6', 105), unit('NUKE', 105, 1), unit('MTNK', 103), unit('MTNK', 145), unit('MTNK', 165)],
    configure(b) {
      b.units[U.UABILITY_MODE] = 3; b.units[U.UABILITY_TARGET] = 2; b.units[U.UABILITY_ENTRY] = 106;
      b.state[2 * C.CWORDS + C.CTARGET] = 1; b.state[2 * C.CWORDS + C.CMISSION] = C.ATTACK;
      b.state[3 * C.CWORDS + C.CSUSPENDED_MISSION] = C.ATTACK + 1; b.state[3 * C.CWORDS + C.CSUSPENDED_TARGET] = 1;
      b.state[4*C.CWORDS+C.CTARGET]=1;b.state[4*C.CWORDS+C.CSUSPENDED_MISSION]=C.MOVE+1;
      b.state[4*C.CWORDS+C.CSUSPENDED_TARGET]=-1;b.state[4*C.CWORDS+C.CSUSPENDED_GOAL]=150;
      b.units[4*U.WORDS+U.UROUTE]=90;b.units[4*U.WORDS+U.UWAIT]=8;
    },
    verify(b) {
      require(b.units[U.WORDS + U.UOWNER] === 0, 'Engineer failed to capture');
      require(b.state[2 * C.CWORDS + C.CTARGET] === -1, 'Capturing army kept firing at its building');
      require(b.state[3 * C.CWORDS + C.CSUSPENDED_MISSION] === 0 && b.state[3*C.CWORDS+C.CSUSPENDED_TARGET]===-1, 'Captured target survived in a suspended attack');
      require(b.movement.goals[4]===150&&b.units[4*U.WORDS+U.UROUTE]===-1&&b.units[4*U.WORDS+U.UWAIT]===0,'Detaching the blocker did not restore the suspended move');
    },
  },
  {
    name: 'a second engineer entering an already captured building is consumed',resolveOnly:true,
    units:[{...unit('E6',105),health:0},unit('E6',106),unit('NUKE',105),unit('MTNK',145)],
    configure(b){
      b.movement.frame=2;b.units[2*U.WORDS+U.UCAPTURE_TICK]=1;
      b.units[U.WORDS+U.UABILITY_MODE]=3;b.units[U.WORDS+U.UABILITY_TARGET]=3;b.units[U.WORDS+U.UABILITY_ENTRY]=107;
      b.state[3*C.CWORDS+C.CTARGET]=2;b.state[3*C.CWORDS+C.CMISSION]=C.ATTACK;
    },
    verify(b){
      require(b.units[U.WORDS+U.UHEALTH]===0,'Second engineer remained inside the allied building');
      require(b.units[2*U.WORDS+U.UCAPTURE_TICK]===1&&b.state[3*C.CWORDS+C.CTARGET]===2,'Unsuccessful capture repeated ownership transfer or detach');
    },
  },
  {
    name:'forced C4 on an allied building plants the charge',resolveOnly:true,
    units:[unit('RMBO',105),unit('NUKE',105)],
    configure(b){b.units[U.UABILITY_MODE]=4;b.units[U.UABILITY_TARGET]=2;b.units[U.UABILITY_ENTRY]=106;b.units[U.UABILITY_ORIGIN]=85;},
    verify(b){require(b.units[U.WORDS+U.UBOMB_TICK]===21&&b.units[U.WORDS+U.UBOMB_SOURCE]===1,'Allied C4 charge was discarded');},
  },
  {
    name: 'crushing an infantry unit uncloaks the tank', resolveOnly: true,
    units: [unit('STNK', 89), unit('E1', 89, 1)],
    configure(b) { b.units[U.UCLOAK] = 2; overrun(b, 0, 1); },
    verify(b) { require(b.units[U.WORDS + U.UHEALTH] === 0, 'Infantry was not crushed'); require(b.units[U.UCLOAK] === 3, 'Crusher did not uncloak'); },
  },
  {
    name: 'crushed detectors cannot reveal a neighboring cloaked tank', resolveOnly: true,
    units: [unit('STNK', 88), unit('MTNK', 89), unit('E1', 89, 1)],
    configure(b) { b.units[U.UCLOAK] = 2; overrun(b, 0, 0); overrun(b, 1, 2); },
    verify(b) { require(b.units[2 * U.WORDS + U.UHEALTH] === 0, 'Detector was not crushed'); require(b.units[U.UCLOAK] === 2, 'Dead detector revealed the tank'); },
  },
  {
    name: 'crushed engineers cannot finish a capture', resolveOnly: true,
    units: [unit('E6', 105), unit('NUKE', 105, 1), unit('MTNK', 105, 1)],
    configure(b) { b.units[U.UABILITY_MODE] = 3; b.units[U.UABILITY_TARGET] = 2; b.units[U.UABILITY_ENTRY] = 106; overrun(b, 2, 0); },
    verify(b) { require(b.units[U.WORDS + U.UOWNER] === 1, 'Engineer captured after being crushed'); },
  },
  ...['JEEP', 'E1'].map(name => ({
    name: `${name} movement contact shimmers a cloaked obstacle`, units: [unit(name, 87), unit('STNK', 88, 1)], ticks: 6, corridor: true,
    configure(b: CpuCombat) { b.units[U.WORDS + U.UCLOAK] = 2; b.movement.goals[0] = 89; b.state[C.CMISSION] = C.MOVE; },
    verify(b: CpuCombat) { require(b.units[U.WORDS + U.UCLOAK] === 1, 'Movement contact did not shimmer the obstacle'); },
  })),
  {
    name: 'in-flight missile retains a newly cloaked target', resolveOnly: true,
    units: [unit('STNK', 84), unit('STNK', 92, 1)],
    configure(b) {
      b.units[U.WORDS + U.UCLOAK] = 2; b.units[U.WORDS + U.UCLOAK_EVENT] = 9;
      const p = b.projectiles; p[C.BACTIVE] = 1; p[C.BTYPE] = 7; p[C.BTARGET] = 1; p[C.BSOURCE] = 0;
      p[C.BX] = 5 * 256; p[C.BY] = 4 * 256; p[C.BTO_X] = b.units[U.WORDS + U.UX]; p[C.BTO_Y] = b.units[U.WORDS + U.UY];
      p[C.BFACE] = p[C.BDESIRED] = 64; p[C.BSPEED] = 60; p[C.BTIMER] = 100; p[C.BPROXIMITY] = 4096; p[C.BDAMAGE] = 30;
    },
    verify(b) { require(b.projectiles[C.BACTIVE] === 1 && b.projectiles[C.BTARGET] === 1, 'Cloaking detached an in-flight missile'); },
  },
];
export function makeReviewBattle(scenario: ReviewScenario) {
  const passable = new Uint8Array(20 * 12).fill(scenario.corridor ? 0 : 1);
  if (scenario.corridor) passable.fill(1, 81, 99);
  const battle = new CpuCombat({ grid: gridEdges(20, 12, passable, true), passable, land: new Uint8Array(passable.length), units: scenario.units, seed: 1995, multiplayer: true });
  battle.humanOwner = -1;
  for (let id = 0; id < scenario.units.length; id++) { battle.state[id * C.CWORDS + C.CSCAN] = 1000; battle.state[id * C.CWORDS + C.CARM] = 1000; }
  if (scenario.resolveOnly) battle.movement.frame = 1;
  scenario.configure(battle); battle.movement.occupy();
  return battle;
}
