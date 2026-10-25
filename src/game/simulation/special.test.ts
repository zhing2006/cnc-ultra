import { expect, it } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { movementType } from '../data/movement.ts';
import { CpuCombat } from './combat-cpu.ts';
import * as C from './combat-state.ts';
import * as U from './units-state.ts';

it('does not turn a forced attack on an allied building into an engineer capture',()=>{
  const passable=new Uint8Array(12*8).fill(1);
  const battle=new CpuCombat({grid:gridEdges(12,8,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,
    units:[{cell:26,type:movementType('E6')},{cell:39,type:movementType('NUKE')}]});
  battle.step([{frame:1,kind:'attack',ids:[0],target:1}]);for(let tick=2;tick<100;tick++)battle.step();
  expect(battle.units[U.UHEALTH]).toBe(25);
});

it('consumes both engineers entering the same building without repeating capture',()=>{
  const passable=new Uint8Array(20*12).fill(1);
  const battle=new CpuCombat({grid:gridEdges(20,12,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,
    units:[{cell:84,type:movementType('E6')},{cell:82,type:movementType('E6')},{cell:105,type:movementType('NUKE'),owner:1}]});
  battle.step([{frame:1,kind:'capture',target:2,ids:[0,1]}]);
  let captured=0;
  for(let tick=2;tick<=400;tick++){
    battle.step();const frame=battle.units[2*U.WORDS+U.UCAPTURE_TICK];
    if(frame&&!captured)captured=frame;
    if(captured)expect(frame).toBe(captured);
  }
  expect(captured).toBeGreaterThan(0);
  expect([battle.units[U.UHEALTH],battle.units[U.WORDS+U.UHEALTH]]).toEqual([0,0]);
});

it('consumes an engineer on capture and detonates planted C4 twenty ticks after entry', () => {
  const passable=new Uint8Array(20*12).fill(1);
  const battle=new CpuCombat({grid:gridEdges(20,12,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,
    units:[{cell:84,type:movementType('E6')},{cell:105,type:movementType('NUKE'),owner:1},
      {cell:94,type:movementType('RMBO')},{cell:115,type:movementType('SILO'),owner:1}]});
  for(let id=0;id<4;id++)battle.state[id*C.CWORDS+C.CMISSION]=C.MOVE;
  battle.step([{frame:1,kind:'attack',target:1,ids:[0]},{frame:1,kind:'attack',target:3,ids:[2]}]);
  let planted=-1;
  for(let tick=2;tick<500;tick++){
    battle.step();
    const deadline=battle.units[3*U.WORDS+U.UBOMB_TICK];
    if(deadline&&planted<0){planted=tick;expect(deadline).toBe(tick+20);}
    if(planted>=0&&tick<planted+20)expect(battle.units[3*U.WORDS+U.UHEALTH]).toBe(300); // BDATA.CPP doubles the declared strength.
    if(planted>=0&&tick===planted+20)expect(battle.units[3*U.WORDS+U.UHEALTH]).toBe(0);
  }
  expect(battle.units[U.WORDS+U.UOWNER]).toBe(0);
  expect(battle.units[U.UHEALTH]).toBe(0);
  expect(battle.state[C.CDEATH]).toBe(-1);
  expect(planted).toBeGreaterThan(0);
});
