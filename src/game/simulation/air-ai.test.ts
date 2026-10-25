import { expect,it } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { movementType } from '../data/movement.ts';
import { CpuCombat } from './combat-cpu.ts';
import { CpuAirOperations,airFireLocation } from './air-operations-cpu.ts';
import { CpuAircraft,AMISSION,ACONTACT,AGENERATION } from './aircraft-cpu.ts';
import * as C from './combat-state.ts';
import * as U from './units-state.ts';
function ready(){
  const passable=new Uint8Array(20*16).fill(1),setup={grid:gridEdges(20,16,passable,true),passable,land:new Uint8Array(passable.length),seed:1995,multiplayer:true,
    units:[{cell:42,type:movementType('ORCA')},{cell:41,type:movementType('HPAD')},{cell:81,type:movementType('FIX')},{cell:245,type:movementType('NUKE'),owner:1}]};
  const battle=new CpuCombat(setup),aircraft=new CpuAircraft(battle.movement),operations=new CpuAirOperations(battle,aircraft,new Int32Array(passable.length).fill(1));
  battle.humanOwner=-1;
  aircraft.state[AGENERATION]=battle.units[U.UGENERATION];aircraft.state[AMISSION]=3;aircraft.state[ACONTACT]=1;
  return {battle,aircraft,operations};
}
it('converts a rotary-wing hunt order with a target into an attack sortie',()=>{
  const {battle,aircraft,operations}=ready();battle.state[C.CMISSION]=C.HUNT;battle.state[C.CTARGET]=3;operations.before();
  expect(battle.state[C.CMISSION]).toBe(C.ATTACK);expect(aircraft.state[AMISSION]).toBe(1);
});
it('sends a damaged computer aircraft to an available repair facility',()=>{
  const {battle,aircraft,operations}=ready();battle.units[U.UHEALTH]=60;operations.before([1000,1000]);
  expect(aircraft.state[ACONTACT]).toBe(2);
});
it('limits campaign firing locations to explored cells',()=>{
  const {battle}=ready(),playable=new Int32Array(320).fill(1);
  battle.setup.multiplayer=false;battle.sight.shadow.fill(-2);
  expect(airFireLocation(battle,0,3,playable)).toBe(-1);
  battle.sight.shadow.fill(-1);
  expect(airFireLocation(battle,0,3,playable)).toBeGreaterThanOrEqual(0);
});
