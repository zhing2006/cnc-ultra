import { expect, test } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { CpuCombat } from './combat-cpu.ts';
import { movementType } from '../data/movement.ts';
import * as C from './combat-state.ts';
import * as U from './units-state.ts';
import { BUILDINGS } from '../data/buildings.ts';

test('Ultra hunters advance toward separate nearby fronts and retain completed fields during refresh', () => {
  // Design constitution article 5: nearest-enemy progression, with original local acquisition.
  const width=96,height=96,grid=gridEdges(width,height,new Uint8Array(width*height).fill(1),true);
  const rows=[12,48,84];
  const battle=new CpuCombat({grid,land:new Uint8Array(width*height),seed:1995,multiplayer:true,ultraHunt:true,
    units:[...rows.map(y=>({cell:y*width+12,type:movementType('MTNK'),facing:64})),
      ...rows.map(y=>({cell:y*width+76,type:movementType('MTNK'),owner:1,facing:192}))],
    missions:[C.HUNT,C.HUNT,C.HUNT,C.SLEEP,C.SLEEP,C.SLEEP]});
  let previous=-1,refreshed=false;
  for(let tick=0;tick<65;tick++){
    battle.step();
    const status=battle.ultraHunt!.flow.status;
    if(status[1]>=0&&previous>=0)expect(status[0]).toBe(previous);
    if(status[3]>=2)refreshed=true;
    previous=status[0];
  }
  expect(refreshed).toBe(true);
  for(let id=0;id<3;id++){
    expect(battle.units[id*U.WORDS]).toBeGreaterThan(13*256);
    expect(Math.abs(battle.units[id*U.WORDS+1]-(rows[id]*256+128))).toBeLessThan(128);
    expect(battle.state[id*C.CWORDS+C.CTARGET]).toBe(-1);
  }
});

test('original Hunt settles distant equal scores by aircraft and ground Sort_Y rather than slot order', () => {
  // TECHNO.CPP Greatest_Threat full-map loops; UNIT.CPP Sort_Y.
  const width=64,height=64,grid=gridEdges(width,height,new Uint8Array(width*height).fill(1),true);
  const setup={grid,land:new Uint8Array(width*height),seed:1995,multiplayer:true,
    units:[{cell:32*width+8,type:movementType('MTNK')},
      {cell:50*width+50,type:movementType('MTNK'),owner:1},
      {cell:10*width+50,type:movementType('MTNK'),owner:1},
      {cell:10*width+40,type:movementType('MTNK'),owner:1}],missions:[C.HUNT,C.SLEEP,C.SLEEP,C.SLEEP]};
  const battle=new CpuCombat(setup);battle.step();expect(battle.state[C.CTARGET]).toBe(3);
  const air=new CpuCombat({...setup,units:[{...setup.units[0],type:movementType('MSAM')},...setup.units.slice(1),
    {cell:60*width+60,type:movementType('ORCA'),owner:1,altitude:24}]});
  air.step();expect(air.state[C.CTARGET]).toBe(4);
});

test('Ultra Hunt acquires from its own area and retains its legal target across scans',()=>{
  // TECHNO.CPP Threat_Range(1), Target_Something_Nearby; FOOT.CPP Mission_Hunt.
  const width=48,height=48,battle=new CpuCombat({grid:gridEdges(width,height,new Uint8Array(width*height).fill(1),true),
    land:new Uint8Array(width*height),seed:1995,multiplayer:true,ultraHunt:true,
    units:[{cell:24*width+12,type:movementType('MTNK'),facing:64},
      {cell:24*width+19,type:movementType('MTNK'),owner:1},
      {cell:40*width+40,type:movementType('MTNK'),owner:1}],missions:[C.HUNT,C.SLEEP,C.SLEEP]});
  battle.step();expect(battle.state[C.CTARGET]).toBe(1);expect(battle.state[C.CSCAN]).toBe(20);
  battle.units[2*U.WORDS]=battle.units[U.UX]+256;battle.units[2*U.WORDS+1]=battle.units[U.UY];
  for(let n=0;n<20;n++)battle.step();
  expect(battle.state[C.CTARGET]).toBe(1);
});

test.each([0,1])('Ultra owner %i keeps the original unarmed-building eligibility in its distance field',owner=>{
  // TECHNO.CPP Evaluate_Object excludes unarmed buildings for human-owned hunters.
  const width=48,height=48,cells=width*height,passable=new Uint8Array(cells).fill(1),origin=24*width+30;
  for(const [x,y] of BUILDINGS.get('NUKE')!.occupy)passable[origin+y*width+x]=0;
  const battle=new CpuCombat({grid:gridEdges(width,height,passable,true),passable,land:new Uint8Array(cells),seed:1995,multiplayer:true,ultraHunt:true,
    units:[{cell:24*width+8,type:movementType('MTNK'),owner,facing:64},{cell:origin,type:movementType('NUKE'),owner:1-owner}],missions:[C.HUNT,C.SLEEP]});
  battle.step();
  expect(battle.movement.goals[0]>=0).toBe(owner===1);
});
