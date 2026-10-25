import { describe, expect, it } from 'vitest';
import { PRODUCTION } from '../data/production.ts';
import { HouseEconomy, FactoryProduction, ProductionQueues, repairStep, type FactoryBuilding } from './economy.ts';
import { CpuTiberium, harvestBail, type TiberiumSetup } from './tiberium-cpu.ts';
import { buildingPower, canPlaceBuilding, deployYard, saleRefund, type PlacementGrid } from './building-rules.ts';
import { CpuCombat } from './combat-cpu.ts';
import { gridEdges } from '../../engine/simulation/state.ts';
import { movementType } from '../data/movement.ts';
import { initialAircraft,AIR_WORDS,ACONTACT } from './aircraft-cpu.ts';
import { initialTransport,stepTransport } from './transport-cpu.ts';
import * as U from './units-state.ts';
import { initialHarvest,stepHarvest,HBASE,HWORDS,HGEN,HMODE,HLOAD,HREF,HGOAL,HTIMER } from './harvest-cpu.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { applyLifecycle } from './lifecycle-cpu.ts';
import { CREATE,CHANGE_WORDS,INITIAL_ORDER } from './lifecycle-state.ts';
import { initialServices,stepServices,FACTORY_POINT } from './services-cpu.ts';
import { BUILDING_WORDS } from './economy-runtime.ts';
import * as C from './combat-state.ts';

it('creates a crew with separate scatter, mission and retaliation targets',()=>{
  const setup={grid:gridEdges(12,6,new Uint8Array(72).fill(1),true),land:new Uint8Array(72),seed:1995,
    units:[{cell:15,type:movementType('E1'),health:0},{cell:20,type:movementType('MTNK'),owner:1}]};
  const battle=new CpuCombat(setup),commands=new Int32Array(2*CHANGE_WORDS);
  commands.set([CREATE|INITIAL_ORDER,movementType('E1'),0,15,50,64,0,-1,C.ATTACK,-1,0,0,0,16,1]);
  applyLifecycle(battle,commands);
  expect(battle.movement.goals[0]).toBe(16);
  expect(battle.state[C.CMISSION]).toBe(C.ATTACK);
  expect(battle.state[C.CTARGET]).toBe(1);
});

it.each(['PYLE','HAND'])('places six %s recruits in distinct original infantry spots',name=>{
  // BUILDING.CPP Find_Exit_Cell; INFANTRY.CPP Start_Driver; CELL.CPP Closest_Free_Spot.
  const width=16,origin=68,passable=new Uint8Array(width*16).fill(1);
  for(const [x,y] of BUILDINGS.get(name)!.occupy)passable[origin+y*width+x]=0;
  const battle=new CpuCombat({grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,units:[
    {type:movementType(name),cell:origin},...Array.from({length:6},()=>({type:movementType('E1'),cell:0,health:0}))]});
  const services=initialServices(7),[x,y]=FACTORY_POINT[name],cell=origin+Math.trunc(y/256)*width+Math.trunc(x/256);
  for(let id=1;id<=6;id++){
    const commands=new Int32Array(7*CHANGE_WORDS);commands.set([CREATE,movementType('E1'),0,cell,50,160,0,-1,0,0,0,0,-1],id*CHANGE_WORDS);applyLifecycle(battle,commands);
    for(let frame=0;frame<150;frame++){
      stepServices(battle,services,new Int32Array(2));battle.movement.step();
      if(battle.units[id*U.WORDS+U.UENTER]===0&&battle.units[id*U.WORDS+U.UDEST]<0&&battle.movement.goals[id]<0)break;
    }
  }
  const positions=Array.from({length:6},(_,i)=>`${battle.units[(i+1)*U.WORDS]},${battle.units[(i+1)*U.WORDS+1]}`);
  expect(new Set(positions).size).toBe(6);
  const cells=Array.from({length:6},(_,i)=>battle.units[(i+1)*U.WORDS+U.UCELL]);
  expect(cells.slice(0,5).every(cell=>cell===cells[0])).toBe(true);
  expect(cells[5]).not.toBe(cells[0]);
  for(let id=1;id<=6;id++)expect([[128,128],[64,64],[192,64],[64,192],[192,192]]).toContainEqual([battle.units[id*U.WORDS]&255,battle.units[id*U.WORDS+1]&255]);
});

it('moves a produced tank away from the war-factory exit',()=>{
  // BUILDING.CPP RADIO_UNLOADED returns RADIO_RUN_AWAY; UNIT.CPP Per_Cell_Process forces Scatter.
  const width=16,origin=68,passable=new Uint8Array(width*16).fill(1);
  for(const [x,y] of BUILDINGS.get('WEAP')!.occupy)passable[origin+y*width+x]=0;
  const battle=new CpuCombat({grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,units:[
    {type:movementType('WEAP'),cell:origin},{type:movementType('MTNK'),cell:origin+width,enter:-1}]});
  const services=initialServices(2);
  for(let tick=0;tick<250;tick++){
    stepServices(battle,services,new Int32Array(2));
    if(battle.units[U.WORDS+U.UENTER]===0)break;
    battle.movement.step();
  }
  expect(battle.units[U.WORDS+U.UENTER]).toBe(0);
  expect(battle.movement.goals[1]).toBeGreaterThanOrEqual(0);
  expect(battle.movement.goals[1]).not.toBe(battle.units[U.WORDS+U.UCELL]);
});

it.each(['occupied','reserved for a returning aircraft'])('delivers a new aircraft from the map edge when its helipad is %s',mode=>{
  // BUILDING.CPP Exit_Object checks radio contact and uses DIR_N for edge reinforcements.
  const width=16,origin=68,passable=new Uint8Array(width*16).fill(1);
  for(const [x,y] of BUILDINGS.get('HPAD')!.occupy)passable[origin+y*width+x]=0;
  const setup={grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,units:[
    {type:movementType('HPAD'),cell:origin},{type:movementType('ORCA'),cell:mode==='occupied'?origin+1:150,altitude:mode==='occupied'?0:24},{type:movementType('ORCA'),cell:0,health:0}]};
  const battle=new CpuCombat(setup),air=initialAircraft(setup),commands=new Int32Array(3*CHANGE_WORDS);
  air[AIR_WORDS+ACONTACT]=0;
  commands.set([CREATE,movementType('ORCA'),0,origin+1,125,32,0,-1,0,0,0,0,1],2*CHANGE_WORDS);
  applyLifecycle(battle,commands,passable,air);
  expect(battle.units[2*U.WORDS+U.UALTITUDE]).toBe(24);
  expect(battle.units[2*U.WORDS+U.UFACE]).toBe(0);
});

it('moves a full harvester near a busy refinery and retries contact after fifteen ticks',()=>{
  // UNIT.CPP Mission_Harvest FINDHOME retries Find_Docking_Bay under ScenarioInit,
  // then uses TECHNO.CPP Nearby_Location instead of waiting in the ore field.
  const width=16,height=12,cells=width*height,passable=new Uint8Array(cells).fill(1);
  const battle=new CpuCombat({grid:gridEdges(width,height,passable,true),land:new Uint8Array(cells),passable,seed:1995,units:[
    {type:movementType('PROC'),cell:36},{type:movementType('HARV'),cell:52,attached:1},{type:movementType('HARV'),cell:150}]});
  const state=initialHarvest(3),buildings=new Int32Array(3*BUILDING_WORDS);buildings[3]=1;
  for(const [id,mode] of [[1,5],[2,2]]){state[HBASE+id*HWORDS+HGEN]=1;state[HBASE+id*HWORDS+HMODE]=mode;state[HBASE+id*HWORDS+HLOAD]=28;state[HBASE+id*HWORDS+HREF]=id===1?0:-1;}
  const context={battle,ore:new Int32Array(cells).fill(-1),state,buildings,playable:new Int32Array(cells).fill(1),passable};
  stepHarvest(context);
  const goal=battle.movement.goals[2];
  expect(goal).toBeGreaterThanOrEqual(0);
  expect(Math.abs(goal%width-36%width)).toBeLessThanOrEqual(3);
  expect(Math.abs(Math.trunc(goal/width)-Math.trunc(36/width))).toBeLessThanOrEqual(3);
  expect(state[HBASE+2*HWORDS+HMODE]).toBe(2);
  expect(state[HBASE+2*HWORDS+HTIMER]).toBe(15);
});

it('reissues an interrupted refinery approach and resumes harvesting after unloading',()=>{
  const width=16,cells=width*12,passable=new Uint8Array(cells).fill(1);
  const battle=new CpuCombat({grid:gridEdges(width,12,passable,true),land:new Uint8Array(cells),passable,seed:1995,
    units:[{type:movementType('PROC'),cell:36,owner:1},{type:movementType('HARV'),cell:70,owner:1,facing:192}]});
  const state=initialHarvest(2),p=HBASE+HWORDS,buildings=new Int32Array(2*BUILDING_WORDS),ore=new Int32Array(cells).fill(-1);
  buildings[3]=1;ore[124]=36;
  state[p+HGEN]=1;state[p+HMODE]=3;state[p+HREF]=0;state[p+HGOAL]=68;state[p+HLOAD]=28;
  const context={battle,ore,state,buildings,playable:new Int32Array(cells).fill(1),passable};
  // BUILDING.CPP Receive_Message(RADIO_DOCKING) repeats MOVE_HERE when NavCom has been cleared.
  stepHarvest(context);
  expect(battle.movement.goals[1]).toBe(68);
  expect(state[p+HREF]).toBe(0);
  for(let tick=0;tick<1400;tick++){battle.movement.step();stepHarvest(context);}
  expect(state[1]).toBeGreaterThanOrEqual(700);
  expect(ore[124]).toBeLessThan(36);
});

it('preserves refinery contact when a loaded harvester automatically gives way',()=>{
  const width=16,cells=width*12,passable=new Uint8Array(cells).fill(1);
  const battle=new CpuCombat({grid:gridEdges(width,12,passable,true),land:new Uint8Array(cells),passable,seed:1995,
    units:[{type:movementType('PROC'),cell:36},{type:movementType('HARV'),cell:70,facing:192}]});
  const state=initialHarvest(2),p=HBASE+HWORDS,buildings=new Int32Array(2*BUILDING_WORDS);
  buildings[3]=1;state[p+HGEN]=1;state[p+HMODE]=3;state[p+HREF]=0;state[p+HGOAL]=68;state[p+HLOAD]=28;
  const context={battle,ore:new Int32Array(cells).fill(-1),state,buildings,playable:new Int32Array(cells).fill(1),passable};
  // UNIT.CPP Scatter only assigns NavCom, not a new mission or radio contact.
  battle.movement.scatter(1);stepHarvest(context);
  expect(state[p+HMODE]).toBe(3);expect(state[p+HREF]).toBe(0);
  for(let tick=0;tick<1000;tick++){battle.movement.step();stepHarvest(context);}
  expect(state[0]).toBe(700);
});

it('replaces a harvesting mission when the player explicitly orders the same cell as a scatter',()=>{
  const width=16,cells=width*12,passable=new Uint8Array(cells).fill(1);
  const battle=new CpuCombat({grid:gridEdges(width,12,passable,true),land:new Uint8Array(cells),passable,seed:1995,
    units:[{type:movementType('PROC'),cell:36},{type:movementType('HARV'),cell:70,facing:192}]});
  const state=initialHarvest(2),p=HBASE+HWORDS,buildings=new Int32Array(2*BUILDING_WORDS);
  buildings[3]=1;state[p+HGEN]=1;state[p+HMODE]=3;state[p+HREF]=0;state[p+HGOAL]=68;state[p+HLOAD]=28;
  const destination=battle.movement.scatter(1);
  battle.step([{frame:1,kind:'move',target:destination,ids:[1]}]);
  stepHarvest({battle,ore:new Int32Array(cells).fill(-1),state,buildings,playable:new Int32Array(cells).fill(1),passable});
  expect(state[p+HMODE]).toBe(0);expect(state[p+HREF]).toBe(-1);
});

it('clears a refinery apron while unloading so its harvester can leave and mine again',()=>{
  const width=16,cells=width*12,passable=new Uint8Array(cells).fill(1);
  const battle=new CpuCombat({grid:gridEdges(width,12,passable,true),land:new Uint8Array(cells),passable,seed:1995,multiplayer:true,
    units:[{type:movementType('PROC'),cell:36},{type:movementType('HARV'),cell:52,attached:1},{type:movementType('E1'),cell:68}]});
  battle.humanOwner=-1;battle.state[2*C.CWORDS+C.CMISSION]=C.GUARD_AREA;battle.state[2*C.CWORDS+C.CGUARD_CELL]=69;
  const state=initialHarvest(3),p=HBASE+HWORDS,buildings=new Int32Array(3*BUILDING_WORDS),ore=new Int32Array(cells).fill(-1);
  buildings[3]=1;ore[124]=36;state[p+HGEN]=1;state[p+HMODE]=5;state[p+HREF]=0;state[p+HLOAD]=10;
  const context={battle,ore,state,buildings,playable:new Int32Array(cells).fill(1),passable};
  // BUILDING.CPP Mission_Harvest(MIDDLE) forces bib occupants to scatter before each bail.
  stepHarvest(context);
  expect(battle.movement.goals[2]).toBeGreaterThanOrEqual(0);
  expect(battle.movement.goals[2]).not.toBe(68);
  for(let tick=0;tick<1200;tick++){battle.step();stepHarvest(context);}
  expect(state[0]).toBeGreaterThanOrEqual(250);
  expect(ore[124]).toBeLessThan(36);
});

it.each([
  ['E1',150,0,false],['E1',-1,27,false],['C1',150,0,true],['MTNK',150,0,true],
] as const)('apron clearance respects %s navigation %i and action %i',(name,goal,action,redirect)=>{
  const width=16,cells=width*12,passable=new Uint8Array(cells).fill(1);
  const battle=new CpuCombat({grid:gridEdges(width,12,passable,true),land:new Uint8Array(cells),passable,seed:1995,
    units:[{type:movementType('PROC'),cell:36},{type:movementType('HARV'),cell:52,attached:1},{type:movementType(name),cell:68}]});
  battle.movement.goals[2]=goal;battle.state[2*C.CWORDS+C.CACTION]=action;
  const state=initialHarvest(3),p=HBASE+HWORDS,buildings=new Int32Array(3*BUILDING_WORDS);buildings[3]=1;
  state[p+HGEN]=1;state[p+HMODE]=5;state[p+HREF]=0;state[p+HLOAD]=10;
  stepHarvest({battle,ore:new Int32Array(cells).fill(-1),state,buildings,playable:new Int32Array(cells).fill(1),passable});
  expect(battle.movement.goals[2]!==goal).toBe(redirect);
});

it('walks infantry into a Chinook one passenger at a time before attaching cargo',()=>{
  // AIRCRAFT.CPP Receive_Message and INFANTRY.CPP Per_Cell_Process.
  const playable=new Uint8Array(144).fill(1),setup={grid:gridEdges(12,12,playable,true),land:new Uint8Array(144),passable:playable,seed:0x1995,
    units:[{cell:65,type:movementType('TRAN')},{cell:77,type:movementType('E1'),enter:1},{cell:77,type:movementType('E1'),slot:1,enter:1}]};
  const battle=new CpuCombat(setup),air=initialAircraft(setup),transport=initialTransport(3),pending=new Int32Array(6).fill(-1);
  battle.units[U.UDOOR]=4;
  stepTransport(battle,air,transport,pending,playable);
  expect(battle.units[U.WORDS+U.UATTACHED]).toBe(0);
  expect(battle.units[U.WORDS+U.UDEST]).toBe(65);
  expect(battle.units[2*U.WORDS+U.UDEST]).toBe(-1);
  for(let i=0;i<100;i++){battle.movement.step();stepTransport(battle,air,transport,pending,playable);}
  expect([battle.units[U.WORDS+U.UATTACHED],battle.units[2*U.WORDS+U.UATTACHED]]).toEqual([1,1]);
});

function house() { const result = new HouseEconomy(10000); result.power = 100; result.drain = 40; return result; }
describe('Original construction and credits', () => {
  // TECHNO.CPP Time_To_Build, BDATA.CPP Raw_Cost, FACTORY.CPP Start and STAGE.H.
  it.each([['NUKE',216,300],['PROC',540,2000],['HPAD',216,1500],['LTNK',432,600],['MTNK',756,800],['ORCA',1188,1200]] as const)(
    'finishes %s after %i ticks and charges %i credits', (name,ticks,cost) => {
      const owner = house(), factory = new FactoryProduction(PRODUCTION.get(name)!, owner);
      expect(factory.start()).toBe(true);
      for(let i=1;i<ticks;i++) factory.step(1);
      expect(factory.complete).toBe(false);
      factory.step(1);
      expect(factory.complete).toBe(true);
      expect(owner.money).toBe(10000-cost);
    });
  it('accelerates the same production clock with multiple factories', () => {
    const owner=house(), factory=new FactoryProduction(PRODUCTION.get('MTNK')!,owner);
    factory.start();
    for(let i=0;i<251;i++) factory.step(3);
    expect(factory.complete).toBe(false);
    factory.step(3);
    expect(factory.complete).toBe(true);
    expect(owner.money).toBe(9200);
  });
  it('uses the low-power fraction when starting and resuming construction', () => {
    const owner=house();owner.power=20;owner.drain=40;
    const factory=new FactoryProduction(PRODUCTION.get('NUKE')!,owner);
    factory.start();
    expect(factory.rate).toBe(5);
    for(let i=0;i<5;i++) factory.step(1);
    expect(factory.stage).toBe(1);
    factory.suspend();owner.power=100;factory.start();
    expect(factory.rate).toBe(2);
    for(let i=0;i<214;i++) factory.step(1);
    expect(factory.complete).toBe(true);
    expect(owner.money).toBe(9700);
  });
  it('rolls back an unaffordable production stage and refunds only money spent', () => {
    const owner=house();owner.credits=5;
    const factory=new FactoryProduction(PRODUCTION.get('NUKE')!,owner);
    factory.start();
    for(let i=0;i<1000;i++) factory.step(1);
    expect(factory.stage).toBe(2);
    expect(owner.money).toBe(1);
    factory.abandon();
    expect(owner.money).toBe(5);
  });
  it('stores harvest income in silos, spends it first and preserves initial cash', () => {
    const owner=new HouseEconomy(100000);
    owner.adjustCapacity(1000,false);
    owner.harvest(700);owner.harvest(700);
    expect(owner.money).toBe(101000);
    expect(owner.harvested).toBe(1400);
    owner.spend(600);
    expect([owner.credits,owner.tiberium]).toEqual([100000,400]);
    owner.adjustCapacity(-1000,false);
    expect([owner.credits,owner.tiberium]).toEqual([100400,0]);
    owner.adjustCapacity(1000,false);owner.harvest(700);
    expect(owner.adjustCapacity(-1000,true)).toBe(700);
    expect(owner.money).toBe(100400);
  });
  it('keeps production categories independent and uses captured factory nationality', () => {
    const buildings:FactoryBuilding[]=['FACT','NUKE','PROC','HAND','WEAP','AFLD'].map(type=>({type,faction:type==='AFLD'||type==='HAND'?2:1,active:true}));
    const owner=house(), queues=new ProductionQueues(owner,buildings);
    expect(queues.begin('E4')).toBe(true);
    expect(queues.begin('LTNK')).toBe(true);
    expect(queues.begin('NUKE')).toBe(true);
    expect(queues.begin('MTNK')).toBe(false);
    for(let i=0;i<216;i++) queues.step();
    expect(queues.items.get('vehicle')?.complete).toBe(true);
    expect(queues.items.get('building')?.complete).toBe(true);
    expect(queues.items.get('infantry')?.complete).toBe(true);
  });
  it('repairs buildings using their effective strength and excludes bundled units', () => {
    // BDATA.CPP doubles constructor strength, then Repair_Cost halves the raw per-step cost.
    const refinery=PRODUCTION.get('PROC')!, step=repairStep(refinery), owner=house();
    let health=450;
    while(health<refinery.strength){owner.spend(step.cost);health=Math.min(refinery.strength,health+step.health);}
    expect(health).toBe(900);
    expect(owner.money).toBe(9910);
  });
});

describe('Original building placement and power',()=>{
  function grid():PlacementGrid{
    return {width:12,height:12,playable:new Int32Array(144).fill(1),buildable:new Int32Array(144).fill(1),
      occupied:new Int32Array(144).fill(-1),owners:new Int32Array(144),bibs:new Int32Array(144)};
  }
  it('requires proximity and space for the full bib, beyond the occupied foundation',()=>{
    const map=grid();(map.owners as Int32Array)[25]=1;
    expect(canPlaceBuilding(map,'NUKE',26,0)).toBe(true);
    (map.occupied as Int32Array)[51]=3;
    expect(canPlaceBuilding(map,'NUKE',26,0)).toBe(false);
    (map.occupied as Int32Array)[51]=-1;(map.owners as Int32Array)[25]=0;
    expect(canPlaceBuilding(map,'NUKE',26,0)).toBe(false);
  });
  it('deploys northwest of the MCV, excluding the MCV itself and preserving health ratio',()=>{
    const map=grid();(map.occupied as Int32Array)[65]=4;
    expect(deployYard(map,65,300,4,0)).toEqual({cell:52,health:400,facing:160});
    (map.occupied as Int32Array)[53]=8;
    expect(deployYard(map,65,300,4,0)).toBeUndefined();
  });
  it('reduces generated power with damage and refunds half the building-only cost',()=>{
    expect(buildingPower(PRODUCTION.get('NUKE')!,200)).toBe(50);
    expect(buildingPower(PRODUCTION.get('NUK2')!,300)).toBe(100);
    expect(saleRefund(PRODUCTION.get('PROC')!)).toBe(300);
    expect(saleRefund(PRODUCTION.get('HPAD')!)).toBe(150);
  });
});

export function tiberiumFixture(width=8,height=8):TiberiumSetup {
  const cells=width*height;
  return {width,height,seed:0x1995,amount:new Int32Array(cells).fill(-1),variants:new Int32Array(cells),
    clear:new Int32Array(cells).fill(1),blossom:new Int32Array(cells),playable:new Int32Array(cells).fill(1)};
}
describe('Original Tiberium growth and harvesting', () => {
  it('takes partial six-stage bails and caps a full load at 28 stages, worth 700 credits', () => {
    let load=0;
    const amounts:number[]=[];
    while(load<28){const result=harvestBail(11,load);load=result.load;amounts.push(result.amount);}
    expect(amounts).toEqual([5,5,5,5,7]);
    const owner=house();owner.adjustCapacity(1000,false);
    owner.harvest(load*25);
    expect(owner.money).toBe(10700);
    expect(harvestBail(3,0)).toEqual({amount:-1,load:3,taken:3});
  });
  it('revisits the boundary cell and grows twice after a complete multiplayer scan', () => {
    const setup=tiberiumFixture();setup.amount[7]=1;setup.clear.fill(0);
    const world=new CpuTiberium(setup);
    world.step();expect(world.state[1]).toBe(29);
    world.step();expect(world.state[1]).toBe(58);expect(world.amount[7]).toBe(1);
    world.step();expect(world.state[1]).toBe(0);expect(world.state[2]).toBe(0);expect(world.amount[7]).toBe(3);
  });
  it('gives blossom trees three candidate entries and spreads only into free clear cells', () => {
    const setup=tiberiumFixture(5,5);setup.blossom[12]=1;setup.clear.fill(0);setup.clear[13]=1;
    const world=new CpuTiberium(setup), occupied=new Int32Array(25*5);occupied[13*5+4]=1;
    world.step(occupied);expect(Array.from(world.amount).filter(v=>v>=0)).toEqual([]);
    occupied[13*5+4]=0;world.step(occupied);
    expect(world.amount[13]).toBe(1);
    expect(Array.from(world.amount).filter(v=>v>=0)).toEqual([1]);
  });
});
