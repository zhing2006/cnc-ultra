import { createRenderer } from '../src/engine/renderer.ts';
import { StorageBufferAttribute,type WebGPURenderer } from 'three/webgpu';
import { Fn,If,int,instanceIndex,uniform } from 'three/tsl';
import { GpuPrefixSum } from '../src/engine/simulation/prefix-sum.ts';
import { GpuReinsert } from '../src/engine/simulation/reinsert.ts';
import { releaseStorage } from '../src/engine/simulation/resources.ts';
import { insertGround } from '../src/game/simulation/ground.ts';

/** Independent sequential reference: LAYER.CPP Sorted_Add on a partly ordered list. */
export async function compareReinsertBatches(renderer:WebGPURenderer,large=false){
  const input=new StorageBufferAttribute(new Uint32Array(777).fill(1),1),prefix=new GpuPrefixSum(renderer,input,777);
  try{
    renderer.compute(prefix.kernels);const sums=new Uint32Array(await renderer.getArrayBufferAsync(prefix.output));
    const at=sums.findIndex((value,index)=>value!==index);if(at>=0)throw new Error(`Multi-workgroup prefix at ${at}: ${sums[at]} != ${at}`);
  }finally{prefix.dispose();releaseStorage(renderer,[input]);}
  for(const [count,phases,limit] of large?[[8193,2,5000],[20000,2,2000]]:[[777,12,777]])await compareReinsertCase(renderer,count,phases,limit);
}

async function compareReinsertCase(renderer:WebGPURenderer,count:number,phases:number,limit:number){
  const keyValues=new Int32Array(count*2),initial=Uint32Array.from({length:count},(_,i)=>(i*73)%count);
  const keys=new StorageBufferAttribute(keyValues,1),order=new StorageBufferAttribute(initial.slice(),1),changed=new StorageBufferAttribute(new Int32Array(count),1);
  const {storage}=await import('three/tsl');const flags=storage(changed,'int',count).toReadOnly();
  const reinsert=new GpuReinsert(renderer,keys,order),mark=Fn(()=>{If(flags.element(instanceIndex).notEqual(0),()=>{reinsert.changes.add(int(instanceIndex));});})().compute(count);
  let state=1995;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
  try{
    const expected=Array.from(initial);
    for(let phase=0;phase<phases;phase++){
      let selected=0;
      for(let id=0;id<count;id++){
        keyValues[id*2]=phase===2?0:(random()%7)-3;keyValues[id*2+1]=phase===2?0:(random()%19)-9;
        const enabled=count===777?(phase===0?false:phase===1?id===300:phase===2?true:random()%4!==0):id%4!==phase;
        (changed.array as Int32Array)[id]=Number(enabled&&selected<limit);if(changed.array[id])selected++;
      }
      keys.needsUpdate=changed.needsUpdate=true;
      reinsert.clear();renderer.compute(mark);
      for(let id=0;id<count;id++)if(changed.array[id]){expected.splice(expected.indexOf(id),1);insertGround(expected,keyValues,id);}
      reinsert.step();const actual=new Uint32Array(await renderer.getArrayBufferAsync(order));
      const at=actual.findIndex((id,i)=>id!==expected[i]);if(at>=0)throw new Error(`Batch reinsertion count ${count}, phase ${phase}, position ${at}: ${actual[at]} != ${expected[at]}`);
    }
  }finally{mark.dispose();reinsert.dispose();releaseStorage(renderer,[keys,order,changed]);}
}

/** Acceptance measurement only; ordinary checks do not run the large batches. */
export async function measureReinsertBatches(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const renderer=wrapper.three,backend=renderer.backend as unknown as {device:GPUDevice;trackTimestamp:boolean};
  const count=20000,keyValues=Int32Array.from({length:count*2},(_,i)=>i%2?Math.trunc(i/2/256)*256:(Math.trunc(i/2)%256)*256);
  const keys=new StorageBufferAttribute(keyValues,1),order=new StorageBufferAttribute(Uint32Array.from({length:count},(_,i)=>i),1);
  const before=performance.now(),reinsert=new GpuReinsert(renderer,keys,order),batch=uniform(0,'int');
  const mark=Fn(()=>{If(int(instanceIndex).lessThan(batch),()=>{reinsert.changes.add(int(instanceIndex));});})().compute(count);
  const samples:{changed:number;gpuMs:number[];cpuMs:number[]}[]=[];
  try{
    reinsert.clear();renderer.compute(mark);reinsert.step();await backend.device.queue.onSubmittedWorkDone();
    const preparationMs=performance.now()-before;
    backend.trackTimestamp=true;
    for(const size of [0,1,200,1000,2000]){
      batch.value=size;const gpuMs:number[]=[],cpuMs:number[]=[];
      for(let sample=0;sample<7;sample++){
        for(let id=0;id<count;id++)keyValues[id*2+1]=Math.trunc(id/256)*256+(id<size&&sample%2===0?1<<24:0);
        keys.needsUpdate=true;
        const start=performance.now();reinsert.clear();renderer.compute(mark);reinsert.step();const cpu=performance.now()-start;
        const gpu=await renderer.resolveTimestampsAsync('compute');if(sample>=2){gpuMs.push(gpu??0);cpuMs.push(cpu);}
      }
      samples.push({changed:size,gpuMs,cpuMs});
    }
    return {count,preparationMs,samples};
  }finally{backend.trackTimestamp=false;mark.dispose();reinsert.dispose();releaseStorage(renderer,[keys,order]);wrapper.dispose();canvas.remove();}
}
