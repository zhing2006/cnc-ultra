import { expect,it } from 'vitest';
import { gridEdges,UNREACHABLE } from '../../engine/simulation/state.ts';
import { CpuUnits } from './units-cpu.ts';
import { movementType } from '../data/movement.ts';
import * as U from './units-state.ts';
import { FIELD_READY,FIELD_RESET,FIELD_WORDS } from '../../engine/simulation/flow.ts';

function scenario(corridor=false){
  const width=32,height=24,passable=Uint8Array.from({length:width*height},(_,i)=>Number(!corridor||Math.trunc(i/width)===12));
  return {campaignRouting:true,grid:gridEdges(width,height,passable,true),passable,land:new Uint8Array(width*height),seed:1995,houseCount:2,allies:[1,2],
    units:[{type:movementType('MTNK'),cell:12*width+2,owner:1},{type:movementType('MTNK'),cell:12*width+3,owner:1},{type:movementType('GTWR'),cell:(corridor?11:12)*width+16,owner:0}]};
}

it('shares a detour that stays outside enemy threat regions',()=>{
  const battle=new CpuUnits(scenario()),goal=12*32+29;
  battle.routing!.setTeams([[0,1]],[1,1,1]);battle.goals[0]=battle.goals[1]=goal;battle.step();
  const key=battle.routing!.goals[0];expect(key).toBe(battle.routing!.goals[1]);expect(key).toBeGreaterThanOrEqual(768);
  const field=battle.flow.lookup[key];let cell=12*32+2,reached=false,detoured=false;
  for(let i=0;i<768;i++){
    if(cell===goal){reached=true;break;}
    const next=battle.flow.next[field*768+cell];expect(next).toBeGreaterThanOrEqual(0);cell=next%768;
    const x=cell%32,y=Math.trunc(cell/32);if(x>=12&&x<24){expect(y<8||y>=20).toBe(true);detoured=true;}
  }
  expect(reached&&detoured).toBe(true);
});

it('relaxes an unavoidable threat instead of abandoning the mission',()=>{
  const battle=new CpuUnits(scenario(true));battle.routing!.setTeams([[0,1]],[1,1,1]);battle.goals[0]=battle.goals[1]=12*32+29;
  battle.step();
  expect(battle.flow.distance[battle.flow.lookup[battle.routing!.goals[0]]*768+12*32+2]).toBe(UNREACHABLE);
  for(let tick=0;tick<4;tick++)battle.step();
  expect(battle.flow.distance[battle.flow.lookup[battle.routing!.goals[0]]*768+battle.units[U.UCELL]]).toBeLessThan(UNREACHABLE);
  expect(battle.goals[0]).toBe(12*32+29);
});

it('lets a player command immediately leave scripted threat avoidance',()=>{
  const setup=scenario();setup.units[0].owner=setup.units[1].owner=0;setup.units[2].owner=1;
  const battle=new CpuUnits(setup);battle.routing!.setTeams([[0,1]],[1,1,1]);battle.goals[0]=battle.goals[1]=12*32+29;battle.step();
  expect(battle.routing!.goals[0]).toBeGreaterThanOrEqual(768);
  battle.units[U.UFLAGS]|=U.PLAYER_ORDER;battle.step();expect(battle.routing!.goals[0]).toBe(battle.pathGoals[0]);
});

it('retains a cached field when threat changes without crossing its passability threshold',()=>{
  const battle=new CpuUnits(scenario());battle.routing!.setTeams([[0,1]],[1,1,1]);battle.goals[0]=battle.goals[1]=12*32+29;battle.step();
  const field=battle.flow.lookup[battle.routing!.goals[0]],at=field*FIELD_WORDS;
  battle.units[2*U.WORDS+U.UTYPE]=movementType('ATWR');battle.routing!.step(battle.flow);
  expect(battle.flow.fields[at+FIELD_READY]).toBe(1);expect(battle.flow.fields[at+FIELD_RESET]).toBe(0);
  battle.units[2*U.WORDS+U.UHEALTH]=0;battle.routing!.step(battle.flow);
  expect(battle.flow.fields[at+FIELD_READY]).toBe(0);expect(battle.flow.fields[at+FIELD_RESET]).toBe(1);
});

it('ignores visibility changes in the five-cell destination exemption but invalidates newly blocked cells',()=>{
  const battle=new CpuUnits(scenario()),goal=12*32+29;
  battle.routing!.setTeams([[0,1]],[1,1,1]);battle.goals[0]=battle.goals[1]=goal;battle.step();
  const at=battle.flow.lookup[battle.routing!.goals[0]]*FIELD_WORDS;
  const visible=battle.routing!.visible=new Int32Array(768).fill(-2);
  visible[goal]=-1;battle.routing!.step(battle.flow);expect(battle.flow.fields[at+FIELD_READY]).toBe(1);
  visible[32+1]=-1;battle.routing!.step(battle.flow);expect(battle.flow.fields[at+FIELD_RESET]).toBe(1);
});

it('invalidates only houses whose traversable cells changed',()=>{
  const setup=scenario();setup.units[0]={type:movementType('MTNK'),cell:2*32+2,owner:0};setup.units[1].cell=20*32+2;
  const battle=new CpuUnits(setup),goal=12*32+29;
  battle.routing!.setTeams([[0],[1]],[1,1,1]);battle.goals[0]=battle.goals[1]=goal;battle.step();
  const friendly=battle.flow.lookup[battle.routing!.goals[0]]*FIELD_WORDS,enemy=battle.flow.lookup[battle.routing!.goals[1]]*FIELD_WORDS;
  battle.units[2*U.WORDS+U.UHEALTH]=0;battle.routing!.step(battle.flow);
  expect(battle.flow.fields[friendly+FIELD_READY]).toBe(1);
  expect(battle.flow.fields[enemy+FIELD_RESET]).toBe(1);
});
