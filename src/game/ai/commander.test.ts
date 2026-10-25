import { expect, it } from 'vitest';
import { Commander } from './commander.ts';
import { HouseState } from '../simulation/house-state.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { PRODUCTION } from '../data/production.ts';
import { FactoryProduction } from '../simulation/economy.ts';
import type { EconomyRuntime, LiveBuilding } from '../simulation/economy-runtime.ts';

function completedBuilding(space:boolean){
  const house=new HouseState(0,1,9700),placed:number[]=[],width=16,cells=width*16;
  house.factories.push({type:'FACT',faction:1,active:true});house.economy.power=100;
  const item=new FactoryProduction(PRODUCTION.get('NUKE')!,house.economy);item.stage=108;item.balance=0;house.queues.items.set('building',item);
  const inventory=new Int32Array(MOVEMENT.length*2);inventory[movementType('FACT')]=1;
  const owners=new Int32Array(cells);owners[100]=1;
  const economy={frame:100,scene:{setup:{seed:1995,grid:{width}}},current:house,
    buildings:new Map([[0,{id:0,type:'FACT',cell:100,owner:0,faction:1,health:800,active:true,selling:false}]]),inventory,
    faction:1,house:house.economy,houses:[house,new HouseState(1,2,0)],queues:house.queues,
    placement:{width,height:16,playable:new Int32Array(cells).fill(1),buildable:new Int32Array(cells).fill(Number(space)),occupied:new Int32Array(cells).fill(-1),owners,bibs:new Int32Array(cells)},
    deployIdleMcvs(){},get available(){return house.queues.options();},withOwner<T>(_owner:number,work:()=>T){return work();},choose(){},place(_name:string,cell:number){placed.push(cell);},
  } as unknown as EconomyRuntime;
  return {economy,house,placed,ai:new Commander(0)};
}

it('abandons and refunds an AI building when no legal placement exists',()=>{
  const {economy,house,ai}=completedBuilding(false);ai.step(economy);
  expect(house.queues.items.has('building')).toBe(false);expect(house.economy.money).toBe(10000);
});

it('waits three seconds after a temporarily blocked placement',()=>{
  const {economy,house,placed,ai}=completedBuilding(true);
  Object.assign(house,{placementRetryFrame:145});ai.step(economy);expect(placed).toHaveLength(0);
  economy.frame=145;ai.step(economy);expect(placed).toHaveLength(1);
});

it('retries AI production after the initial payment was unaffordable',()=>{
  const house=new HouseState(0,1,0),inventory=new Int32Array(MOVEMENT.length*2),buildings=new Map<number,LiveBuilding>();
  for(const type of ['FACT','NUKE','WEAP']){
    const id=buildings.size;house.factories.push({type,faction:1,active:true});inventory[movementType(type)]++;
    buildings.set(id,{id,type,cell:100+id,owner:0,faction:1,health:PRODUCTION.get(type)!.strength,active:true,opened:true,started:0,duration:0,selling:false,repairing:false});
  }
  house.economy.power=100;house.economy.drain=30;house.queues.begin('JEEP');expect(house.queues.items.get('vehicle')!.suspended).toBe(true);house.economy.credits=2000;
  const economy={frame:100,scene:{setup:{seed:1995}},buildings,inventory,types:[movementType('FACT')],health:[800],faction:1,house:house.economy,houses:[house,new HouseState(1,2,0)],queues:house.queues,
    deployIdleMcvs(){},get available(){return house.queues.options();},withOwner<T>(_owner:number,work:()=>T){return work();},choose(name:string){house.queues.begin(name);}} as unknown as EconomyRuntime;
  new Commander(0).step(economy);expect(house.queues.items.get('vehicle')?.suspended).toBe(false);
});

it.each([1, 2])('starts faction %i with power before a refinery under original prerequisites', faction => {
  const house = new HouseState(0, faction, 10000), orders: string[] = [];
  house.economy.power = 15;
  const buildings = new Map<number, LiveBuilding>();
  const inventory = new Int32Array(MOVEMENT.length * 2);
  const add = (name: string) => {
    const id = buildings.size;
    house.factories.push({ type: name, faction, active: true });
    buildings.set(id, { id, type: name, cell: 100 + id, owner: 0, faction, health: 100, active: true, opened: true, started: 0, duration: 0, selling: false, repairing: false });
    inventory[movementType(name)]++;
  };
  add('FACT');
  const economy = { frame: 1, scene: { setup: { seed: 1995 } }, buildings, inventory, types: [movementType('FACT')], health: [100],
    faction, houses:[house,new HouseState(1,faction===1?2:1,10000)], house: house.economy, queues: house.queues, get available() { return house.queues.options(); },
    deployIdleMcvs(){},withOwner<T>(_owner: number, work: () => T) { return work(); }, choose(name: string) { orders.push(name); },
  } as unknown as EconomyRuntime;
  const ai = new Commander(0);
  ai.step(economy);
  expect(orders).toEqual(['NUKE']);
  add('NUKE'); house.economy.power = 115; orders.length = 0;
  ai.step(economy);
  // HOUSE.CPP AI_Building assigns HIGH urgency to the first refinery, above barracks.
  expect(orders[0]).toBe('PROC');
});
