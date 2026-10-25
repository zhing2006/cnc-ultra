import { PRODUCTION } from '../src/game/data/production.ts';
import { economyDrawing } from './economy-drawing.ts';
import type { EconomyRuntime } from '../src/game/simulation/economy-runtime.ts';
import { StorageBufferAttribute } from 'three/webgpu';
import { createRenderer } from '../src/engine/renderer.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { loadData } from '../src/game/data-files.ts';
import { movementType } from '../src/game/data/movement.ts';
import { economyScene } from '../src/game/simulation/economy-scene.ts';
import { BUILDING_WORDS } from '../src/game/simulation/economy-runtime.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { GpuAircraft } from '../src/game/simulation/aircraft-gpu.ts';
import { GpuAirOperations } from '../src/game/simulation/air-operations-gpu.ts';
import { GpuTransport } from '../src/game/simulation/transport-gpu.ts';
import { GpuServices } from '../src/game/simulation/services-gpu.ts';
import { GpuHarvest } from '../src/game/simulation/harvest-gpu.ts';
import { GpuTiberium } from '../src/game/simulation/tiberium-gpu.ts';
import { GpuBuildingEffects } from '../src/game/simulation/building-effects-gpu.ts';
import { GpuLifecycle } from '../src/game/simulation/lifecycle-gpu.ts';
import { EconomyReport } from '../src/game/simulation/economy-report.ts';
import { initialHarvest } from '../src/game/simulation/harvest-cpu.ts';
import { initialTransport } from '../src/game/simulation/transport-cpu.ts';
import { initialServices } from '../src/game/simulation/services-cpu.ts';
import { releaseStorage } from '../src/engine/simulation/resources.ts';

/** Acceptance-only scaling sample. The same actors and grid are used before and after changes. */
export async function measureEconomyGpu(count:number,drawing=false){
  const preparationStart=performance.now();
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const renderer=wrapper.three,width=256,height=128,cells=width*height,passable=new Uint8Array(cells).fill(1),playable=new Int32Array(cells).fill(1);
  const files=await loadData(false,true,true),source=economyScene(files,false,8);
  const names=['FACT','NUKE','PROC','FIX','HPAD','HARV','TRAN','ORCA'];
  const units=Array.from({length:count},(_,id)=>({type:movementType(names[id]??'MTNK'),cell:id<8?4*width+4+id*6:(16+Math.trunc((id-8)/240))*width+8+(id-8)%240}));
  const setup={grid:gridEdges(width,height,passable,true),land:new Uint8Array(cells),passable,units,seed:0x1995,dynamicTypes:true};
  const tiberium={width,height,amount:new Int32Array(cells).fill(-1),variants:new Int32Array(cells),clear:playable.slice(),blossom:new Int32Array(cells),playable,seed:0x1995};
  tiberium.amount[units[5].cell]=11;
  const scene={...source,setup,playable,passable,basePassable:passable,baseLand:setup.land,buildable:playable,tiberium};
  const battle=new GpuCombat(renderer,setup),visuals=new StorageBufferAttribute(new Int32Array(count*BUILDING_WORDS),1);
  for(let id=0;id<5;id++)(visuals.array as Int32Array)[id*BUILDING_WORDS+3]=1;
  const miningState=new StorageBufferAttribute(initialHarvest(count),1),transportState=new StorageBufferAttribute(initialTransport(count),1),serviceState=new StorageBufferAttribute(initialServices(count),1);
  // This sample measures GPU simulation and kernel preparation, excluding CPU construction.
  const context={battle,scene,visuals,miningState,transportState,serviceState,placementVersion:0,buildings:new Map(),placing:undefined,faction:1,radar:false,mode:undefined,
    house:{power:500,drain:100,money:10000},queues:{items:new Map()},available:['NUKE','PROC','PYLE','WEAP','HPAD','FIX','SILO','ORCA'].map(name=>PRODUCTION.get(name)!),
    placement:{width,height,occupied:new Int32Array(cells).fill(-1),owners:new Int32Array(cells),bibs:new Uint8Array(cells),buildable:playable,playable}};
  const ore=new GpuTiberium(renderer,tiberium,battle.movement.occupancy),air=new GpuAircraft(battle.movement),operations=new GpuAirOperations(battle,air,playable),transport=new GpuTransport(battle,air,playable,transportState),services=new GpuServices(battle,serviceState),harvest=new GpuHarvest(context,ore),effects=new GpuBuildingEffects(battle,source.scene.animation!.frames),lifecycle=new GpuLifecycle(battle),report=new EconomyReport(battle,miningState,transportState,serviceState);
  const drawingStart=performance.now();
  const views=drawing?economyDrawing(context as unknown as EconomyRuntime,ore,air,effects,files):undefined;
  let drawingPreparationMs=performance.now()-drawingStart;
  ore.connect(battle,setup.land);lifecycle.validateTerrain(ore.amount);lifecycle.useAircraft(air.state);
  const backend=renderer.backend as unknown as {device:GPUDevice;trackTimestamp:boolean;getTimestampUID:(group:unknown)=>string;timestampQueryPool:{compute?:{timestamps:Map<string,number>};render?:{timestamps:Map<string,number>}}};
  if(!backend.device.features.has('timestamp-query'))throw new Error('GPU timestamps are required for this measurement');
  const compile:Record<string,number>={},measure=async(name:string,work:()=>Promise<unknown>)=>{const start=performance.now();await work();compile[name]=performance.now()-start;};
  try{
    battle.movement.enableOccupancyEdits();
    await measure('movementAndCombat',()=>battle.prepareForPlay());
    await measure('aircraft',()=>renderer.compileComputeAsync(air.kernels));
    await measure('airOperations',()=>renderer.compileComputeAsync([...operations.beforePass,operations.afterPass]));
    await measure('transport',()=>renderer.compileComputeAsync(transport.kernels));
    await measure('services',()=>renderer.compileComputeAsync(services.kernels));
    await measure('harvest',()=>renderer.compileComputeAsync(harvest.kernels));
    await measure('tiberium',()=>ore.prepareForPlay());
    await measure('lifecycle',()=>lifecycle.prepareForPlay());
    await measure('report',()=>report.prepareForPlay());
    await measure('buildingEffects',()=>effects.prepareForPlay());
    if(views){const start=performance.now();views.update();await backend.device.queue.onSubmittedWorkDone();drawingPreparationMs+=performance.now()-start;}
    const preparationMs=performance.now()-preparationStart;
    const gpuMs:number[]=[],renderUpdateMs:number[]=[],cpuMs:number[]=[],dispatches:number[]=[],gpuStagesMs:Record<string,number>[]=[],stageDispatches:Record<string,number>[]=[];
    const compute=renderer.compute.bind(renderer);let calls=0,stage='prepare';
    const labels=new Map<string,string>();let counts:Record<string,number>={};
    const phase=(name:string)=>{stage=name;};
    renderer.compute=((...args:Parameters<typeof renderer.compute>)=>{
      const n=Array.isArray(args[0])?args[0].length:1;calls+=n;counts[stage]=(counts[stage]??0)+n;
      const result=compute(...args);labels.set(backend.getTimestampUID(args[0]),stage);return result;
    }) as typeof renderer.compute;
    const tick=async()=>{
      calls=0;counts={};labels.clear();const start=performance.now();
      phase('groundSort');views?.ground.sort();
      phase('lifecycle');for(let id=0;id<5;id++)lifecycle.status(id,256,true);lifecycle.flush();battle.movement.beginOccupancyEdits();
      phase('tiberium');ore.step();phase('transport');transport.step();phase('services');services.step(100000);
      phase('harvest');harvest.step();phase('airOperations');operations.before();phase('aircraft');air.step();battle.movement.endOccupancyEdits();
      phase('combat');battle.step();phase('airAfter');operations.after();phase('oreDamage');ore.damage(battle.frame);
      phase('buildingEffects');battle.movement.beginOccupancyEdits();effects.step();battle.movement.endOccupancyEdits();
      phase('layerTransitions');views?.ground.transitionLayers();views?.update(phase);
      phase('report');report.request([0,1,2,3,4],48);const elapsed=performance.now()-start;await report.read();return elapsed;
    };
    backend.trackTimestamp=true;
    for(let sample=0;sample<8;sample++){
      const elapsed=await tick();await renderer.resolveTimestampsAsync('compute');await renderer.resolveTimestampsAsync('render');
      const durations:Record<string,number>={};
      for(const [id,ms] of backend.timestampQueryPool.compute!.timestamps){const name=labels.get(id);if(name)durations[name]=(durations[name]??0)+ms;}
      if(sample>=3){renderUpdateMs.push(Array.from(backend.timestampQueryPool.render?.timestamps.values()??[]).reduce((a,b)=>a+b,0));gpuMs.push(Object.values(durations).reduce((a,b)=>a+b,0));cpuMs.push(elapsed);dispatches.push(calls);gpuStagesMs.push(durations);stageDispatches.push(counts);}
    }
    backend.trackTimestamp=false;
    const hooks=window as unknown as {startEconomyProfile?:()=>Promise<void>;stopEconomyProfile?:()=>Promise<void>};
    if(hooks.startEconomyProfile&&count===20000){await hooks.startEconomyProfile();for(let i=0;i<10;i++)await tick();await hooks.stopEconomyProfile!();}
    const layerBurstGpuMs:Record<string,number[]>={};
    if(views&&count>=200){
      const u=new Int32Array(await renderer.getArrayBufferAsync(battle.units));
      const U=await import('../src/game/simulation/units-state.ts');
      backend.trackTimestamp=true;
      for(const size of [200,1000,2000].filter(n=>n<=count)){
        const times:number[]=[];layerBurstGpuMs[size]=times;
        for(let sample=0;sample<6;sample++){
          for(let id=0;id<size;id++){const at=id*U.WORDS;u[at+U.UTYPE]=movementType('TRAN');u[at+U.UDOMAIN]=1;u[at+U.UHEALTH]=90;u[at+U.UATTACHED]=0;u[at+U.UALTITUDE]=sample%2?0:24;u[at+U.UGENERATION]=2;}
          (battle.units.array as Int32Array).set(u.subarray(0,size*U.WORDS));battle.units.addUpdateRange(0,size*U.WORDS);battle.units.needsUpdate=true;
          views.ground.transitionLayers();const ms=await renderer.resolveTimestampsAsync('compute');if(sample>=2)times.push(ms??0);
        }
      }
      backend.trackTimestamp=false;
    }
    renderer.compute=compute;
    return {count,width,height,compileMs:compile,drawingPreparationMs,preparationMs,gpuMs,renderUpdateMs,cpuMs,dispatches,gpuStagesMs,stageDispatches,layerBurstGpuMs,drawingUpdatesMeasured:drawing,readbackBytes:report.readbackBytes,renderingMeasured:false};
  }finally{
    backend.trackTimestamp=false;views?.dispose();report.dispose();lifecycle.dispose();effects.dispose();harvest.dispose();services.dispose();transport.dispose();operations.dispose();air.dispose();ore.dispose();battle.dispose();releaseStorage(renderer,[visuals,miningState,transportState,serviceState]);wrapper.dispose();canvas.remove();
  }
}
