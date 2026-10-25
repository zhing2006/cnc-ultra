import { createRenderer } from '../src/engine/renderer.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { CpuUnits } from '../src/game/simulation/units-cpu.ts';
import { GpuUnits } from '../src/game/simulation/units-gpu.ts';
import { movementType } from '../src/game/data/movement.ts';
import * as U from '../src/game/simulation/units-state.ts';
import { FIELD_WORDS,FIELD_READY,FIELD_RESET } from '../src/engine/simulation/flow.ts';
import { StorageBufferAttribute } from 'three/webgpu';
import { releaseStorage } from '../src/engine/simulation/resources.ts';

export async function campaignRouting(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>{throw new Error(message);}});if(!renderer)throw new Error('WebGPU is required');
  try{
    for(const corridor of [false,true]){
      const width=32,height=24,passable=Uint8Array.from({length:width*height},(_,i)=>Number(!corridor||Math.trunc(i/width)===12));
      const setup={campaignRouting:true,grid:gridEdges(width,height,passable,true),passable,land:new Uint8Array(width*height),seed:1995,houseCount:2,allies:[1,2],
        units:[{type:movementType('MTNK'),cell:12*width+2,owner:1},{type:movementType('MTNK'),cell:12*width+3,owner:1},{type:movementType('GTWR'),cell:(corridor?11:12)*width+16,owner:0}]};
      const cpu=new CpuUnits(setup),gpu=new GpuUnits(renderer.three,setup);
      try{
        cpu.routing!.setTeams([[0,1]],[1,1,1]);gpu.routing!.setTeams([[0,1]],[1,1,1]);
        cpu.goals[0]=cpu.goals[1]=12*width+29;(gpu.goals.array as Int32Array).set(cpu.goals);gpu.goals.needsUpdate=true;
        for(let tick=0;tick<12;tick++){
          cpu.step();gpu.step();
          const actual=await Promise.all(gpu.buffers().map(async buffer=>new Int32Array(await renderer.three.getArrayBufferAsync(buffer)))),expected=cpu.buffers();
          for(let b=0;b<actual.length;b++)for(let i=0;i<actual[b].length;i++)if(actual[b][i]!==expected[b][i])throw new Error(`Campaign routing corridor=${corridor}, tick=${tick+1}, buffer=${b}, word=${i}: ${actual[b][i]} != ${expected[b][i]}`);
        }
        const saved=await Promise.all(gpu.saveBuffers.map(async buffer=>new Uint8Array(await renderer.three.getArrayBufferAsync(buffer))));
        gpu.stepMany(4);const expected=await Promise.all(gpu.buffers().map(buffer=>renderer.three.getArrayBufferAsync(buffer)));
        gpu.saveBuffers.forEach((buffer,i)=>{new Uint8Array(buffer.array.buffer,buffer.array.byteOffset,buffer.array.byteLength).set(saved[i]);buffer.clearUpdateRanges();buffer.needsUpdate=true;});gpu.frame=12;gpu.stepMany(4);
        const restored=await Promise.all(gpu.buffers().map(buffer=>renderer.three.getArrayBufferAsync(buffer)));
        for(let b=0;b<expected.length;b++){const a=new Int32Array(expected[b]),c=new Int32Array(restored[b]);if(a.some((v,i)=>v!==c[i]))throw new Error(`Campaign routing save continuation differs in buffer ${b}`);}
      }finally{gpu.dispose();}
    }
    // Exercise coalescing independently of movement and the expensive field solver.
    // Include padding, different houses, shared goals and capacities beyond one sort block.
    for(const count of [300,1025]){
      const width=32,height=24,passable=new Uint8Array(width*height).fill(1);
      const setup={campaignRouting:true,grid:gridEdges(width,height,passable,true),passable,land:new Uint8Array(width*height),seed:1995,houseCount:2,allies:[1,2],
        units:Array.from({length:count},(_,id)=>({type:movementType('MTNK'),cell:id%768,owner:id%2,health:id<256?400:0}))};
      const cpu=new CpuUnits(setup),gpu=new GpuUnits(renderer.three,setup),groups=[Array.from({length:128},(_,i)=>i*2),Array.from({length:128},(_,i)=>i*2+1)];
      try{
        cpu.routing!.setTeams(groups,new Int32Array(count).fill(1));gpu.routing!.setTeams(groups,new Int32Array(count).fill(1));
        for(let round=0;round<3;round++){
          for(let id=0;id<count;id++)cpu.pathGoals[id]=id<256?(id*13+round)%23+700:-1;
          cpu.units[round*U.WORDS+U.UHEALTH]=0;
          (gpu.units.array as Int32Array).set(cpu.units);gpu.units.needsUpdate=true;
          (gpu.pathGoals.array as Int32Array).set(cpu.pathGoals);gpu.pathGoals.needsUpdate=true;
          cpu.routing!.step(cpu.flow);renderer.three.compute(gpu.routing!.kernels);
          const actual=new Int32Array(await renderer.three.getArrayBufferAsync(gpu.routing!.data)),expected=cpu.routing!.layout.data;
          if(actual.some((value,i)=>value!==expected[i]))throw new Error(`Coalesced campaign requests differ for ${count} actors, round ${round}`);
          const keys=new Int32Array(await renderer.three.getArrayBufferAsync(gpu.routing!.goals));
          if(keys.some((value,i)=>value!==cpu.routing!.goals[i]))throw new Error(`Shared campaign keys differ for ${count} actors`);
          const shared=new Map<string,number>();
          for(let id=0;id<256;id++)if(cpu.units[id*U.WORDS+U.UHEALTH]>0){
            const request=`${cpu.pathGoals[id]}/${id%2}`,prior=shared.get(request);
            if(prior!==undefined&&keys[id]!==prior)throw new Error('Equal campaign requests did not share a field');
            shared.set(request,keys[id]);
          }
        }
      }finally{gpu.dispose();}
    }
    {
      const width=32,height=24,passable=new Uint8Array(width*height).fill(1),goal=12*width+29;
      const setup={campaignRouting:true,grid:gridEdges(width,height,passable,true),passable,land:new Uint8Array(width*height),seed:1995,houseCount:2,allies:[1,2],
        units:[{type:movementType('MTNK'),cell:12*width+2,owner:1},{type:movementType('GTWR'),cell:12*width+16,owner:0}]};
      const cpu=new CpuUnits(setup),gpu=new GpuUnits(renderer.three,setup),shadow=new StorageBufferAttribute(new Int32Array(768).fill(-2),1);
      cpu.routing!.visible=new Int32Array(768).fill(-2);
      const sight=gpu.routing!.copySight(shadow),routePasses=gpu.routing!.kernels.filter(pass=>pass!==sight);
      try{
        cpu.routing!.setTeams([[0]],[1,1]);gpu.routing!.setTeams([[0]],[1,1]);
        cpu.goals[0]=goal;(gpu.goals.array as Int32Array).set(cpu.goals);gpu.goals.needsUpdate=true;
        cpu.step();gpu.step();
        const at=cpu.flow.lookup[cpu.routing!.goals[0]]*FIELD_WORDS;
        for(const change of ['magnitude','nearby visibility','distant visibility'] as const){
          if(change==='magnitude')cpu.units[U.WORDS+U.UTYPE]=movementType('ATWR');
          else cpu.routing!.visible[change==='nearby visibility'?goal:33]=-1;
          (gpu.units.array as Int32Array).set(cpu.units);gpu.units.needsUpdate=true;
          (shadow.array as Int32Array).set(cpu.routing!.visible);shadow.needsUpdate=true;
          cpu.routing!.step(cpu.flow);renderer.three.compute([sight,...routePasses]);
          const fields=new Int32Array(await renderer.three.getArrayBufferAsync(gpu.flow.fields));
          if(fields.some((value,i)=>value!==cpu.flow.fields[i]))throw new Error(`Selective field invalidation differs after ${change}`);
          if(change==='distant visibility'?fields[at+FIELD_RESET]!==1:fields[at+FIELD_READY]!==1)throw new Error(`Unexpected campaign field invalidation after ${change}`);
        }
      }finally{gpu.dispose();releaseStorage(renderer.three,[shadow]);}
    }
    return true;
  }finally{renderer.dispose();canvas.remove();}
}
