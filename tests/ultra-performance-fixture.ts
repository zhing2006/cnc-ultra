import { mount } from 'svelte';
import { PalettePipeline } from '../src/engine/indexed/pipeline.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { GpuSelection } from '../src/game/simulation/selection.ts';
import { CombatAudio } from '../src/game/simulation/combat-audio.ts';
import { WORDS, UHEALTH, UDOMAIN } from '../src/game/simulation/units-state.ts';
import type { WebGPURenderer } from 'three/webgpu';
import { SimulationDriver } from '../src/engine/simulation/driver.ts';

let battle: GpuCombat, pipeline: PalettePipeline, selection: GpuSelection;
let collect: number[] | undefined;
let notifyFrame: (()=>void)|undefined;
let mixer:CombatAudio,peakSounds=0,peakSameSound=0;
let driver:SimulationDriver;

/** Mount the actual Ultra screen; diagnostic hooks stay outside production code. */
export async function mountUltraPreview() {
  const prepare=GpuCombat.prototype.prepareStep,draw=PalettePipeline.prototype.render,select=GpuSelection.prototype.apply,soundUpdate=CombatAudio.prototype.update,advance=SimulationDriver.prototype.advance;
  SimulationDriver.prototype.advance=function(now){driver=this;return advance.call(this,now);};
  GpuCombat.prototype.prepareStep=function(){battle=this;return prepare.call(this);};
  GpuSelection.prototype.apply=function(command){selection=this;return select.call(this,command);};
  CombatAudio.prototype.update=function(...args){mixer=this;return soundUpdate.apply(this,args);};
  PalettePipeline.prototype.render=function(...args){
    pipeline=this;collect?.push(performance.now());
    if(collect&&mixer){
      const playing=(mixer as unknown as {playing:Set<{sound:number}>}).playing,counts=new Map<number,number>();
      peakSounds=Math.max(peakSounds,playing.size);
      for(const item of playing){const count=(counts.get(item.sound)??0)+1;counts.set(item.sound,count);peakSameSound=Math.max(peakSameSound,count);}
    }
    const result=draw.apply(this,args);notifyFrame?.();notifyFrame=undefined;return result;
  };
  const App=(await import('../src/UltraApp.svelte')).default;
  mount(App,{target:document.body});
}
const summary=(values:number[])=>{
  const sorted=[...values].sort((a,b)=>a-b),mean=values.reduce((a,b)=>a+b,0)/values.length;
  return {samples:values.length,mean,p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)!};
};
const nextFrame=()=>new Promise<void>(resolve=>{notifyFrame=resolve;});
async function liveUnits(){const units=new Int32Array(await battle.renderer.getArrayBufferAsync(battle.units));let count=0;
  for(let at=0;at<units.length;at+=WORDS)if(units[at+UHEALTH]>0&&units[at+UDOMAIN]!==2)count++;return count;}

export async function measureUltraFrames(frames=600){
  const aliveBefore=await liveUnits(),startTick=battle.frame;
  collect=[];peakSounds=peakSameSound=0;
  while(collect.length<frames+1)await nextFrame();
  const times=collect;collect=undefined;
  const intervals=times.slice(1).map((time,i)=>time-times[i]),frameMs=summary(intervals);
  const drain=performance.now();await (battle.renderer.backend as unknown as {device:GPUDevice}).device.queue.onSubmittedWorkDone();
  return {frames:intervals.length,startTick,endTick:battle.frame,aliveBefore,aliveAfter:await liveUnits(),frameMs,fps:1000/frameMs.mean,
    simulationSpeed:(battle.frame-startTick)*1000/(15*(times.at(-1)!-times[0])),queueDrainMs:performance.now()-drain,
    audio:{state:(mixer as unknown as {context:AudioContext}).context.state,peakSounds,peakSameSound}};
}

export async function measureUltraGpu(){
  const renderer=battle.renderer,backend=renderer.backend as unknown as {device:GPUDevice;trackTimestamp:boolean;
    beginRender(context:unknown):void;getTimestampUID(context:unknown):string;
    timestampQueryPool:{compute?:{timestamps:Map<string,number>};render?:{timestamps:Map<string,number>}}};
  if(!backend.device.features.has('timestamp-query'))throw new Error('Ultra acceptance requires GPU timestamp queries');
  const sprites=(pipeline as unknown as {spriteMesh:unknown}).spriteMesh;
  const render=renderer.render.bind(renderer),begin=backend.beginRender.bind(backend),labels=new Set<string>();
  let spritePass=false;
  renderer.render=((...args:Parameters<WebGPURenderer['render']>)=>{spritePass=args[0]===sprites;try{return render(...args);}finally{spritePass=false;}}) as typeof renderer.render;
  backend.beginRender=context=>{if(spritePass)labels.add(backend.getTimestampUID(context));return begin(context);};
  const computeMs:number[]=[],renderMs:number[]=[],spriteMs:number[]=[],tickBefore=battle.frame;
  const animation=renderer.getAnimationLoop()!;await renderer.setAnimationLoop(null);
  driver.setPaused(true);
  const scheduling=driver as unknown as {waiting:boolean;queued:boolean;tick():void|false|Promise<void>};
  while(scheduling.waiting||scheduling.queued)await new Promise(resolve=>setTimeout(resolve,0));
  backend.trackTimestamp=true;
  try{
    const origin=performance.now();
    for(let i=0;i<60;i++){
      backend.timestampQueryPool.compute?.timestamps.clear();backend.timestampQueryPool.render?.timestamps.clear();
      // Isolate one complete logic tick and its drawing from asynchronous catch-up.
      await scheduling.tick();
      animation(origin+(i+1)*1000/15);
      await Promise.all([renderer.resolveTimestampsAsync('compute'),renderer.resolveTimestampsAsync('render')]);
      const compute=Array.from(backend.timestampQueryPool.compute?.timestamps.values()??[]).reduce((sum,ms)=>sum+ms,0);
      const renderTime=Array.from(backend.timestampQueryPool.render?.timestamps.values()??[]).reduce((sum,ms)=>sum+ms,0);
      const sprite=Array.from(backend.timestampQueryPool.render?.timestamps??[]).filter(([id])=>labels.has(id)).reduce((sum,[,ms])=>sum+ms,0);
      if(i>=10){computeMs.push(compute);renderMs.push(renderTime);spriteMs.push(sprite);}
    }
    const commands:Record<string,number>={};
    for(const action of ['box','group','move','stop'] as const){
      await renderer.resolveTimestampsAsync('compute');
      selection.apply(action==='box'?{action:'box',x:0,y:0,x2:battle.setup.grid.width*256,y2:battle.setup.grid.height*256}:
        action==='group'?{action:'group',group:4,modifier:2}:action==='move'?{action:'point',x:384,y:384}:{action:'stop'});
      await renderer.resolveTimestampsAsync('compute');
      commands[action]=Array.from(backend.timestampQueryPool.compute?.timestamps.values()??[]).reduce((sum,ms)=>sum+ms,0);
    }
    return {ticks:battle.frame-tickBefore,computeMs:summary(computeMs),renderMs:summary(renderMs),spriteMs:summary(spriteMs),commands,
      spriteInstances:(pipeline as unknown as {spriteGeometry:{instanceCount:number}}).spriteGeometry.instanceCount,
      slots:battle.setup.units.length,flowBytes:battle.ultraHunt!.flow.saveBuffers.reduce((sum,buffer)=>sum+buffer.array.byteLength,0)};
  }finally{backend.trackTimestamp=false;renderer.render=render;backend.beginRender=begin;driver.setPaused(false);await renderer.setAnimationLoop(animation);}
}
