import { compareReinsertBatches } from './reinsert-fixture.ts';
import { createRenderer } from '../src/engine/renderer.ts';
import { StorageBufferAttribute } from 'three/webgpu';
import { GpuReinsert } from '../src/engine/simulation/reinsert.ts';
import { Fn,int,instanceIndex } from 'three/tsl';
import { releaseStorage } from '../src/engine/simulation/resources.ts';
import { insertGround,groundLayout,updateGroundKeys,groundLayers,transitionGround,bubbleGround,GpuGround } from '../src/game/simulation/ground.ts';
import { PalettePipeline } from '../src/engine/indexed/pipeline.ts';
import { loadData } from '../src/game/data-files.ts';
import { economyScene } from '../src/demo/economy-scene.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuAircraft } from '../src/game/simulation/aircraft-gpu.ts';
import { CpuAircraft,AIR_WORDS,AMISSION,ASTATUS,ATIMER,ATARGET,ACONTACT } from '../src/game/simulation/aircraft-cpu.ts';
import { GpuAirOperations } from '../src/game/simulation/air-operations-gpu.ts';
import { CpuAirOperations } from '../src/game/simulation/air-operations-cpu.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';

function equal(actual:ArrayLike<number>,expected:ArrayLike<number>,message:string){
  for(let i=0;i<expected.length;i++)if(actual[i]!==expected[i])throw new Error(`${message}, word ${i}: ${actual[i]} != ${expected[i]}`);
}

export async function compareGroundTransitions(large=false){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const renderer=wrapper.three;
  try{
    await compareReinsertBatches(renderer);
    if(large)await compareReinsertBatches(renderer,true);
    // LAYER.CPP Sorted_Add inserts before the first greater key, even in a partly sorted list.
    // Span multiple workgroup stripes, with equal keys and moves in both directions.
    const count=777,keys=Int32Array.from({length:count*2},(_,i)=>i%2?(Math.trunc(i/2)*73)%97:0);
    const buffer=new StorageBufferAttribute(keys,1),order=new StorageBufferAttribute(Uint32Array.from({length:count},(_,i)=>i),1);
    const reinsert=new GpuReinsert(renderer,buffer,order),mark=Fn(()=>{reinsert.changes.add(int(instanceIndex).mul(13));})().compute(55);
    const expected=Array.from(order.array as Uint32Array);
    try{
      reinsert.clear();renderer.compute(mark);
      for(let id=0;id<55*13;id+=13){expected.splice(expected.indexOf(id),1);insertGround(expected,keys,id);}
      reinsert.step();equal(new Uint32Array(await renderer.getArrayBufferAsync(order)),expected,'Cooperative reinsertion');
    }finally{mark.dispose();reinsert.dispose();releaseStorage(renderer,[buffer,order]);}
    const {scene,setup}=economyScene(await loadData(),false,16);
    const units=U.initialUnits(setup),attribute=new StorageBufferAttribute(units,1),simulation={units:attribute,frame:0};
    const layout=groundLayout(scene,units,U.WORDS,true),keyValues=layout.keys.slice(),previous=groundLayers(layout,units),reference=Uint32Array.from({length:scene.objects.length+1},(_,i)=>i===0?scene.objects.length:i-1);
    const flash=new StorageBufferAttribute(Int32Array.from([0,0,-1,0]),1),clock=new StorageBufferAttribute(new Int32Array(2),1);
    const pipeline=new PalettePipeline(renderer,{...scene.setup,spriteCapacity:layout.count+1,dynamicSprites:{maxWidth:128,maxHeight:128}});
    const ground=new GpuGround(renderer,simulation,pipeline,layout,scene,{state:flash,offset:0,clock});
    try{
      updateGroundKeys(layout,units,keyValues);bubbleGround(reference,keyValues);
      for(const phase of [0,1,2]){
        for(const id of [1,3,7]){
          const at=id*U.WORDS;units[at+U.UTYPE]=movementType(id===3?'E1':'TRAN');units[at+U.UDOMAIN]=id===3?0:1;units[at+U.UKIND]=id===3?1:0;
          units[at+U.UHEALTH]=50;units[at+U.UGENERATION]=1;units[at+U.UX]=(5+id)*256+128;units[at+U.UY]=(12-id)*256+128;units[at+U.UALTITUDE]=phase===1?24:0;
          units[at+U.UATTACHED]=id===3&&phase===1?2:0;
        }
        attribute.needsUpdate=true;updateGroundKeys(layout,units,keyValues);
        const point=[(phase+1)*256,(phase+5)*256];(flash.array as Int32Array).set([...point,phase,phase+1]);flash.needsUpdate=true;
        keyValues[layout.flashId*2]=point[0];keyValues[layout.flashId*2+1]=point[1]-256;
        transitionGround(layout,units,keyValues,reference,previous);
        const list=Array.from(reference);list.splice(list.indexOf(layout.flashId),1);insertGround(list,keyValues,layout.flashId);reference.set(list);
        ground.transitionLayers();
        equal(new Uint32Array(await renderer.getArrayBufferAsync(ground.order.order)),reference,`Birth/flight/cargo phase ${phase}`);
        equal(new Int32Array(await renderer.getArrayBufferAsync(ground.keys)),keyValues,`Dynamic sort keys phase ${phase}`);
      }
    }finally{ground.dispose();pipeline.dispose();releaseStorage(renderer,[attribute,flash,clock]);}
    return true;
  }finally{wrapper.dispose();canvas.remove();}
}

export async function compareMassAirCoordination(measure=false){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const width=96,height=64,passable=new Uint8Array(width*height).fill(1),playable=new Int32Array(passable.length).fill(1);
  const units:U.UnitPlacement[]=[...Array.from({length:300},(_,id)=>({type:movementType(id<20?'HPAD':'NUKE'),cell:(2+Math.trunc(id/30)*3)*width+2+(id%30)*3,owner:id>=200?1:0})),
    ...Array.from({length:200},(_,id)=>({type:movementType('ORCA'),cell:(40+Math.trunc(id/40))*width+20+id%40,altitude:24}))];
  const setup={grid:gridEdges(width,height,passable,true),land:new Uint8Array(passable.length),passable,units,seed:1995};
  const gpu=new GpuCombat(wrapper.three,setup),flight=new GpuAircraft(gpu.movement),ops=new GpuAirOperations(gpu,flight,playable);
  const measured:Record<string,number[]>={};
  try{
    for(const mode of ['return','fire','release']){
      const cpu=new CpuCombat(setup),air=new CpuAircraft(cpu.movement),reference=new CpuAirOperations(cpu,air,playable);
      for(let id=300;id<500;id++){
        air.state[id*AIR_WORDS+AMISSION]=1;air.state[id*AIR_WORDS+ASTATUS]=mode==='fire'?1:5;air.state[id*AIR_WORDS+ATIMER]=0;air.state[id*AIR_WORDS+ATARGET]=299;
        cpu.state[id*C.CWORDS+C.CMISSION]=C.ATTACK;cpu.state[id*C.CWORDS+C.CTARGET]=299;cpu.state[id*C.CWORDS+C.CAMMO]=mode==='fire'?6:0;
      }
      if(mode==='release'){
        for(let id=300;id<320;id++)air.state[id*AIR_WORDS+ACONTACT]=id-300;
        // The first plane releases an occupied pad inside the ordered pass. Later planes
        // must see it even though speculative candidates found every pad occupied.
        cpu.state[300*C.CWORDS+C.CMISSION]=C.MOVE;cpu.movement.goals[300]=units[300].cell+1;
      }
      for(const [buffer,source] of [[gpu.units,cpu.units],[gpu.state,cpu.state],[gpu.movement.goals,cpu.movement.goals],[flight.state,air.state]] as const){(buffer.array as Int32Array).set(source);buffer.needsUpdate=true;}
      reference.before();ops.before();
      for(const [buffer,source,name] of [[gpu.units,cpu.units,'units'],[gpu.state,cpu.state,'combat'],[gpu.movement.goals,cpu.movement.goals,'goals'],[flight.state,air.state,'aircraft']] as const)
        equal(new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),source,`Mass ${mode} ${name}`);
      if(measure){
        const backend=wrapper.three.backend as unknown as {trackTimestamp:boolean};
        const values=[gpu.units,gpu.state,gpu.movement.goals,flight.state].map(b=>(b.array as Int32Array).slice());
        await wrapper.three.compileComputeAsync(ops.beforePass);backend.trackTimestamp=true;measured[mode]=[];
        for(let sample=0;sample<6;sample++){
          [gpu.units,gpu.state,gpu.movement.goals,flight.state].forEach((b,i)=>{(b.array as Int32Array).set(values[i]);b.needsUpdate=true;});
          ops.before();const ms=await wrapper.three.resolveTimestampsAsync('compute');if(sample)measured[mode].push(ms??0);
        }
        backend.trackTimestamp=false;
      }
      if(mode!=='fire'){
        const contacts=Array.from({length:200},(_,i)=>air.state[(300+i)*AIR_WORDS+ACONTACT]).filter(id=>id>=0);
        if(contacts.length!==20||new Set(contacts).size!==20)throw new Error('Returning aircraft did not reserve twenty distinct helipads');
      }
    }
    return measure?measured:true;
  }finally{ops.dispose();flight.dispose();gpu.dispose();wrapper.dispose();canvas.remove();}
}
