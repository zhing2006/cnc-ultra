import { createRenderer } from '../src/engine/renderer.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { GpuPlacementFlush } from '../src/game/ai/placement-gpu.ts';
import { respondToBaseAttack } from '../src/game/ai/placement-cpu.ts';

/** Acceptance only: index construction plus eight base-defense requests among 20,000 actors. */
export async function measureBaseDefense(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const renderer=wrapper.three,count=20000,width=256,height=128,passable=new Uint8Array(width*height).fill(1);
  const units=Array.from({length:count},(_,id)=>({type:movementType(id%3===0?'E3':'MTNK'),owner:id<8?1:0,cell:id<8?4*width+8+id*30:(16+Math.trunc((id-8)/240))*width+8+(id-8)%240}));
  const setup={grid:gridEdges(width,height,passable,true),passable,land:new Uint8Array(passable.length),units,seed:1995,multiplayer:true};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer,setup),responses=new GpuPlacementFlush(gpu),initial=cpu.state.slice(),cooldown=new Int32Array(count);
  const backend=renderer.backend as unknown as {device:GPUDevice;trackTimestamp:boolean};
  const gpuMs:number[]=[],cpuMs:number[]=[];
  try{
    if(!backend.device.features.has('timestamp-query'))throw new Error('GPU timestamps are required');
    await responses.prepare();gpu.movement.refreshOccupancy();await backend.device.queue.onSubmittedWorkDone();
    for(let sample=0;sample<8;sample++){
      cpu.state.set(initial);cooldown.fill(0);cpu.movement.goals.fill(-1);cpu.movement.pathGoals.fill(-1);cpu.movement.frame=sample+1;
      (gpu.state.array as Int32Array).set(initial);gpu.state.needsUpdate=true;
      (gpu.movement.goals.array as Int32Array).fill(-1);gpu.movement.goals.needsUpdate=true;
      (gpu.movement.pathGoals.array as Int32Array).fill(-1);gpu.movement.pathGoals.needsUpdate=true;
      (responses.cooldown.array as Uint32Array).fill(0);responses.cooldown.needsUpdate=true;
      gpu.movement.frame=sample+1;(gpu.movement.control.array as Int32Array)[0]=sample+1;gpu.movement.control.needsUpdate=true;
      backend.trackTimestamp=true;const start=performance.now();for(let enemy=0;enemy<8;enemy++)responses.respond(0,enemy);const elapsed=performance.now()-start;
      const duration=await renderer.resolveTimestampsAsync('compute');backend.trackTimestamp=false;
      if(duration===undefined)throw new Error('GPU timestamps were not resolved');
      if(sample>=3){gpuMs.push(duration);cpuMs.push(elapsed);}
      if(sample===7)for(let enemy=0;enemy<8;enemy++)respondToBaseAttack(cpu,0,enemy,cooldown);
    }
    const actual=new Int32Array(await renderer.getArrayBufferAsync(gpu.state)),timers=new Int32Array(await renderer.getArrayBufferAsync(responses.cooldown));
    for(let i=0;i<actual.length;i++)if(actual[i]!==cpu.state[i])throw new Error(`Large base-defense state differs at ${i}: GPU ${actual[i]}, CPU ${cpu.state[i]}`);
    for(let id=0;id<count;id++)if(timers[id]!==cooldown[id])throw new Error(`Large base-defense timer differs at ${id}`);
    return {count,width,height,requests:8,gpuMs,cpuMs,renderingMeasured:false};
  }finally{backend.trackTimestamp=false;responses.dispose();gpu.dispose();wrapper.dispose();canvas.remove();}
}
