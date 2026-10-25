import { expect, it } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { movementType } from '../data/movement.ts';
import { CpuCombat } from './combat-cpu.ts';
import * as C from './combat-state.ts';

it('lets multiplayer AI hunt an undiscovered base without changing exploration',()=>{
  const passable=new Uint8Array(20*16).fill(1),setup={grid:gridEdges(20,16,passable,true),passable,land:new Uint8Array(passable.length),seed:1995,multiplayer:true,
    units:[{cell:22,type:movementType('LTNK')},{cell:245,type:movementType('FACT'),owner:1}]};
  const battle=new CpuCombat(setup);battle.humanOwner=-1;battle.state[C.CMISSION]=C.HUNT;battle.step();
  expect(battle.state[C.CTARGET]).toBe(1);
  expect(battle.sight.mapped[245]).toBe(0);
});

it('does not automatically select an unarmed building for a human-controlled house',()=>{
  const passable=new Uint8Array(20*16).fill(1),setup={grid:gridEdges(20,16,passable,true),passable,land:new Uint8Array(passable.length),seed:1995,multiplayer:true,
    units:[{cell:22,type:movementType('LTNK'),owner:1},{cell:245,type:movementType('FACT')}]};
  const battle=new CpuCombat(setup);battle.humanOwner=1;battle.state[C.CMISSION]=C.HUNT;battle.step();
  expect(battle.state[C.CTARGET]).toBe(-1);
});
