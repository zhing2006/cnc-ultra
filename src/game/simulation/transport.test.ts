import { expect,it } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { movementType } from '../data/movement.ts';
import { CpuCombat } from './combat-cpu.ts';
import { initialTransport,stepTransport,TBASE,TWORDS,TORDER,SCRIPT_UNLOAD } from './transport-cpu.ts';
import { CpuAircraft } from './aircraft-cpu.ts';
import { CpuAirOperations } from './air-operations-cpu.ts';
import * as U from './units-state.ts';
import { groundLayout,updateGroundKeys } from './ground.ts';
import type { GameScene } from '../scene.ts';

it('flies an evacuation transport off the map without selecting another landing zone',()=>{
  const passable=new Uint8Array(400).fill(1);
  const battle=new CpuCombat({grid:gridEdges(20,20,passable,true),land:new Uint8Array(400),passable,seed:1995,
    bounds:{x:1,y:1,width:18,height:18},houseEdges:[0,0],campaignLevel:12,
    units:[{type:movementType('TRAN'),cell:210},{type:movementType('MOEBIUS'),cell:230}]});
  const aircraft=new CpuAircraft(battle.movement),operations=new CpuAirOperations(battle,aircraft,passable),transport=initialTransport(2),pending=new Int32Array(4).fill(-1);
  pending[2]=5;pending[3]=0;
  for(let tick=0;tick<600;tick++){
    stepTransport(battle,aircraft.state,transport,pending,passable);operations.before();aircraft.step();battle.step();operations.after();
  }
  expect(battle.units[U.UHEALTH]).toBe(0);expect(battle.units[U.WORDS+U.UHEALTH]).toBe(0);
});

it('flies a scripted unload to its waypoint before releasing passengers',()=>{
  const passable=new Uint8Array(400).fill(1),destination=315;
  const battle=new CpuCombat({grid:gridEdges(20,20,passable,true),land:new Uint8Array(400),passable,seed:1995,
    bounds:{x:1,y:1,width:18,height:18},houseEdges:[0,0],campaignLevel:4,
    units:[{type:movementType('TRAN'),cell:105,altitude:24},{type:movementType('E1'),cell:105,attached:1}]});
  const aircraft=new CpuAircraft(battle.movement),operations=new CpuAirOperations(battle,aircraft,passable),transport=initialTransport(2),pending=new Int32Array(4).fill(-1);
  pending[0]=SCRIPT_UNLOAD;pending[1]=destination;
  let dropped=-1;
  for(let tick=0;tick<900;tick++){
    stepTransport(battle,aircraft.state,transport,pending,passable);
    if(!battle.units[U.WORDS+U.UATTACHED]){dropped=battle.units[U.WORDS+U.UCELL];break;}
    operations.before();aircraft.step();battle.step();operations.after();
  }
  expect(dropped).toBe(destination);
});

it('uses infantry sorting after production replaces a reserved vehicle slot',()=>{
  // FOOT.CPP Sort_Y adds 0x30; UNIT.CPP Sort_Y adds 0x80.
  const scene={scenario:{units:[],infantry:[]},objects:[{key:'live:0',first:0,count:1,sortX:128,sortY:256}],
    sprites:[{x:0,y:0,remap:0,region:{x:0,y:0,width:24,height:24}}]} as unknown as GameScene;
  const initial=new Int32Array(U.WORDS);initial[U.UX]=initial[U.UY]=128;initial[U.UTYPE]=movementType('MTNK');
  const layout=groundLayout(scene,initial,U.WORDS),keys=layout.keys.slice();
  initial[U.UTYPE]=movementType('E1');initial[U.UKIND]=1;
  updateGroundKeys(layout,initial,keys);
  expect(keys[1]).toBe(128+48);
});

it('boards five APC passengers through its door and unloads them in cargo order',()=>{
  // UNIT.CPP Receive_Message/Mission_Unload; TECHNO.CPP Max_Passengers; CARGO.CPP Detach_Object.
  const passable=new Uint8Array(144).fill(1),units=[{type:movementType('APC'),cell:65},
    ...Array.from({length:6},(_,i)=>({type:movementType('E1'),cell:i<5?78:90,slot:i%5}))];
  const battle=new CpuCombat({grid:gridEdges(12,12,passable,true),land:new Uint8Array(144),passable,units,seed:1995});
  const state=initialTransport(7),pending=new Int32Array(14).fill(-1),air=new Int32Array();
  for(let id=1;id<7;id++){pending[id*2]=5;pending[id*2+1]=0;}
  const tick=()=>{stepTransport(battle,air,state,pending,passable);battle.movement.step();};
  tick();
  expect(battle.units[U.WORDS+U.UATTACHED]).toBe(0);
  for(let frame=0;frame<450;frame++)tick();
  const cargo=units.map((_,id)=>id).filter(id=>battle.units[id*U.WORDS+U.UATTACHED]===1);
  expect(cargo).toHaveLength(5);
  const expected=cargo.sort((a,b)=>state[TBASE+b*TWORDS+TORDER]-state[TBASE+a*TWORDS+TORDER]);
  // Move the rejected sixth applicant away so all five exit spots are available.
  battle.movement.step([{frame:battle.movement.frame+1,kind:'move',ids:[6],target:130}]);
  for(let frame=0;frame<100;frame++)tick();
  pending[0]=6;
  const dropped:number[]=[];
  for(let frame=0;frame<250;frame++){
    tick();
    for(const id of cargo)if(!battle.units[id*U.WORDS+U.UATTACHED]&&!dropped.includes(id))dropped.push(id);
  }
  expect(dropped).toEqual(expected);
  expect(battle.units[U.UDOOR]).toBe(0);
  expect(new Set(cargo.map(id=>`${battle.units[id*U.WORDS]},${battle.units[id*U.WORDS+1]}`)).size).toBe(5);
});

it.each(['APC','TRAN'])('approaches a busy %s while another passenger is boarding',name=>{
  // INFANTRY.CPP Assign_Destination keeps moving toward a busy transport.
  const passable=new Uint8Array(400).fill(1),units=[{type:movementType(name),cell:105},
    ...Array.from({length:5},(_,id)=>({type:movementType('E1'),cell:285+id}))];
  const battle=new CpuCombat({grid:gridEdges(20,20,passable,true),land:new Uint8Array(400),passable,units,seed:1995});
  const state=initialTransport(6),pending=new Int32Array(12).fill(-1);
  for(let id=1;id<=5;id++){pending[id*2]=5;pending[id*2+1]=0;}
  stepTransport(battle,new Int32Array(120),state,pending,passable);
  expect(Array.from(battle.movement.goals.slice(1)).every(goal=>goal>=0)).toBe(true);
  // A fresh boarding order must also restore the approach after the group was stopped.
  battle.movement.goals.fill(-1);
  for(let id=1;id<=5;id++){pending[id*2]=5;pending[id*2+1]=0;}
  stepTransport(battle,new Int32Array(120),state,pending,passable);
  expect(Array.from(battle.movement.goals.slice(1)).every(goal=>goal>=0)).toBe(true);
});
