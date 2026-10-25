import type { WebGPURenderer } from 'three/webgpu';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { loadData } from '../src/game/data-files.ts';
import { MOVEMENT, movementType } from '../src/game/data/movement.ts';
import { economyScene } from '../src/demo/economy-scene.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { EconomyRuntime } from '../src/game/simulation/economy-runtime.ts';
import type { UnitPlacement } from '../src/game/simulation/units-state.ts';
import type { AttackCommand } from '../src/game/simulation/combat-state.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';

/** Two houses share one slot allocator and map, but never share money, power or production. */
export async function checkMatchEconomy(renderer: WebGPURenderer) {
  const source = economyScene(await loadData(false, true, true), false, 32);
  const width = 32, height = 16, cells = width * height, passable = new Uint8Array(cells).fill(1), playable = new Int32Array(cells).fill(1);
  const units: UnitPlacement[] = Array.from({ length: 32 }, () => ({ cell: 0, type: movementType('E1'), health: 0 }));
  const buildings = [0, 1].map(owner => ({ id: owner + 2, type: 'PROC', cell: 11 * width + (owner ? 23 : 4), owner, faction: owner + 1 }));
  for (const owner of [0, 1]) {
    units[owner] = { cell: 5 * width + (owner ? 24 : 5), type: movementType('MCV'), owner, facing: 160 };
    units[owner + 2] = { cell: buildings[owner].cell, type: movementType('PROC'), owner };
  }
  const setup = { ...source.setup, grid: gridEdges(width, height, passable, true), bounds: { x: 1, y: 1, width: 30, height: 14 },
    passable, land: new Uint8Array(cells), units };
  const world = { ...source, setup, buildings, playable, buildable: playable, passable, basePassable: passable, baseLand: setup.land,
    houses: [{ faction: 1, credits: 10000 }, { faction: 2, credits: 10000 }] as const };
  const battle = new GpuCombat(renderer, setup), economy = new EconomyRuntime(battle, world);
  try {
    await battle.prepareForPlay(); await economy.lifecycle.prepareForPlay(); await economy.report.prepareForPlay();
    const tick = async (commands:AttackCommand[]=[]) => { if (!economy.beginTick()) throw new Error('A completed report did not permit the next tick'); battle.step(commands); await economy.endTick(); };
    for (const owner of [0, 1]) economy.withOwner(owner, () => economy.deploy(owner));
    for (let i = 0; i < 90; i++) await tick();
    for (const owner of [0, 1]) {
      const yard = economy.buildings.get(owner);
      if (yard?.type !== 'FACT' || yard.owner !== owner || !yard.active) throw new Error(`House ${owner} could not deploy its own MCV`);
      if (economy.houses[owner].factories.length !== 2 || !economy.houses[owner].factories.every(b => b.faction === owner + 1)) throw new Error('Factory lists crossed houses');
    }
    const mining = economy.miningState.array as Int32Array; mining[0] = 125; mining[1] = 200; economy.miningState.needsUpdate = true;
    const deliveries = economy.transportState.array as Int32Array; deliveries[0] = 75; deliveries[1] = 125; economy.transportState.needsUpdate = true;
    const services = economy.serviceState.array as Int32Array; services[0] = 4; services[1] = 8; economy.serviceState.needsUpdate = true;
    await economy.endTick(); await tick();
    for (const [owner, expected] of [10196, 10317].entries()) {
      if (economy.houses[owner].economy.money !== expected) throw new Error(`House ${owner} ledger mixed accounts: ${economy.houses[owner].economy.money}`);
    }
    for (const owner of [0, 1]) economy.withOwner(owner, () => economy.choose('NUKE'));
    for (let i = 0; i < 30; i++) await tick();
    const first = economy.houses[0].queues.items.get('building'), second = economy.houses[1].queues.items.get('building');
    if (!first || !second || first === second || first.stage !== second.stage || first.stage === 0) throw new Error('Independent production queues did not advance equally');
    economy.withOwner(0, () => economy.choose('NUKE', true)); await tick();
    const held = first.stage, other = second.stage;
    for (let i = 0; i < 10; i++) await tick();
    if (first.stage !== held || second.stage <= other) throw new Error('Holding one house stopped the other house production');
    const before = economy.houses[1].economy.money;
    economy.withOwner(0, () => economy.choose('NUKE', true)); await tick();
    if (economy.houses[0].queues.items.has('building') || economy.houses[1].economy.money > before) throw new Error('Cancellation refunded the wrong house');
    if (economy.inventory[movementType('FACT')] !== 1 || economy.inventory[MOVEMENT.length + movementType('FACT')] !== 1) throw new Error('House inventory did not track both construction yards');
    economy.houses[1].queues.cancel('building');
    economy.houses[0].economy.tiberium=300;economy.houses[1].economy.tiberium=700;
    economy.lifecycle.create(4,{type:movementType('E6'),cell:10*width+23,owner:0});await tick();
    await tick([{frame:battle.frame+1,kind:'capture',ids:[4],target:3}]);
    for(let i=0;i<160&&economy.buildings.get(3)?.owner!==0;i++)await tick();
    if(economy.buildings.get(3)?.owner!==0)throw new Error('Engineer ownership did not reach the house report');
    if(economy.houses[0].economy.tiberium!==1000||economy.houses[1].economy.tiberium!==0)throw new Error('Captured refinery did not transfer its excess stored Tiberium');
    if(economy.houses[0].economy.capacity!==2000||economy.houses[1].economy.capacity!==0)throw new Error('Capture left capacity with the previous owner');
    mining[0]+=23;economy.miningState.needsUpdate=true;await economy.endTick();await tick();
    if(Number(economy.houses[0].economy.tiberium)!==1023)throw new Error('Capture booty masked the next GPU income report');
    const beforeSale=new Int32Array(await renderer.getArrayBufferAsync(battle.units));
    economy.withOwner(0,()=>economy.sell(0));
    for(let i=0;i<3;i++)await tick();
    const soldUnits=new Int32Array(await renderer.getArrayBufferAsync(battle.units)),soldState=new Int32Array(await renderer.getArrayBufferAsync(battle.state));
    const crew=units.map((_,id)=>id).filter(id=>beforeSale[id*U.WORDS+U.UHEALTH]<=0&&soldUnits[id*U.WORDS+U.UHEALTH]>0&&soldUnits[id*U.WORDS+U.UOWNER]===0);
    if(!crew.length)throw new Error('Selling the construction yard produced no crew');
    // BUILDING.CPP Mission_Deconstruction assigns GUARD_AREA after Scatter, including human crews.
    for(const id of crew)if(soldState[id*C.CWORDS+C.CMISSION]!==C.GUARD_AREA)throw new Error(`Sale crew ${id} lost its area-guard mission`);
    economy.lifecycle.create(20,{type:movementType('RMBO'),cell:economy.buildings.get(1)!.cell-width+1,owner:0});
    await tick();await tick();
    const beforeC4=new Int32Array(await renderer.getArrayBufferAsync(battle.units));
    if(beforeC4[20*U.WORDS+U.UHEALTH]<=0)throw new Error('The sabotage fixture did not create its commando');
    await tick([{frame:battle.frame+1,kind:'sabotage',ids:[20],target:1}]);
    const deadline=battle.frame+180;
    while(economy.buildings.has(1)&&battle.frame<deadline)await tick();
    if(economy.buildings.has(1))throw new Error('C4 did not remove the enemy construction yard');
    const survivors=new Int32Array(await renderer.getArrayBufferAsync(battle.units)),survivorState=new Int32Array(await renderer.getArrayBufferAsync(battle.state));
    const defenders=units.map((_,id)=>id).filter(id=>beforeC4[id*U.WORDS+U.UHEALTH]<=0&&survivors[id*U.WORDS+U.UHEALTH]>0&&survivors[id*U.WORDS+U.UOWNER]===1);
    if(!defenders.length)throw new Error('The seeded C4 destruction produced no survivors');
    // BUILDING.CPP Drop_Debris receives WhomToRepay (the saboteur), not every ordinary damage source.
    for(const id of defenders)if(survivorState[id*C.CWORDS+C.CMISSION]!==C.ATTACK||survivorState[id*C.CWORDS+C.CTARGET]!==20)throw new Error(`Survivor ${id} did not target the saboteur`);
  } finally { economy.dispose(); battle.dispose(); }
}
