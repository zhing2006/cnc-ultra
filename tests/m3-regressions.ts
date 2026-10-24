import { StorageBufferAttribute, type WebGPURenderer } from 'three/webgpu';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { CpuFlowFields, GpuFlowFields } from '../src/engine/simulation/flow.ts';
import { releaseStorage } from '../src/engine/simulation/resources.ts';
import { CpuUnits } from '../src/game/simulation/units-cpu.ts';
import { GpuUnits } from '../src/game/simulation/units-gpu.ts';
import { GpuSight } from '../src/game/simulation/sight.ts';
import { GpuSelection } from '../src/game/simulation/selection.ts';
import { UnitsView } from '../src/game/simulation/units-view.ts';
import { movementType } from '../src/game/data/movement.ts';
import type { GameScene } from '../src/game/scene.ts';
import type { MixSet } from '../src/game/formats/mix.ts';
import * as S from '../src/game/simulation/units-state.ts';
import { PalettePipeline, type Sprite } from '../src/engine/indexed/pipeline.ts';
import { paint } from './reference/paint.ts';
import { GpuGround, groundLayout } from '../src/game/simulation/ground.ts';
import { packUnitScenarios, type UnitScenario } from './unit-scenarios.ts';

function equal(actual: ArrayLike<number>, expected: ArrayLike<number>, label: string) {
  if (actual.length !== expected.length) throw new Error(`${label}: different lengths`);
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i])
    throw new Error(`${label}: word ${i}: ${actual[i]} != ${expected[i]}`);
}

export async function checkM3Regressions(renderer: WebGPURenderer, scene: GameScene, data: MixSet, army: S.UnitsSetup) {
  const tank = movementType('MTNK'), infantry = movementType('E1');
  const open = gridEdges(8, 8, new Uint8Array(64).fill(1), true);
  const blocked = new Uint8Array(64).fill(1);
  for (let y = 0; y < 8; y++) blocked[y * 8 + 4] = 0;
  const corner = new Uint8Array(64);
  for (const cell of [42, 34, 27, 28, 29]) corner[cell] = 1;
  const cliff = new Uint8Array(144).fill(1); cliff[72] = 0;
  const deepCliff = new Uint8Array(144).fill(1);
  for(let y=3;y<=5;y++)for(let x=7;x<=9;x++)deepCliff[y*16+x]=0;
  const crossing = new Uint8Array(256).fill(1);
  const bridge = new Uint8Array(24*12).fill(1);
  for (let y=0;y<12;y++) if(y!==6)bridge[y*24+12]=0;
  const group:S.UnitPlacement[]=[
    {cell:99,type:tank,facing:64},{cell:123,type:movementType('HTNK'),facing:64},
    {cell:147,type:movementType('JEEP'),facing:64},{cell:171,type:movementType('APC'),facing:64},
    ...Array.from({length:10},(_,id)=>({cell:(5+Math.floor(id/5))*24+2,type:infantry,slot:id%5,facing:64})),
  ];
  const corridor=new Uint8Array(20*5);corridor.fill(1,40,60);
  const lake=new Uint8Array(30*9).fill(1);
  for(let y=0;y<9;y++)for(let x=20;x<30;x++)lake[y*30+x]=0;
  lake[4*30+8]=0;
  const scenarios: UnitScenario[] = [
    {label:'shore beyond an intervening tree',setup:{grid:gridEdges(30,9,lake,true),passable:lake,land:new Uint8Array(270),seed:1995,
      units:[{cell:122,type:tank,facing:64}]},targets:[145],ticks:1600,interval:200,settleAt:1600},
    {label:'opposing traffic in an impassable corridor',setup:{grid:gridEdges(20,5,corridor,true),passable:corridor,
      land:new Uint8Array(100),seed:0x1995,units:[{cell:43,type:tank,facing:64},{cell:56,type:tank,facing:192}]},
      targets:[59,40],ticks:2600,interval:200,settleAt:2000},
    {label:'infantry short source-cell step',setup:{grid:open,land:new Uint8Array(64),seed:1995,
      units:[{cell:17,type:infantry,slot:1,facing:64}]},targets:[19],ticks:120},
    { label:'cliff from opposite sides',setup:{grid:gridEdges(16,9,cliff,true),passable:cliff,land:new Uint8Array(144),seed:1995,
      units:[{cell:66,type:tank,facing:64},{cell:78,type:tank,facing:192}]},targets:[72,72],ticks:500 },
    { label:'occupied cliff neighbor',setup:{grid:gridEdges(16,9,cliff,true),passable:cliff,land:new Uint8Array(144),seed:1995,
      units:[{cell:66,type:tank,facing:64},{cell:71,type:tank}]},targets:[72],ticks:300 },
    { label:'near cliff',setup:{grid:gridEdges(16,9,cliff,true),passable:cliff,land:new Uint8Array(144),seed:1995,
      units:[{cell:71,type:tank,facing:64}]},targets:[72],ticks:30 },
    { label:'near cliff prefix',setup:{grid:gridEdges(16,9,cliff,true),passable:cliff,land:new Uint8Array(144),seed:1995,
      units:[{cell:70,type:tank,facing:64}]},targets:[72],ticks:90 },
    { label:'deep cliff prefix',setup:{grid:gridEdges(16,9,deepCliff,true),passable:deepCliff,land:new Uint8Array(144),seed:1995,
      units:[{cell:66,type:tank,facing:64}]},targets:[72],ticks:300 },
    { label:'four-way traffic',setup:{grid:gridEdges(16,16,crossing,true),land:new Uint8Array(256),seed:1995,
      units:[{cell:85,type:tank,facing:64},{cell:86,type:tank,facing:128},{cell:102,type:tank,facing:192},{cell:101,type:tank,facing:0}]},
      targets:[90,166,97,21],ticks:500 },
    { label:'mixed group through one-cell opening',setup:{grid:gridEdges(24,12,bridge,true),passable:bridge,land:new Uint8Array(288),seed:1995,
      units:group},targets:new Array(group.length).fill(165),ticks:2800,interval:200,settleAt:2200 },
    { label: 'infantry reservations', setup: { grid: open, land: new Uint8Array(64), seed: 1995,
      units: Array.from({ length: 5 }, (_, slot) => ({ cell: 17, type: infantry, slot, facing: 64 })) }, targets: [18,18,18,18,18], ticks: 40 },
    { label: 'opposing traffic', setup: { grid: open, land: new Uint8Array(64), seed: 1995,
      units: [{ cell: 18, type: tank, facing: 64 }, { cell: 19, type: tank, facing: 192 }] }, targets: [22,16], ticks: 300 },
    { label: 'unreachable order', setup: { grid: gridEdges(8,8,blocked,true), land: new Uint8Array(64), seed: 1995,
      units: [{ cell: 17, type: tank, facing: 64 }] }, targets: [22], ticks: 180 },
    { label: 'track jump', setup: { grid: gridEdges(8,8,corner,true), land: new Uint8Array(64), seed: 1995,
      units: [{ cell: 42, type: tank, facing: 0 }] }, targets: [29], ticks: 140 },
  ];
  for(const [count,name] of [[16,'MTNK'],[12,'JEEP'],[30,'E1']] as const){
    scenarios.push({label:`${count} ${name} settle at a shared target`,
      setup:{grid:gridEdges(40,24,new Uint8Array(960).fill(1),true),land:new Uint8Array(960),seed:0x1995,
        units:Array.from({length:count},(_,id)=>({cell:(4+(id%4)*2)*40+3+Math.floor(id/4)*2,type:movementType(name),facing:64}))},
      targets:new Array(count).fill(510),ticks:3600,interval:200,settleAt:3000});
  }
  const retained:GpuUnits[]=[];
  const worlds=packUnitScenarios(scenarios);
  const timing={initializeMs:0,advanceMs:0,readMs:0,ticks:0,scenarios:scenarios.length,worlds:worlds.length};
  try {
    for (const { setup,cases,commands } of worlds) {
      let start=performance.now();
      const cpu = new CpuUnits(setup), gpu = new GpuUnits(renderer, setup);retained.push(gpu);
      timing.initializeMs+=performance.now()-start;
      const stopped=new Map<string,number[]>(),ticks=Math.max(...cases.map(c=>c.ticks));
      for (let frame = 1; frame <= ticks; frame++) {
        start=performance.now();
        cpu.step(frame===1?commands:[]);
        if(frame===1)gpu.step(commands);
        for(const {label,ids,settleAt,ticks:end} of cases)if(settleAt && frame>=settleAt && frame<=end){
          equal(ids.map(id=>cpu.goals[id]),new Int32Array(ids.length).fill(-1),`${label}: finished orders`);
          const destinations=ids.map(id=>cpu.units[id*S.WORDS+S.UDEST]);
          equal(destinations,new Int32Array(ids.length).fill(-1),`${label}: stopped movement`);
          const positions=ids.flatMap(id=>[cpu.units[id*S.WORDS],cpu.units[id*S.WORDS+1]]),previous=stopped.get(label);
          if(previous)equal(positions,previous,`${label}: remains stopped`);else stopped.set(label,positions);
        }
        const sample=frame===2||cases.some(c=>frame<=c.ticks&&(frame%(c.interval??20)===0||frame===c.ticks));
        if(sample)gpu.stepMany(frame-gpu.frame);
        timing.advanceMs+=performance.now()-start;
        if (sample) {
          start=performance.now();
          const actual = await gpu.snapshot();
          actual.forEach((array,i) => equal(array,cpu.buffers()[i],`packed world ${retained.length}, tick ${frame}, buffer ${i}`));
          timing.readMs+=performance.now()-start;
        }
      }
      timing.ticks+=ticks;
    }
  } finally { for(const gpu of retained)gpu.dispose(); }
  // The CPU tests establish the original movement rules; these exercise actual GPU UI commands.
  const passable = new Uint8Array(144).fill(1); passable[35] = 0;
  const setup: S.UnitsSetup = { grid: gridEdges(16,9,passable,true), passable, land: new Uint8Array(144), seed: 1995,
    units: [{cell:34,type:tank},{cell:66,type:tank}] };
  const gpu = new GpuUnits(renderer,setup), sight = new GpuSight(renderer,16,9,gpu.units);
  const selection = new GpuSelection(renderer,gpu,sight), view = new UnitsView(renderer,gpu,sight,selection,scene,data);
  const point = (cell:number) => ({x:(cell%16)*256+128,y:Math.floor(cell/16)*256+128});
  try {
    const before = await gpu.checksum();
    selection.apply({action:'box',x:0,y:0,x2:4096,y2:2304});
    selection.apply({action:'point',...point(34)});
    const result = await selection.read();
    equal([result[1],result[2]],[2,0],'clicking a selected unit keeps the group and remains silent');
    selection.apply({action:'group',group:2,modifier:2});
    equal(await gpu.checksum(),before,'local selection and control groups do not change the simulation checksum');
    selection.apply({action:'point',...point(35)});
    equal([(await selection.read())[2]],[2],'forbidden terrain still acknowledges a move command');
    const local = new Int32Array(await renderer.getArrayBufferAsync(selection.state));
    equal([local[selection.flashOffset+3]],[0],'ACTION_NOMOVE does not create a move flash');
    gpu.step();equal((await gpu.snapshot())[2],new Int32Array([35,35]),'ACTION_NOMOVE reaches both units');
    for (const [cell,cursor] of [[35,11],[36,10],[143,10]]) {
      view.pointer.value.set((cell%16)*24+12,Math.floor(cell/16)*24+12); view.update();
      equal([new Int32Array(await renderer.getArrayBufferAsync(view.hovered))[3]],[cursor],`original cursor at ${cell}`);
    }
    selection.apply({action:'point',...point(36)});
    const flash = new Int32Array(await renderer.getArrayBufferAsync(selection.state)).subarray(selection.flashOffset);
    equal(flash,new Int32Array([point(36).x,point(36).y,1,1]),'ACTION_MOVE records the exact local flash position and tick');
  } finally { view.dispose(); selection.dispose(); sight.dispose(); gpu.dispose(); }

  // Independent forward drawing follows ANIM.CPP and the original TWHITE.MRF mapping.
  // Check normal sprites and shadows on both sides of the white translucent animation.
  const pipeline=new PalettePipeline(renderer,{...scene.setup,spriteCapacity:4});
  const imageView={x:(scene.home%64)*24-32,y:Math.floor(scene.home/64)*24-32,width:96,height:96};
  const tankRegion=scene.animation!.frames.get('MTNK')![0],flashRegion=scene.animation!.frames.get('MOVEFLSH')![1];
  const base:Sprite={x:imageView.x+25,y:imageView.y+25,region:tankRegion,remap:scene.plainRemap,shadow:true};
  const flash:Sprite={...base,x:imageView.x+34,y:imageView.y+32,region:flashRegion,shadow:false,filter:1};
  try {
    for(const sprites of [[base,flash,{...base,x:base.x+10,y:base.y+8}],[flash,base]]){
      pipeline.setSprites(sprites);
      equal(await pipeline.readIndices(imageView),paint(scene,sprites,imageView,0),'original white move flash composition');
    }
  } finally {pipeline.dispose();}

  const armyState=S.initialUnits(army),armyBuffer=new StorageBufferAttribute(armyState,1);
  const markerX=armyState[0]+256,markerY=armyState[1];
  const marker=new StorageBufferAttribute(new Int32Array([markerX,markerY,0,1]),1);
  const tick=new StorageBufferAttribute(new Int32Array([1,army.seed]),1),simulation={units:armyBuffer,frame:1};
  const layout=groundLayout(scene,armyState,S.WORDS,true);
  const maxSize=scene.sprites.reduce((size,s)=>Math.max(size,s.region.width,s.region.height),24);
  const animated=new PalettePipeline(renderer,{...scene.setup,spriteCapacity:layout.count,
    dynamicSprites:{maxWidth:maxSize,maxHeight:maxSize}});
  const ground=new GpuGround(renderer,simulation,animated,layout,scene,{state:marker,offset:0,clock:tick});
  try {
    const order=new Uint32Array(await renderer.getArrayBufferAsync(ground.order.order));
    const slot=layout.first+order.indexOf(layout.flashId)*layout.slots;
    for(const frame of [1,3,6]){
      (tick.array as Int32Array)[0]=frame;tick.needsUpdate=true;simulation.frame=frame;ground.updateSprites();
      const sprites=new Float32Array(await renderer.getArrayBufferAsync(animated.spriteBuffer));
      if(frame===6)equal(sprites.subarray(slot*12+2,slot*12+4),[0,0],'move flash expires after its five original stages');
      else {
        const region=scene.animation!.frames.get('MOVEFLSH')![frame-1];
        equal(sprites.subarray(slot*12,slot*12+6),[
          Math.floor((markerX*24+128)/256)-Math.floor(region.width/2),
          Math.floor((markerY*24+128)/256)-Math.floor(region.height/2),region.width,region.height,region.x,region.y,
        ],`queued move flash stage ${frame-1}`);
      }
    }
  } finally {ground.dispose();animated.dispose();releaseStorage(renderer,[armyBuffer,marker,tick]);}

  const grid = gridEdges(16,16,new Uint8Array(256).fill(1),true), goals = Int32Array.from({length:20000},(_,i)=>i%100);
  const attribute = new StorageBufferAttribute(goals,1), cpu = new CpuFlowFields(grid,goals.length), flow = new GpuFlowFields(renderer,grid,attribute);
  const served = new Set<number>();
  try {
    cpu.step(goals); // The GPU constructor performs its initial reconciliation.
    for (let tick=0;tick<4;tick++) {
      cpu.step(goals);flow.step();
      const actual=await Promise.all(flow.buffers().map(async buffer=>new Int32Array(await renderer.getArrayBufferAsync(buffer))));
      actual.forEach((array,i)=>equal(array,cpu.buffers()[i],`bounded pool ${tick}/${i}`));
      for(let target=0;target<100;target++)if(actual[1][target]>=0)served.add(target);
    }
    if(served.size!==100)throw new Error('Pool pressure starved a destination');
    if(flow.distance.array.byteLength>16*1024*1024)throw new Error('Flow storage exceeded its per-buffer budget');
  } finally { flow.dispose();releaseStorage(renderer,[attribute]); }
  // Unaligned tile edges and a detour exercise partial fields before convergence.
  const tileWidth=67,tileHeight=65,tilePassable=new Uint8Array(tileWidth*tileHeight).fill(1);
  for(let y=0;y<60;y++)tilePassable[y*tileWidth+31]=0;
  const tileGrid=gridEdges(tileWidth,tileHeight,tilePassable,true);
  const tileGoals=new StorageBufferAttribute(new Int32Array([10*tileWidth+55,50*tileWidth+12]),1);
  const tileCpu=new CpuFlowFields(tileGrid,2),tileGpu=new GpuFlowFields(renderer,tileGrid,tileGoals);
  try {
    for(let tick=0;tick<7;tick++){
      if(tick===4){(tileGoals.array as Int32Array)[0]=2*tileWidth+3;tileGoals.needsUpdate=true;}
      tileCpu.step(tileGoals.array as Int32Array);if(tick)tileGpu.step();
      const actual=await Promise.all(tileGpu.buffers().map(async b=>new Int32Array(await renderer.getArrayBufferAsync(b))));
      actual.forEach((a,i)=>equal(a,tileCpu.buffers()[i],`tile flow tick ${tick}, buffer ${i}`));
    }
  } finally {tileGpu.dispose();releaseStorage(renderer,[tileGoals]);}
  return timing;
}

/** Diagnostic timestamps exclude CPU submission, compilation, and status readback. */
export async function measureM3Gpu(renderer: WebGPURenderer) {
  const backend=renderer.backend as unknown as {trackTimestamp:boolean;device:GPUDevice};
  if(!backend.device.features.has('timestamp-query'))return {supported:false};
  const width=256,passable=new Uint8Array(width*width).fill(1);
  for(let y=0;y<254;y++)passable[y*width+128]=0;
  const goals=new StorageBufferAttribute(new Int32Array(20000).fill(-1),1);
  const flow=new GpuFlowFields(renderer,gridEdges(width,width,passable,true),goals);
  await renderer.getArrayBufferAsync(flow.fields);
  (goals.array as Int32Array).fill(20*width+220);goals.needsUpdate=true;
  backend.trackTimestamp=true;
  const flowGpuMs:number[]=[];
  try {
    for(let tick=0;tick<100;tick++){
      flow.step();flowGpuMs.push((await renderer.resolveTimestampsAsync('compute'))!);
      const fields=new Int32Array(await renderer.getArrayBufferAsync(flow.fields));if(fields[1])break;
    }
    flow.step();const cachedFlowGpuMs=await renderer.resolveTimestampsAsync('compute');
    const units=new Int32Array(10000*S.WORDS);
    for(let id=0;id<10000;id++){
      const at=id*S.WORDS;units[at]=((id%125)*2+2)*256+128;units[at+1]=(Math.floor(id/125)*2+2)*256+128;
      units[at+S.UTYPE]=movementType('MTNK');units[at+S.UHEALTH]=400;
    }
    backend.trackTimestamp=false;
    const attribute=new StorageBufferAttribute(units,1),sight=new GpuSight(renderer,width,width,attribute);
    await renderer.getArrayBufferAsync(sight.current);
    backend.trackTimestamp=true;
    try {
      sight.step();const stationarySightGpuMs=await renderer.resolveTimestampsAsync('compute');
      for(let id=0;id<10000;id++)units[id*S.WORDS]+=256;
      attribute.needsUpdate=true;sight.step();const movingSightGpuMs=await renderer.resolveTimestampsAsync('compute');
      return {supported:true,units:20000,flowCapacity:flow.capacity,flowBytesPerBuffer:flow.distance.array.byteLength,
        flowGpuMs,cachedFlowGpuMs,sightUnits:10000,stationarySightGpuMs,movingSightGpuMs};
    } finally {sight.dispose();releaseStorage(renderer,[attribute]);}
  } finally {backend.trackTimestamp=false;flow.dispose();releaseStorage(renderer,[goals]);}
}
