import { createRenderer } from '../src/engine/renderer.ts';
import { gridEdges, DIRECTIONS } from '../src/engine/simulation/state.ts';
import { GpuFlowFields } from '../src/engine/simulation/flow.ts';
import { StorageBufferAttribute } from 'three/webgpu';
import { releaseStorage } from '../src/engine/simulation/resources.ts';
import { CpuUnits } from '../src/game/simulation/units-cpu.ts';
import { GpuUnits } from '../src/game/simulation/units-gpu.ts';
import { CpuSight,GpuSight } from '../src/game/simulation/sight.ts';
import { movementType } from '../src/game/data/movement.ts';
import { loadData } from '../src/game/data-files.ts';
import { unitsScene } from '../src/game/simulation/units-scene.ts';
import { GpuSelection } from '../src/game/simulation/selection.ts';
import { groundLayout,GpuGround,groundSprites,updateGroundKeys,bubbleGround } from '../src/game/simulation/ground.ts';
import { PalettePipeline } from '../src/engine/indexed/pipeline.ts';
import { paint } from './reference/paint.ts';
import * as S from '../src/game/simulation/units-state.ts';
import { checkM3Regressions, measureM3Gpu } from './m3-regressions.ts';

function equal(a:ArrayLike<number>,b:ArrayLike<number>,message:string){
  if(a.length!==b.length)throw new Error(`${message}: lengths ${a.length}/${b.length}`);
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])throw new Error(`${message}: word ${i}: ${a[i]} != ${b[i]}`);
}

export async function compareUnits(){
  const canvas=document.createElement('canvas');canvas.style.cssText='width:16px;height:16px';document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('No WebGPU');
  const renderer=wrapper.three;
  try{
    const open=gridEdges(16,9,new Uint8Array(144).fill(1),true);
    for(const names of [['MTNK'],['E1'],['MTNK','JEEP','E1','E1','HTNK']]){
      const setup:S.UnitsSetup={grid:open,land:new Uint8Array(144),seed:0x1995,
        units:names.map((name,i)=>({cell:17+i*16,type:movementType(name),facing:i%2?64:0}))};
      const cpu=new CpuUnits(setup),gpu=new GpuUnits(renderer,setup),replay=new GpuUnits(renderer,setup);
      const cpuSight=new CpuSight(16,9,names.length),gpuSight=new GpuSight(renderer,16,9,gpu.units);
      cpuSight.step(cpu.units);
      try{
        for(let frame=1;frame<=100;frame++){
          const commands:S.UnitCommand[]=frame===1?names.map((_,i)=>({frame,kind:'move',target:30+(i%2)*80,ids:[i]})):
            frame===40?[{frame,kind:'move',target:113,ids:[0]}]:frame===70?[{frame,kind:'scatter',ids:[0]}]:[];
          cpu.step(commands);gpu.step(commands);replay.step(commands);cpuSight.step(cpu.units);gpuSight.step();
          if([1,2,3,16,39,40,60,70,100].includes(frame)){
            const actual=await gpu.snapshot(),expected=cpu.buffers();actual.forEach((value,i)=>equal(value,expected[i],`${names} tick ${frame} buffer ${i}`));
            equal(await gpu.checksum(),cpu.checksum(),`${names} checksum ${frame}`);equal(await gpu.checksum(),await replay.checksum(),`${names} replay ${frame}`);
            equal(new Int32Array(await renderer.getArrayBufferAsync(gpuSight.mapped)),cpuSight.mapped,`mapped ${frame}`);
            equal(new Int32Array(await renderer.getArrayBufferAsync(gpuSight.current)),cpuSight.current,`current sight ${frame}`);
            equal(new Int32Array(await renderer.getArrayBufferAsync(gpuSight.shadow)),cpuSight.shadow,`shroud edges ${frame}`);
          }
        }
        const selection=new GpuSelection(renderer,gpu,gpuSight);
        try{
          selection.apply({action:'box',x:0,y:0,x2:4096,y2:2304});const selected=await selection.read();
          if(selected[1]!==names.length)throw new Error('Box selection missed owned units');
          selection.apply({action:'group',group:0,modifier:2});selection.apply({action:'clear'});
          selection.apply({action:'group',group:0});if((await selection.read())[1]!==names.length)throw new Error('Group recall missed units');
        }finally{selection.dispose();}
      }finally{gpuSight.dispose();gpu.dispose();replay.dispose();}
    }
    const data=await loadData(false,true),{scene,setup,passable}=unitsScene(data);
    const regressions=await checkM3Regressions(renderer,scene,data,setup);
    const cpu=new CpuUnits(setup),gpu=new GpuUnits(renderer,setup),layout=groundLayout(scene,cpu.units,S.WORDS);
    const max=scene.sprites.reduce((m,s)=>({maxWidth:Math.max(m.maxWidth,s.region.width),maxHeight:Math.max(m.maxHeight,s.region.height)}),{maxWidth:1,maxHeight:1});
    const pipeline=new PalettePipeline(renderer,{...scene.setup,spriteCapacity:layout.count+1,dynamicSprites:max});
    const ground=new GpuGround(renderer,gpu,pipeline,layout,scene),keys=layout.keys.slice(),order=Uint32Array.from({length:keys.length/2},(_,i)=>i);
    const goals=Array.from(passable.keys()).filter(i=>passable[i]);
    const reachable=(origin:number)=>{
      const list=[origin],seen=new Set(list);
      for(let i=0;i<list.length;i++)for(let d=0;d<8;d++)if(setup.grid.edges[list[i]]&(1<<d)){
        const [dx,dy]=DIRECTIONS[d],cell=list[i]+dy*setup.grid.width+dx;
        if(!seen.has(cell)){seen.add(cell);list.push(cell);}
      }
      return list;
    };
    const nearby=reachable(setup.units[0].cell).find(cell=>cell!==setup.units[0].cell&&!setup.units.some(u=>u.cell===cell))!;
    const far1=reachable(setup.units[1].cell).at(-1)!,far2=reachable(setup.units[2].cell).at(-3)!;
    try{
      for(let frame=1;frame<=90;frame++){
        const commands:S.UnitCommand[]=frame===1?[
          {frame,kind:'move',target:goals[Math.floor(goals.length/2)],ids:setup.units.map((_,i)=>i)},
          {frame,kind:'move',target:nearby,ids:[0]},
          {frame,kind:'move',target:far1,ids:[1]},
          {frame,kind:'move',target:far2,ids:[2]},
        ]:
          frame===35?[{frame,kind:'move',target:goals[Math.floor(goals.length/3)],ids:[0,1,2,3,4,5]}]:[];
        updateGroundKeys(layout,cpu.units,keys);bubbleGround(order,keys);ground.sort();cpu.step(commands);gpu.step(commands);ground.updateSprites();
        if([1,2,3,16,35,60,90].includes(frame)){
          const actual=await gpu.snapshot();actual.forEach((v,i)=>equal(v,cpu.buffers()[i],`scg08eb ${frame}/${i}`));
          if(frame===2)for(const id of [0,1,2]){
            const at=id*S.WORDS;
            // Main_Loop runs Queue_AI after Logic.AI. Start_Of_Move must obtain its
            // path on the next tick, even for a destination across the original map.
            if(actual[1][at+S.USTARTED]!==2 && actual[1][at+S.UDESIRED]===actual[1][at+S.UFACE])
              throw new Error(`scg08eb command for unit ${id} waited for its distance field`);
          }
          equal(new Uint32Array(await renderer.getArrayBufferAsync(ground.order.order)),order,`scg08eb order ${frame}`);
          const first=setup.units[0].cell,view={x:(first%64)*24-72,y:Math.floor(first/64)*24-72,width:200,height:180};
          const pending=pipeline.readIndices(view);equal(await pending,paint(scene,groundSprites(scene,layout,cpu.units,order),view,frame,true),`animated pixels ${frame}`);
        }
      }
    }finally{ground.dispose();pipeline.dispose();gpu.dispose();}

    const width=256,passableLarge=new Uint8Array(width*width).fill(1);
    for(let y=0;y<254;y++)passableLarge[y*width+128]=0;
    const goalsLarge=new StorageBufferAttribute(new Int32Array([-1]),1);
    const large=new GpuFlowFields(renderer,gridEdges(width,width,passableLarge,true),goalsLarge);
    (goalsLarge.array as Int32Array)[0]=20*width+220;goalsLarge.needsUpdate=true;
    let ticks=0;const start=performance.now();
    try{
      while(ticks<100){large.step();ticks++;const fields=new Int32Array(await renderer.getArrayBufferAsync(large.fields));if(fields[1])break;}
      if(ticks===100)throw new Error('Large detour field did not converge');
      const adapter=await navigator.gpu.requestAdapter();
      const largeGridMilliseconds=performance.now()-start,gpu=await measureM3Gpu(renderer);
      return {largeGridTicks:ticks,largeGridMilliseconds,regressions,gpu,adapter:adapter && {vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description}};
    }finally{large.dispose();releaseStorage(renderer,[goalsLarge]);}
  }finally{wrapper.dispose();canvas.remove();}
}
