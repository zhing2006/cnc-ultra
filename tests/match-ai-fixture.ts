import type { WebGPURenderer } from 'three/webgpu';
import { createRenderer } from '../src/engine/renderer.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { loadData } from '../src/game/data-files.ts';
import { economyScene } from '../src/demo/economy-scene.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuPlacementFlush } from '../src/game/ai/placement-gpu.ts';
import { flushPlacement,respondToBaseAttack } from '../src/game/ai/placement-cpu.ts';
import { MatchRuntime } from '../src/game/match-runtime.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import { EconomyRuntime } from '../src/game/simulation/economy-runtime.ts';
import { GpuServices } from '../src/game/simulation/services-gpu.ts';
import { FactoryProduction } from '../src/game/simulation/economy.ts';
import { PRODUCTION } from '../src/game/data/production.ts';
import { movementType } from '../src/game/data/movement.ts';
import { Commander } from '../src/game/ai/commander.ts';
import type { UnitPlacement } from '../src/game/simulation/units-state.ts';
import * as U from '../src/game/simulation/units-state.ts';

async function checkProducedMcv(renderer:WebGPURenderer){
  const source=economyScene(await loadData(false,true,true),false,16),width=32,height=20,passable=new Uint8Array(width*height).fill(1),playable=new Int32Array(passable.length).fill(1);
  const buildings=[['FACT',4*width+5],['WEAP',9*width+6],['EYE',4*width+11],['NUK2',8*width+11]].map(([type,cell],id)=>({id,type:String(type),cell:Number(cell),owner:0,faction:1}));
  const units:UnitPlacement[]=Array.from({length:16},()=>({cell:0,type:movementType('E1'),health:0}));
  for(const b of buildings)units[b.id]={cell:b.cell,type:movementType(b.type),owner:0};
  const setup={...source.setup,grid:gridEdges(width,height,passable,true),bounds:{x:1,y:1,width:30,height:18},passable,land:new Uint8Array(passable.length),units};
  const world={...source,setup,buildings,playable,buildable:playable,passable,basePassable:passable,baseLand:setup.land,credits:0};
  const battle=new GpuCombat(renderer,setup),economy=new EconomyRuntime(battle,world),services=new GpuServices(battle,economy.serviceState),commander=new Commander(0);
  const completed=new FactoryProduction(PRODUCTION.get('MCV')!,economy.house);completed.stage=108;completed.balance=0;economy.queues.items.set('vehicle',completed);
  economy.onTick=()=>{commander.step(economy);};
  try{
    await battle.prepareForPlay();await economy.prepareForPlay();await renderer.compileComputeAsync(services.kernels);
    for(let tick=0;tick<400;tick++){
      if(!economy.beginTick())throw new Error('MCV test lost its completed report');
      services.step(0,0);battle.step();await economy.endTick();
      if([...economy.buildings.values()].filter(b=>b.type==='FACT').length===2)return;
    }
    throw new Error('A newly produced MCV never deployed after leaving its factory');
  }finally{services.dispose();economy.dispose();battle.dispose();}
}
async function checkPlacementFlush(renderer:WebGPURenderer){
  const width=20,height=16,passable=new Uint8Array(width*height).fill(1),cell=5*width+6;
  const units=['HARV','E2','E3','MTNK','JEEP','LTNK','E1','E2','MTNK','LTNK'].map((name,id)=>({type:movementType(name),cell:id===0?cell:id===8?cell+width:id===9?11*width+15:cell-width-4+id,owner:id>=8?1:0}));
  const setup={grid:gridEdges(width,height,passable,true),passable,land:new Uint8Array(passable.length),units,seed:1995,multiplayer:true};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer,setup),flush=new GpuPlacementFlush(gpu),cooldown=new Int32Array(units.length);
  cpu.humanOwner=-1;gpu.humanOwner.value=-1;
  units.forEach((unit,id)=>{cpu.state[id*C.CWORDS+C.CMISSION]=C.MOVE;cpu.movement.goals[id]=unit.cell;});
  (gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
  (gpu.movement.goals.array as Int32Array).set(cpu.movement.goals);gpu.movement.goals.needsUpdate=true;
  try{
    await gpu.prepareForPlay();await flush.prepare();cpu.step();gpu.step();
    flushPlacement(cpu,0,'NUKE',cell,cooldown);flush.flush(0,'NUKE',cell);
    respondToBaseAttack(cpu,0,9,cooldown);flush.respond(0,9);
    const actual=await gpu.snapshot(),expected=cpu.buffers();
    actual.forEach((buffer,b)=>{for(let i=0;i<buffer.length;i++)if(buffer[i]!==expected[b][i])throw new Error(`Placement flush ${b}/${i}: GPU ${buffer[i]}, CPU ${expected[b][i]}`);});
    const timers=new Int32Array(await renderer.getArrayBufferAsync(flush.cooldown)).subarray(0,units.length);
    timers.forEach((value,id)=>{if(value!==cooldown[id])throw new Error(`Base rescue timer differs for ${id}`);});
    if(cpu.movement.goals[0]<0)throw new Error('Friendly blocker did not receive a scatter destination');
    if(cooldown[8]!==cpu.frame+225)throw new Error('Enemy blocker did not trigger a bounded rescue response');
  }finally{flush.dispose();gpu.dispose();}
}

async function checkRegionalRescue(renderer:WebGPURenderer){
  const width=64,height=32,passable=new Uint8Array(width*height).fill(1);
  const types=['RMBO','JEEP','MTNK','E3','E1','HARV','APC','BIKE','ORCA'];
  const units=Array.from({length:160},(_,id)=>({cell:id<4?[0,63,1984,2047][id]:50+(id-4)*11,
    type:movementType(id<4?'MTNK':types[id%types.length]),owner:id<4?1:0}));
  const setup={grid:gridEdges(width,height,passable,true),passable,land:new Uint8Array(passable.length),units,seed:1995};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer,setup),response=new GpuPlacementFlush(gpu),cooldown=new Int32Array(units.length);
  // Moving infantry may reserve a neighboring region while their coordinates remain in the source region.
  for(let id=4;id<units.length;id++)if(cpu.units[id*U.WORDS+U.UKIND]&&units[id].cell%width<63)cpu.units[id*U.WORDS+U.UDEST]=units[id].cell+1;
  cpu.state[10*C.CWORDS+C.CTARGET]=0;cpu.units[11*U.WORDS+U.UATTACHED]=1;cpu.movement.occupy();
  (gpu.units.array as Int32Array).set(cpu.units);gpu.units.needsUpdate=true;
  (gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
  try{
    await response.prepare();gpu.movement.refreshOccupancy();
    for(let enemy=0;enemy<4;enemy++){respondToBaseAttack(cpu,0,enemy,cooldown);response.respond(0,enemy);}
    const actual=new Int32Array(await renderer.getArrayBufferAsync(gpu.state));
    for(let i=0;i<actual.length;i++)if(actual[i]!==cpu.state[i])throw new Error(`Regional rescue word ${i}: GPU ${actual[i]}, CPU ${cpu.state[i]}`);
    const timers=new Int32Array(await renderer.getArrayBufferAsync(response.cooldown));
    for(let i=0;i<cooldown.length;i++)if(timers[i]!==cooldown[i])throw new Error(`Regional rescue timer ${i} differs`);
  }finally{response.dispose();gpu.dispose();}
}

async function checkAttackedBase(renderer:WebGPURenderer){
  const source=economyScene(await loadData(false,true,true),false,16),width=32,height=20,passable=new Uint8Array(width*height).fill(1),playable=new Int32Array(passable.length).fill(1);
  const buildings=[{id:0,type:'FACT',cell:4*width+5,owner:0,faction:1},{id:1,type:'FACT',cell:14*width+24,owner:1,faction:2}];
  const units:UnitPlacement[]=Array.from({length:16},()=>({cell:0,type:movementType('E1'),health:0}));
  for(const b of buildings)units[b.id]={cell:b.cell,type:movementType(b.type),owner:b.owner};
  for(let id=2;id<=5;id++)units[id]={cell:9*width+id,type:movementType(id<=4?'MTNK':'E1'),owner:0};
  units[6]={cell:12*width+20,type:movementType('MTNK'),owner:1};
  const setup={...source.setup,grid:gridEdges(width,height,passable,true),bounds:{x:1,y:1,width:30,height:18},passable,land:new Uint8Array(passable.length),units};
  const world={...source,setup,buildings,playable,buildable:playable,passable,basePassable:passable,baseLand:setup.land,credits:0,mcvs:[0,1]};
  const battle=new GpuCombat(renderer,setup),match=new MatchRuntime(battle,world);
  for(const commander of match.commanders)commander.enabled=false;
  try{
    await battle.prepareForPlay();await match.prepareForPlay();
    if(!match.beginTick())throw new Error('Match did not begin');
    battle.queueExplosions([{frame:1,x:5*256+128,y:4*256+128,damage:30,warhead:1,source:6}]);battle.step();await match.endTick();
    if(!match.beginTick())throw new Error('Damage report did not resume the match');
    const state=new Int32Array(await renderer.getArrayBufferAsync(battle.state));
    const defenders=[2,3,4,5].filter(id=>state[id*C.CWORDS+C.CTARGET]===6);
    if(defenders.length!==3)throw new Error(`Building damage recruited ${defenders.length} defenders instead of the required three`);
  }finally{match.dispose();battle.dispose();}
}

export async function checkMatchAI(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!renderer)throw new Error('WebGPU is required');
  try{await checkProducedMcv(renderer.three);await checkPlacementFlush(renderer.three);await checkRegionalRescue(renderer.three);await checkAttackedBase(renderer.three);}finally{renderer.dispose();canvas.remove();}
}
