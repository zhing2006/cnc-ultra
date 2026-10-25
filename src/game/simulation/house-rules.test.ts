import { expect, it } from 'vitest';
import { EconomyRuntime } from './economy-runtime.ts';
import { HouseState } from './house-state.ts';
import { SuperWeapons, SUPER_RECHARGE } from './super-weapons.ts';

function houseRules() {
  const runtime=Object.assign(Object.create(EconomyRuntime.prototype),{
    actingOwner:0,controlledOwner:null,frame:1,
    houses:[new HouseState(0,1,10000),new HouseState(1,2,10000)],
    buildings:new Map([[0,{id:0,type:'EYE',cell:22,owner:0,health:500,active:true,selling:false}],
      [1,{id:1,type:'TMPL',cell:155,owner:1,health:1000,active:true,selling:false}]]),
    supers:new SuperWeapons(20,12,{x:0,y:0,width:20,height:12},new Map()),battle:{queueExplosions(){}},
  }) as EconomyRuntime;
  for(const house of runtime.houses)house.economy.power=100;
  const step=()=> (runtime as unknown as {advanceSupers():void}).advanceSupers();
  return {runtime,step};
}

it('does not grant the temple nuclear device to a computer house',()=>{
  const {runtime,step}=houseRules();step();
  expect(runtime.supers.charges[1].nuke.present).toBe(false);
  expect(runtime.supers.charges[0].ion.present).toBe(true);
});

it('retains an acquired nuclear device on handover and lets the AI fire it',()=>{
  const {runtime,step}=houseRules();runtime.controlledOwner=1;step();
  const charge=runtime.supers.charges[1].nuke;
  expect(charge.present).toBe(true);
  runtime.controlledOwner=null;runtime.frame=2;step();
  expect(charge.present).toBe(true);
  expect(charge.remaining(2)).toBe(SUPER_RECHARGE.nuke-1);
  runtime.frame=SUPER_RECHARGE.nuke+1;step();
  expect(charge.ready).toBe(false);
  expect(runtime.supers.doorFrame(1,runtime.frame)).toBe(0);
});
