import { expect, it } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { movementType } from '../data/movement.ts';
import { CpuCombat } from './combat-cpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
function battle(){const passable=new Uint8Array(20*12).fill(1);return new CpuCombat({grid:gridEdges(20,12,passable,true),passable,land:new Uint8Array(passable.length),seed:1995,units:[{cell:88,type:movementType('STNK'),facing:64}]});}

it('finishes the 38-stage cloak, shimmers on damage, and cloaks again',()=>{
  const b=battle();b.step();expect(b.units[U.UCLOAK]).toBe(1);expect(b.units[U.UCLOAK_STAGE]).toBe(0);
  for(let tick=2;tick<=39;tick++)b.step();expect(b.units[U.UCLOAK]).toBe(2);
  b.queueExplosions([{frame:40,x:b.units[U.UX],y:b.units[U.UY],damage:10,warhead:0,source:-1}]);b.step();
  expect(b.units[U.UCLOAK]).toBe(1);expect(b.units[U.UCLOAK_STAGE]).toBe(19);
  for(let tick=41;tick<=59;tick++)b.step();expect(b.units[U.UCLOAK]).toBe(2);
});

it('cannot fire until the original uncloak animation has completed',()=>{
  const b=battle();for(let tick=1;tick<45;tick++)b.step();
  b.step([{frame:45,kind:'attack-ground',target:89,ids:[0]}]);b.step();
  expect(b.units[U.UCLOAK]).toBe(3);expect(b.units[U.UCLOAK_STAGE]).toBe(0);
  for(let tick=47;tick<84;tick++){b.step();expect(b.projectiles.some((value,i)=>i%C.BWORDS===C.BACTIVE&&value!==0)).toBe(false);}
  b.step();expect(b.units[U.UCLOAK]).toBe(0);expect(b.projectiles[C.BBORN]).toBe(84);
});
