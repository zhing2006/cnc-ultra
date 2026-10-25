import { releaseStorage } from '../src/engine/simulation/resources.ts';
import { createRenderer } from '../src/engine/renderer.ts';
import { StorageBufferAttribute } from 'three/webgpu';
import { CpuTiberium, type TiberiumSetup } from '../src/game/simulation/tiberium-cpu.ts';
import { GpuTiberium } from '../src/game/simulation/tiberium-gpu.ts';
import { CpuUnits } from '../src/game/simulation/units-cpu.ts';
import { GpuUnits } from '../src/game/simulation/units-gpu.ts';
import { CpuAircraft } from '../src/game/simulation/aircraft-cpu.ts';
import { GpuAircraft } from '../src/game/simulation/aircraft-gpu.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { WORDS, UALTITUDE } from '../src/game/simulation/units-state.ts';
import { loadData } from '../src/game/data-files.ts';
import { economyScene } from '../src/demo/economy-scene.ts';
import { EconomyRuntime,BUILDING_WORDS } from '../src/game/simulation/economy-runtime.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { applyLifecycle } from '../src/game/simulation/lifecycle-cpu.ts';
import { GpuLifecycle } from '../src/game/simulation/lifecycle-gpu.ts';
import { GpuHarvest } from '../src/game/simulation/harvest-gpu.ts';
import { stepHarvest,initialHarvest,HBASE,HWORDS,HGEN,HMODE,HLOAD,HREF,HGOAL,HTIMER } from '../src/game/simulation/harvest-cpu.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import * as U from '../src/game/simulation/units-state.ts';
import { CpuAirOperations,airFireLocation } from '../src/game/simulation/air-operations-cpu.ts';
import { GpuAirOperations } from '../src/game/simulation/air-operations-gpu.ts';
import { AMISSION, AIR_WORDS,ASTATUS,ATIMER,ATARGET,ACONTACT } from '../src/game/simulation/aircraft-cpu.ts';
import { initialTransport,stepTransport,AIRSTRIP_EXITS } from '../src/game/simulation/transport-cpu.ts';
import { GpuTransport } from '../src/game/simulation/transport-gpu.ts';
import { GpuServices } from '../src/game/simulation/services-gpu.ts';
import { initialServices,stepServices,FACTORY_POINT,FACTORY_EXITS,SERVICE_BASE,SERVICE_WORDS,SGENERATION,SFACILITY,SMODE,SEXIT } from '../src/game/simulation/services-cpu.ts';
import { BUILDINGS } from '../src/game/data/buildings.ts';
import { canPlaceBuilding,placementOffsets } from '../src/game/simulation/building-rules.ts';
import { CpuBuildingEffects } from '../src/game/simulation/building-effects-cpu.ts';
import { GpuBuildingEffects } from '../src/game/simulation/building-effects-gpu.ts';
import { PalettePipeline } from '../src/engine/indexed/pipeline.ts';
import { GpuGround,groundLayout } from '../src/game/simulation/ground.ts';
import { AircraftView } from '../src/game/simulation/aircraft-view.ts';
import { Radar } from '../src/game/radar.ts';
import { ConstructionPreview } from '../src/game/construction-preview.ts';
import { GpuSelection } from '../src/game/simulation/selection.ts';

export async function compareAircraftDrawing(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const renderer=wrapper.three,{scene,setup}=economyScene(await loadData(),false,8);
  setup.units=[{type:movementType('TRAN'),cell:100},{type:movementType('HELI'),cell:120},{type:movementType('APC'),cell:140},...Array.from({length:5},()=>({type:movementType('MTNK'),cell:0,health:0}))];
  const units=new GpuUnits(renderer,setup),air=new GpuAircraft(units),layout=groundLayout(scene,U.initialUnits(setup),WORDS);
  const pipeline=new PalettePipeline(renderer,{...scene.setup,spriteCapacity:layout.count+1,dynamicSprites:{maxWidth:128,maxHeight:128}});
  const ground=new GpuGround(renderer,units,pipeline,layout,scene),view=new AircraftView(air,ground,pipeline,scene);
  try{
    // AIRCRAFT.CPP Draw_It and DOOR.CPP Door_Stage: opening 0,1,2, then held-open 2.
    for(const [door,frame] of [[1,32],[2,33],[3,34],[4,34],[5,34],[6,33],[7,32]] as const){
      (units.units.array as Int32Array)[U.UDOOR]=door;units.units.needsUpdate=true;view.update();
      const [order,packed]=await Promise.all([renderer.getArrayBufferAsync(ground.order.order),renderer.getArrayBufferAsync(pipeline.spriteBuffer)]);
      const rank=new Uint32Array(order).indexOf(scene.objects.findIndex(object=>object.key==='live:0'));
      const at=(layout.first+rank*layout.slots+1)*12,actual=Array.from(new Float32Array(packed).slice(at+4,at+6)),region=scene.animation!.frames.get('TRAN')![frame];
      if(actual[0]!==region.x||actual[1]!==region.y)throw new Error(`Chinook door ${door} did not use original TRAN frame ${frame}: ${actual} != ${[region.x,region.y]}`);
    }
    // UNIT.CPP Draw_It / DOOR.CPP Door_Stage: APC uses its own NE/NW door shapes.
    for(const [facing,frame] of [[32,32],[224,35]])for(const door of [1,4,5]){
      (units.units.array as Int32Array)[2*WORDS+U.UFACE]=facing;(units.units.array as Int32Array)[2*WORDS+U.UDOOR]=door;units.units.needsUpdate=true;ground.updateSprites();
      const [order,packed]=await Promise.all([renderer.getArrayBufferAsync(ground.order.order),renderer.getArrayBufferAsync(pipeline.spriteBuffer)]);
      const rank=new Uint32Array(order).indexOf(scene.objects.findIndex(object=>object.key==='live:2'));
      const at=(layout.first+rank*layout.slots)*12,actual=Array.from(new Float32Array(packed).slice(at+4,at+6)),region=scene.animation!.frames.get('APC')![frame];
      if(actual[0]!==region.x||actual[1]!==region.y)throw new Error(`APC door ${door}, facing ${facing}: ${actual} != ${[region.x,region.y]}`);
    }
    return true;
  }finally{view.dispose();ground.dispose();pipeline.dispose();air.dispose();units.dispose();wrapper.dispose();canvas.remove();}
}

export async function compareTiberium() {
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});
  if(!renderer)throw new Error('WebGPU is required');
  let comparisons=0;
  try {
    for(const [width,height,grow,spread] of [[8,8,true,true],[27,11,true,true],[7,5,false,true],[6,6,true,false]] as const){
      const cells=width*height;
      const setup:TiberiumSetup={width,height,seed:0x1995,amount:new Int32Array(cells).fill(-1),
        variants:new Int32Array(cells),clear:new Int32Array(cells).fill(1),
        blossom:new Int32Array(cells),playable:new Int32Array(cells).fill(1),grow,spread};
      for(let i=0;i<cells;i++){
        if(i%3===0)setup.amount[i]=i%12;
        if(i%17===0){setup.blossom[i]=1;setup.clear[i]=0;}
        if(i%19===0)setup.clear[i]=0;
      }
      const occupied=new Uint32Array(cells*5);for(let i=0;i<cells;i++)if(i%7===0)occupied[i*5+4]=1;
      const occupancy=new StorageBufferAttribute(occupied,1);
      const cpu=new CpuTiberium(setup),gpu=new GpuTiberium(renderer.three,setup,occupancy),replay=new GpuTiberium(renderer.three,setup,occupancy);
      try {
        for(let frame=1;frame<=600;frame++){
          cpu.step(occupied);gpu.step();replay.step();
          if(frame===1||frame===3||frame%100===0){
            const buffers=[cpu.amount,cpu.variants,cpu.state];
            const actual=await Promise.all([...gpu.buffers(),...replay.buffers()].map(async b=>new Int32Array(await renderer.three.getArrayBufferAsync(b))));
            actual.forEach((state,i)=>{
              const expected=buffers[i%3],at=state.findIndex((word,j)=>word!==expected[j]);
              if(at>=0)throw new Error(`Tiberium ${width}x${height}, frame ${frame}, buffer ${i}, word ${at}: ${state[at]} != ${expected[at]}`);
              comparisons++;
            });
          }
        }
      }finally{gpu.dispose();replay.dispose();}
    }
    const width=24,height=12,passable=new Uint8Array(width*height).fill(1);
    const setup={grid:gridEdges(width,height,passable,true),land:new Uint8Array(width*height),passable,seed:0x1995,
      units:[{cell:50,type:movementType('ORCA'),facing:32},{cell:194,type:movementType('TRAN'),facing:32}]};
    const cpu=new CpuUnits(setup),gpu=new GpuUnits(renderer.three,setup),cpuAir=new CpuAircraft(cpu),gpuAir=new GpuAircraft(gpu);
    try{
      for(let frame=1;frame<=400;frame++){
        const commands=frame===1?[{frame,kind:'move' as const,ids:[0],target:66},{frame,kind:'move' as const,ids:[1],target:210}]:[];
        cpuAir.step();gpuAir.step();cpu.step(commands);gpu.step(commands);
        if(frame===16||frame===17||frame===40){
          const expected=frame===16?0:frame===17?1:24;
          if(cpu.units[UALTITUDE]!==expected)throw new Error(`Original takeoff frame ${frame}: ${cpu.units[UALTITUDE]} != ${expected}`);
        }
        if(frame===1||frame===17||frame===40||frame%50===0){
          const actual=await Promise.all([gpu.units,gpuAir.state].map(async b=>new Int32Array(await renderer.three.getArrayBufferAsync(b))));
          actual.forEach((state,i)=>{
            const expected=i===0?cpu.units:cpuAir.state,at=state.findIndex((word,j)=>word!==expected[j]);
            if(at>=0)throw new Error(`Aircraft frame ${frame}, buffer ${i}, word ${at}: ${state[at]} != ${expected[at]}`);
          });
        }
      }
      if(cpu.goals.some(goal=>goal>=0)||cpu.units[UALTITUDE]||cpu.units[WORDS+UALTITUDE])throw new Error('Aircraft did not complete their moves and land');
    }finally{gpuAir.dispose();gpu.dispose();}
    return comparisons;
  }finally{renderer.dispose();canvas.remove();}
}

export async function compareEconomy(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});
  if(!renderer)throw new Error('WebGPU is required');
  const scene=economyScene(await loadData(),false,8);
  const passable=new Uint8Array(4096).fill(1);scene.basePassable.set(passable);scene.baseLand.fill(0);scene.playable.fill(1);scene.buildable.fill(1);
  scene.setup.grid=gridEdges(64,64,passable,true);scene.setup.passable=passable;scene.setup.land.fill(0);
  scene.setup.units=[{cell:130,type:movementType('MCV')},{cell:650,type:movementType('PROC')},
    {cell:776,type:movementType('HARV')},...Array.from({length:5},()=>({cell:0,type:movementType('MTNK'),health:0}))];
  scene.buildings.push({id:1,type:'PROC',cell:650,owner:0,faction:1});
  const gpu=new GpuCombat(renderer.three,scene.setup),economy=new EconomyRuntime(gpu,scene);
  const cpu=new CpuCombat(scene.setup);
  const ore=new GpuTiberium(renderer.three,{...scene.tiberium,amount:new Int32Array(4096).fill(-1)});
  const harvest=new GpuHarvest(economy,ore);
  try{
    await gpu.prepareForPlay();
    // Simultaneous factory exits contend for one physical cell; only the first tank fits.
    economy.lifecycle.create(3,{cell:200,type:movementType('MTNK')},{mission:C.GUARD_AREA,destination:198});
    economy.lifecycle.create(4,{cell:200,type:movementType('LTNK')});
    economy.lifecycle.create(5,{cell:210,type:movementType('E1'),owner:1},{mission:C.ATTACK,destination:211,target:0});
    const commands=(economy.lifecycle.commands.array as Int32Array).slice();
    applyLifecycle(cpu,commands);economy.lifecycle.flush();
    const compare=async(expected:Int32Array,buffer:import('three/webgpu').StorageBufferAttribute,label:string)=>{
      const actual=new Int32Array(await renderer.three.getArrayBufferAsync(buffer));
      const at=actual.findIndex((value,i)=>value!==expected[i]);if(at>=0)throw new Error(`${label}, word ${at}: ${actual[at]} != ${expected[at]}`);
    };
    await compare(cpu.units,gpu.units,'Factory exit units');await compare(cpu.state,gpu.state,'Factory exit combat');
    await compare(cpu.movement.goals,gpu.movement.goals,'Independent initial destinations');
    const h=(economy.miningState.array as Int32Array),p=HBASE+2*HWORDS;
    h[p+HGEN]=1;h[p+HMODE]=2;h[p+HLOAD]=28;economy.miningState.needsUpdate=true;
    const mining=h.slice(),amount=new Int32Array(4096).fill(-1),visuals=(economy.visuals.array as Int32Array).slice();
    for(let tick=1;tick<=900;tick++){
      stepHarvest({battle:cpu,ore:amount,state:mining,buildings:visuals,playable:scene.playable,passable:scene.setup.passable!});
      cpu.movement.occupy();gpu.movement.beginOccupancyEdits();harvest.step();gpu.movement.endOccupancyEdits();cpu.movement.step();gpu.movement.step();
      if(tick===1||tick%100===0){await compare(mining,economy.miningState,`Harvest ${tick}`);await compare(cpu.units,gpu.units,`Harvest units ${tick}`);}
    }
    if(mining[0]!==700)throw new Error(`A full harvester returned ${mining[0]} instead of 700 credits: state ${Array.from(mining.subarray(p,p+HWORDS))}, unit ${Array.from(cpu.units.subarray(2*WORDS,3*WORDS))}, goal ${cpu.movement.goals[2]}`);
    return mining[0];
  }finally{harvest.dispose();ore.dispose();economy.dispose();gpu.dispose();renderer.dispose();canvas.remove();}
}

export async function compareRefineryQueue(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  wrapper.three.setAnimationLoop(null);
  wrapper.three.render=()=>{throw new Error('Refinery logic checks must not draw');};
  const width=16,height=12,cells=width*height,passable=new Uint8Array(cells).fill(1),playable=new Int32Array(cells).fill(1);
  const setup={grid:gridEdges(width,height,passable,true),land:new Uint8Array(cells),passable,seed:1995,multiplayer:true,units:[
    {type:movementType('PROC'),cell:36},{type:movementType('HARV'),cell:52,attached:1},{type:movementType('HARV'),cell:150}]};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(wrapper.three,setup),source=economyScene(await loadData(),false,8);
  const state=initialHarvest(3),visuals=new StorageBufferAttribute(new Int32Array(3*BUILDING_WORDS),1);(visuals.array as Int32Array)[3]=1;
  for(const [id,mode] of [[1,5],[2,2]]){const at=HBASE+id*HWORDS;state[at+HGEN]=1;state[at+HMODE]=mode;state[at+HLOAD]=28;state[at+HREF]=id===1?0:-1;}
  const miningState=new StorageBufferAttribute(state.slice(),1),amount=new Int32Array(cells).fill(-1);
  const ore=new GpuTiberium(wrapper.three,{width,height,amount,variants:new Int32Array(cells),clear:playable,blossom:new Int32Array(cells),playable,seed:1995});
  const harvest=new GpuHarvest({battle:gpu,visuals,miningState,scene:{...source,setup,playable,buildable:playable,basePassable:passable,baseLand:setup.land}},ore);
  const context={battle:cpu,ore:amount,state,buildings:visuals.array as Int32Array,playable,passable};
  try{
    for(let frame=1;frame<=16;frame++){
      stepHarvest(context);
      cpu.movement.occupy();gpu.movement.beginOccupancyEdits();harvest.step();gpu.movement.endOccupancyEdits();
      if(frame===1&&(cpu.movement.goals[2]<0||state[HBASE+2*HWORDS+HTIMER]!==15))throw new Error('A full harvester failed to approach the busy refinery');
      for(const [buffer,expected] of [[gpu.movement.goals,cpu.movement.goals],[miningState,state]] as const){
        const actual=new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),word=actual.findIndex((value,i)=>value!==expected[i]);
        if(word>=0)throw new Error(`Busy refinery frame ${frame}, word ${word}: ${actual[word]} != ${expected[word]}`);
      }
      cpu.movement.step();gpu.movement.step();
    }
    // A temporary obstruction cleared NavCom two cells short of the docking point.
    const reset={...setup,units:[setup.units[0],{...setup.units[1],health:0,attached:0},{...setup.units[2],cell:70,facing:192}]};
    cpu.units.set(U.initialUnits(reset));cpu.movement.goals.fill(-1);cpu.movement.pathGoals.fill(-1);cpu.movement.occupy();
    (gpu.units.array as Int32Array).set(cpu.units);gpu.units.needsUpdate=true;
    (gpu.movement.goals.array as Int32Array).fill(-1);gpu.movement.goals.needsUpdate=true;
    (gpu.movement.pathGoals.array as Int32Array).fill(-1);gpu.movement.pathGoals.needsUpdate=true;gpu.movement.refreshOccupancy();
    state.fill(0);const p=HBASE+2*HWORDS;
    state[p+HGEN]=1;state[p+HMODE]=3;state[p+HREF]=0;state[p+HGOAL]=68;state[p+HLOAD]=28;
    (miningState.array as Int32Array).set(state);miningState.needsUpdate=true;
    amount.fill(-1);amount[124]=36;(ore.amount.array as Int32Array).set(amount);ore.amount.needsUpdate=true;
    for(let frame=1;frame<=1400;frame++){
      if(frame===2){
        cpu.movement.scatter(2);
        gpu.movement.applyCommands([{frame:gpu.frame,kind:'scatter',ids:[2]}]);
      }
      stepHarvest(context);
      if(frame===2&&(state[p+HMODE]!==3||state[p+HREF]!==0))throw new Error('Automatic yielding discarded refinery contact');
      cpu.movement.occupy();gpu.movement.beginOccupancyEdits();harvest.step();gpu.movement.endOccupancyEdits();
      if(frame===1&&cpu.movement.goals[2]!==68)throw new Error('Interrupted docking did not receive its destination again');
      cpu.movement.step();gpu.movement.step();
      if(frame===1||frame%20===0)for(const [buffer,expected] of [[gpu.units,cpu.units],[gpu.movement.goals,cpu.movement.goals],[miningState,state],[ore.amount,amount]] as const){
        const actual=new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),word=actual.findIndex((value,i)=>value!==expected[i]);
        if(word>=0)throw new Error(`Docking recovery frame ${frame}, word ${word}: GPU ${actual[word]}, CPU ${expected[word]}`);
      }
    }
    if(state[0]<700||amount[124]>=36)throw new Error('Recovered harvester did not unload and resume mining');
    // Keep the same refinery, but now an area-guard infantryman blocks its exit during unloading.
    const apron={...setup,multiplayer:true,units:[setup.units[0],{...setup.units[1],cell:52,attached:1},{cell:68,type:movementType('E1')} ]};
    cpu.units.set(U.initialUnits(apron));cpu.state.set(C.initialCombat(apron));cpu.humanOwner=-1;gpu.humanOwner.value=-1;
    cpu.state[2*C.CWORDS+C.CMISSION]=C.GUARD_AREA;cpu.state[2*C.CWORDS+C.CGUARD_CELL]=69;
    cpu.movement.goals.fill(-1);cpu.movement.pathGoals.fill(-1);cpu.movement.occupy();
    for(const [buffer,expected] of [[gpu.units,cpu.units],[gpu.state,cpu.state],[gpu.movement.goals,cpu.movement.goals],[gpu.movement.pathGoals,cpu.movement.pathGoals]] as const){
      (buffer.array as Int32Array).set(expected);buffer.needsUpdate=true;
    }
    gpu.movement.refreshOccupancy();
    state.fill(0);const unloading=HBASE+HWORDS;
    state[unloading+HGEN]=1;state[unloading+HMODE]=5;state[unloading+HREF]=0;state[unloading+HLOAD]=10;
    (miningState.array as Int32Array).set(state);miningState.needsUpdate=true;
    amount.fill(-1);amount[124]=36;(ore.amount.array as Int32Array).set(amount);ore.amount.needsUpdate=true;
    for(let frame=1;frame<=1200;frame++){
      stepHarvest(context);cpu.movement.occupy();gpu.movement.beginOccupancyEdits();harvest.step();gpu.movement.endOccupancyEdits();
      if(frame===1&&cpu.movement.goals[2]<0)throw new Error('Refinery did not clear its occupied apron');
      cpu.step();gpu.step();
      if(frame===1||frame%20===0)for(const [buffer,expected] of [[gpu.units,cpu.units],[gpu.state,cpu.state],[gpu.movement.goals,cpu.movement.goals],[miningState,state],[ore.amount,amount]] as const){
        const actual=new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),word=actual.findIndex((value,i)=>value!==expected[i]);
        if(word>=0)throw new Error(`Apron clearance frame ${frame}, word ${word}: GPU ${actual[word]}, CPU ${expected[word]}`);
      }
    }
    if(state[0]<250||amount[124]>=36)throw new Error('Harvester did not leave the cleared apron and resume mining');
    return true;
  }finally{harvest.dispose();ore.dispose();gpu.dispose();releaseStorage(wrapper.three,[visuals,miningState]);wrapper.dispose();canvas.remove();}
}

/** MAP.CPP Explosion_Damage: accumulate simultaneous ground hits; airborne impacts leave ore intact. */
export async function compareTiberiumBlasts(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const width=16,height=12,cells=width*height,passable=new Uint8Array(cells).fill(1),playable=new Int32Array(cells).fill(1);
  const setup={grid:gridEdges(width,height,passable,true),land:new Uint8Array(cells),passable,seed:1995,units:[{type:movementType('TRAN'),cell:60,altitude:24},{type:movementType('MCV'),cell:150}]};
  const battle=new GpuCombat(wrapper.three,setup),amount=new Int32Array(cells).fill(-1);amount[60]=11;amount[61]=1;
  const ore=new GpuTiberium(wrapper.three,{width,height,amount,variants:new Int32Array(cells),clear:playable,blossom:new Int32Array(cells),playable,seed:1995});ore.connect(battle,setup.land);
  try{
    const projectiles=battle.projectiles.array as Int32Array;
    for(const [id,[cell,damage,target]] of [[60,30,-1],[60,20,-1],[60,40,-1],[60,100,0],[61,100,-1]].entries()){
      const at=id*C.BWORDS;projectiles[at+C.BACTIVE]=1;projectiles[at+C.BTYPE]=2;projectiles[at+C.BDAMAGE]=damage;projectiles[at+C.BTARGET]=target;projectiles[at+C.BSOURCE]=1;
      projectiles[at+C.BX]=projectiles[at+C.BTO_X]=cell%width*256+128;projectiles[at+C.BY]=projectiles[at+C.BTO_Y]=Math.trunc(cell/width)*256+128;projectiles[at+C.BEXPLODED]=-1;projectiles[at+C.BTRAIL_TICK]=-1;
    }
    battle.projectiles.needsUpdate=true;battle.step();ore.damage(battle.frame);
    const actual=new Int32Array(await wrapper.three.getArrayBufferAsync(ore.amount));
    if(actual[60]!==2||actual[61]!==-1)throw new Error(`Simultaneous ore damage: ${actual[60]}, ${actual[61]} instead of 2, -1`);
    return true;
  }finally{ore.dispose();battle.dispose();wrapper.dispose();canvas.remove();}
}

export async function compareDefenses(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!renderer)throw new Error('WebGPU is required');
  const width=64,passable=new Uint8Array(width*40).fill(1);
  const units:U.UnitPlacement[]=[];
  for(const [i,name] of ['GTWR','ATWR','GUN','OBLI','SAM','ATWR','OBLI'].entries()){
    const x=5+(i%4)*15,y=5+Math.floor(i/4)*20;
    units.push({type:movementType(name),cell:y*width+x},{type:movementType(i===3||i===6?'MTNK':'TRAN'),cell:(y+3)*width+x,owner:1,altitude:i===3||i===6?0:24});
  }
  const setup={grid:gridEdges(width,40,passable,true),land:new Uint8Array(passable.length),passable,units,seed:0x1995};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup);
  for(let id=0;id<units.length;id++){cpu.state[id*C.CWORDS+C.CSEEN]=1;(gpu.state.array as Int32Array)[id*C.CWORDS+C.CSEEN]=1;}
  for(const id of [10,12]){cpu.state[id*C.CWORDS+C.CPOWER]=128;(gpu.state.array as Int32Array)[id*C.CWORDS+C.CPOWER]=128;}
  gpu.state.needsUpdate=true;
  try{
    await gpu.prepareForPlay();
    for(let frame=1;frame<=210;frame++){
      cpu.step();gpu.step();
      if(frame===1||frame%15===0){
        const expected=[cpu.units,cpu.state,cpu.projectiles];
        const actual=await Promise.all([gpu.units,gpu.state,gpu.projectiles].map(async b=>new Int32Array(await renderer.three.getArrayBufferAsync(b))));
        actual.forEach((a,i)=>{const p=a.findIndex((n,j)=>n!==expected[i][j]);if(p>=0)throw new Error(`Defense frame ${frame}, buffer ${i}, word ${p}: ${a[p]} != ${expected[i][p]}`);});
      }
    }
    for(const id of [0,4,10,12])if(cpu.state[id*C.CWORDS+C.CLAST_FIRE]!==-1)throw new Error(`Defense ${id} fired at an ineligible target or without power`);
    for(const id of [2,6,8])if(cpu.state[id*C.CWORDS+C.CLAST_FIRE]===-1)throw new Error(`Defense ${id} did not fire`);
    return true;
  }finally{gpu.dispose();renderer.dispose();canvas.remove();}
}

export async function compareAircraftOperations(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!renderer)throw new Error('WebGPU is required');
  const width=32,passable=new Uint8Array(width*16).fill(1),playable=new Int32Array(passable.length).fill(1);
  const setup={grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,seed:0x1995,units:[
    {type:movementType('HPAD'),cell:40},{type:movementType('ORCA'),cell:200,facing:32},{type:movementType('MTNK'),cell:212,owner:1}]};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup),cpuAir=new CpuAircraft(cpu.movement),gpuAir=new GpuAircraft(gpu.movement);
  const cpuOps=new CpuAirOperations(cpu,cpuAir,playable),gpuOps=new GpuAirOperations(gpu,gpuAir,playable);
  let spent=false,returned=false;
  try{
    await gpu.prepareForPlay();
    for(let frame=1;frame<=1400;frame++){
      const commands=frame===1?[{frame,kind:'attack' as const,target:2,ids:[1]}]:[];
      gpu.movement.beginOccupancyEdits();cpuOps.before();gpuOps.before();cpuAir.step();gpuAir.step();gpu.movement.endOccupancyEdits();cpu.step(commands);gpu.step(commands);cpuOps.after();gpuOps.after();
      if(cpu.state[C.CWORDS+C.CAMMO]===0)spent=true;
      if(spent&&cpuAir.state[AIR_WORDS+AMISSION]===3&&cpu.state[C.CWORDS+C.CAMMO]===6)returned=true;
      if(frame===1||frame%50===0||returned){
        const expected=[cpu.units,cpu.state,cpu.projectiles,cpuAir.state];
        const actual=await Promise.all([gpu.units,gpu.state,gpu.projectiles,gpuAir.state].map(async b=>new Int32Array(await renderer.three.getArrayBufferAsync(b))));
        actual.forEach((a,i)=>{const p=a.findIndex((n,j)=>n!==expected[i][j]);if(p>=0)throw new Error(`Air operation frame ${frame}, buffer ${i}, word ${p}: ${a[p]} != ${expected[i][p]}`);});
      }
      if(returned)break;
    }
    if(!returned)throw new Error(`Orca did not attack, return and rearm: spent ${spent}, air ${Array.from(cpuAir.state.subarray(AIR_WORDS,AIR_WORDS*2))}, unit ${Array.from(cpu.units.subarray(WORDS,WORDS*2))}`);
    return true;
  }finally{gpuOps.dispose();gpuAir.dispose();gpu.dispose();renderer.dispose();canvas.remove();}
}

/** AIRCRAFT.CPP Logic ordering: earlier missions release destinations and radio contacts. */
export async function compareMixedHunt(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  try{
    for(const mode of ['mixed','air only','ground only']){
      const width=64,passable=new Uint8Array(width*16).fill(1),setup={grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,dynamicTypes:true,units:[
        ...['MTNK','SAM','MSAM','E1'].map((name,id)=>({type:movementType(name),cell:width*(3+id)+2,owner:1})),
        {type:movementType('TRAN'),cell:width*4+45,altitude:24,health:mode==='ground only'?0:90},
        {type:movementType('E1'),cell:width*5+45,health:mode==='air only'?0:50},
        {type:movementType('V01'),cell:width*6+45,health:mode==='air only'?0:200},
        {type:movementType('C17'),cell:width*7+45,altitude:24}]};
      const cpu=new CpuCombat(setup),gpu=new GpuCombat(wrapper.three,setup);
      try{
        for(let id=0;id<4;id++)cpu.state[id*C.CWORDS+C.CMISSION]=C.HUNT;
        (gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
        for(let frame=1;frame<=20;frame++){
          cpu.step();gpu.step();
          if(frame===1||frame===20)for(const [buffer,expected] of [[gpu.units,cpu.units],[gpu.state,cpu.state],[gpu.projectiles,cpu.projectiles]] as const){
            const actual=new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),word=actual.findIndex((value,i)=>value!==expected[i]);
            if(word>=0)throw new Error(`${mode} hunt frame ${frame}, word ${word}: ${actual[word]} != ${expected[word]}`);
          }
        }
      }finally{gpu.dispose();}
    }
    return true;
  }finally{wrapper.dispose();canvas.remove();}
}

export async function compareAirCoordination(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const width=32,passable=new Uint8Array(width*16).fill(1),playable=new Int32Array(passable.length).fill(1);
  const setup={grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,seed:0x1995,units:[
    {type:movementType('ORCA'),cell:100,altitude:24},{type:movementType('ORCA'),cell:120,altitude:24},{type:movementType('MTNK'),cell:130,owner:1},{type:movementType('HPAD'),cell:40}]};
  const gpu=new GpuCombat(wrapper.three,setup),flight=new GpuAircraft(gpu.movement),operations=new GpuAirOperations(gpu,flight,playable);
  try{
    for(const mode of ['released destination','competing contacts','released contact']){
      const cpu=new CpuCombat(setup),air=new CpuAircraft(cpu.movement),ops=new CpuAirOperations(cpu,air,playable);
      if(mode==='released destination'){
        cpu.movement.goals[0]=airFireLocation(cpu,1,2,playable);
        air.state[AMISSION]=1;air.state[ASTATUS]=6;air.state[ATIMER]=0;
        air.state[AIR_WORDS+AMISSION]=1;air.state[AIR_WORDS+ASTATUS]=1;air.state[AIR_WORDS+ATARGET]=2;
        cpu.state[C.CWORDS+C.CMISSION]=C.ATTACK;cpu.state[C.CWORDS+C.CTARGET]=2;
      }else{
        cpu.units[WORDS+U.UENTER]=4;
        if(mode==='competing contacts')cpu.units[U.UENTER]=4;
        else{air.state[ACONTACT]=3;air.state[AMISSION]=2;cpu.state[C.CMISSION]=C.MOVE;cpu.movement.goals[0]=90;}
      }
      for(const [buffer,values] of [[gpu.units,cpu.units],[gpu.state,cpu.state],[gpu.movement.goals,cpu.movement.goals],[flight.state,air.state]] as const){(buffer.array as Int32Array).set(values);buffer.needsUpdate=true;}
      ops.before();operations.before();
      for(const [buffer,expected] of [[gpu.units,cpu.units],[gpu.state,cpu.state],[gpu.movement.goals,cpu.movement.goals],[flight.state,air.state]] as const){
        const actual=new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),word=actual.findIndex((value,i)=>value!==expected[i]);
        if(word>=0)throw new Error(`Aircraft ${mode}, word ${word}: ${actual[word]} != ${expected[word]}`);
      }
    }
    return true;
  }finally{operations.dispose();flight.dispose();gpu.dispose();wrapper.dispose();canvas.remove();}
}

export async function compareTransports(modes:readonly ('chinook'|'delivery'|'blocked'|'lost')[]=['chinook','delivery','blocked','lost']){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!renderer)throw new Error('WebGPU is required');
  try{
    for(const mode of modes){
      const width=32,passable=new Uint8Array(width*16).fill(1),playable=new Int32Array(passable.length).fill(1);
      if(mode==='blocked')for(const [x,y] of AIRSTRIP_EXITS)passable[180+y*width+x]=0;
      const units:U.UnitPlacement[]=mode==='chinook'?[{type:movementType('TRAN'),cell:200},...Array.from({length:6},(_,i)=>({type:movementType('E1'),cell:i<5?232:264,slot:i%5}))]:
        [{type:movementType('AFLD'),cell:180},{type:movementType('C17'),cell:223,facing:192,altitude:24,enter:1},{type:movementType('LTNK'),cell:223,attached:2}];
      const setup={grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,units,seed:0x1995};
      const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup),cpuAir=new CpuAircraft(cpu.movement),gpuAir=new GpuAircraft(gpu.movement);
      const transport=new GpuTransport(gpu,gpuAir,playable),state=initialTransport(units.length),pending=new Int32Array(units.length*2).fill(-1);
      const selection=mode==='chinook'?new GpuSelection(renderer.three,gpu.movement,gpu.sight,true):undefined;
      let unloaded=false;
      try{
        await gpu.prepareForPlay();
        for(let frame=1;frame<=650;frame++){
          if(mode==='lost'&&frame===10){cpu.units[U.UHEALTH]=0;(gpu.units.array as Int32Array).set(cpu.units);gpu.units.needsUpdate=true;}
          const full=mode==='chinook'&&units.filter((_,id)=>cpu.units[id*WORDS+U.UATTACHED]===1).length===5;
          if(mode==='chinook'&&(frame===1||full&&!unloaded)){
            pending.fill(-1);
            if(frame===1)for(let id=1;id<units.length;id++){pending[id*2]=5;pending[id*2+1]=0;}
            else {pending[0]=6;unloaded=true;}
            if(frame===1){(gpu.movement.pending.array as Int32Array).set(pending);gpu.movement.pending.needsUpdate=true;}
            else{
              // AIRCRAFT.CPP Active_Click_With: select the loaded Chinook, then click it again.
              selection!.apply({action:'clear'});
              selection!.apply({action:'point',x:cpu.units[0],y:cpu.units[1]});
              selection!.apply({action:'point',x:cpu.units[0],y:cpu.units[1]});
            }
          }
          gpu.movement.beginOccupancyEdits();stepTransport(cpu,cpuAir.state,state,pending,playable);transport.step();cpuAir.step();gpuAir.step();gpu.movement.endOccupancyEdits();cpu.step();gpu.step();
          if(frame===1||frame%50===0){
            const expected=[cpu.units,cpu.state,cpuAir.state,state];
            const actual=await Promise.all([gpu.units,gpu.state,gpuAir.state,transport.state].map(async b=>new Int32Array(await renderer.three.getArrayBufferAsync(b))));
            actual.forEach((a,i)=>{const p=a.findIndex((n,j)=>n!==expected[i][j]);if(p>=0)throw new Error(`${mode} frame ${frame}, buffer ${i}, word ${p}: ${a[p]} != ${expected[i][p]}`);});
          }
        }
        if(mode==='chinook'&&(!unloaded||units.some((_,id)=>cpu.units[id*WORDS+U.UATTACHED])))throw new Error('Chinook did not board five passengers and unload them');
        if(mode==='delivery'&&(state[2]!==1||cpu.units[WORDS*2+U.UATTACHED]!==0||cpu.units[WORDS*2+U.UHEALTH]!==300))throw new Error('C-17 did not deliver the vehicle');
        if((mode==='blocked'||mode==='lost')&&(state[0]!==600||cpu.units[WORDS*2+U.UHEALTH]!==0))throw new Error(`C-17 did not refund ${mode} cargo: ${state[0]}`);
      }finally{selection?.dispose();transport.dispose();gpuAir.dispose();gpu.dispose();}
    }
    return true;
  }finally{renderer.dispose();canvas.remove();}
}

export async function compareAircraftProduction(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  try{
    for(const mode of ['occupied','returning']){
      const width=16,height=16,origin=68,passable=new Uint8Array(width*height).fill(1),playable=new Int32Array(passable.length).fill(1);
      for(const [x,y] of BUILDINGS.get('HPAD')!.occupy)passable[origin+y*width+x]=0;
      const setup={grid:gridEdges(width,height,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,units:[
        {type:movementType('HPAD'),cell:origin},{type:movementType('ORCA'),cell:mode==='occupied'?origin+1:150,altitude:mode==='occupied'?0:24},{type:movementType('ORCA'),cell:0,health:0}]};
      const cpu=new CpuCombat(setup),gpu=new GpuCombat(wrapper.three,setup),cpuAir=new CpuAircraft(cpu.movement),gpuAir=new GpuAircraft(gpu.movement),cpuOps=new CpuAirOperations(cpu,cpuAir,playable),gpuOps=new GpuAirOperations(gpu,gpuAir,playable),lifecycle=new GpuLifecycle(gpu);
      try{
        cpuAir.state[AIR_WORDS+ACONTACT]=0;cpuAir.state[AIR_WORDS+AMISSION]=mode==='occupied'?3:2;
        if(mode==='occupied'){cpu.units[WORDS]=origin%width*256+256;cpu.units[WORDS+1]=Math.trunc(origin/width)*256+192;}
        else cpu.movement.goals[1]=origin+1;
        for(const [buffer,values] of [[gpu.units,cpu.units],[gpuAir.state,cpuAir.state],[gpu.movement.goals,cpu.movement.goals]] as const){(buffer.array as Int32Array).set(values);buffer.needsUpdate=true;}
        lifecycle.useAircraft(gpuAir.state);lifecycle.create(2,{type:movementType('ORCA'),cell:origin+1,owner:0,facing:32,enter:1},{ignore:0});
        applyLifecycle(cpu,(lifecycle.commands.array as Int32Array).slice(),passable,cpuAir.state);lifecycle.flush();
        const created=new Int32Array(await wrapper.three.getArrayBufferAsync(gpu.units));
        if(created[2*WORDS+U.UALTITUDE]!==24||created[2*WORDS+U.UFACE]!==0)throw new Error(`${mode} helipad did not deliver its new aircraft from the edge facing north`);
        let settled=false;
        for(let frame=1;frame<=400;frame++){
          gpu.movement.beginOccupancyEdits();cpuOps.before();gpuOps.before();cpuAir.step();gpuAir.step();gpu.movement.endOccupancyEdits();cpu.movement.step();gpu.movement.step();
          settled=[1,2].every(id=>cpu.units[id*WORDS+U.UALTITUDE]===0&&cpu.movement.goals[id]<0);
          if(frame===1||frame%50===0||settled)for(const [buffer,expected] of [[gpu.units,cpu.units],[gpu.state,cpu.state],[gpuAir.state,cpuAir.state],[gpu.movement.goals,cpu.movement.goals]] as const){
            const actual=new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),word=actual.findIndex((value,i)=>value!==expected[i]);
            if(word>=0)throw new Error(`${mode} helipad frame ${frame}, word ${word}: ${actual[word]} != ${expected[word]}`);
          }
          if(settled)break;
        }
        if(!settled||cpu.units[WORDS+U.UCELL]===cpu.units[2*WORDS+U.UCELL])throw new Error(`${mode} helipad aircraft failed to land in separate cells`);
      }finally{lifecycle.dispose();gpuOps.dispose();gpuAir.dispose();gpu.dispose();}
    }
    return true;
  }finally{wrapper.dispose();canvas.remove();}
}

export async function compareFactoryExits(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  try{
    for(const name of ['PYLE','HAND','WEAP']){
      const width=16,origin=68,count=7,passable=new Uint8Array(width*16).fill(1),infantry=name!=='WEAP',type=movementType(infantry?'E1':'MTNK');
      for(const [x,y] of BUILDINGS.get(name)!.occupy)passable[origin+y*width+x]=0;
      const setup={grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,units:[
        {type:movementType(name),cell:origin},...Array.from({length:count-1},()=>({type,cell:0,health:0}))]};
      const cpu=new CpuCombat(setup),gpu=new GpuCombat(wrapper.three,setup),services=new GpuServices(gpu),state=initialServices(count),lifecycle=new GpuLifecycle(gpu);
      try{
        const [x,y]=FACTORY_POINT[name],cell=origin+Math.trunc(y/256)*width+Math.trunc(x/256),total=infantry?6:3;
        const compare=async(label:string)=>{
          for(const [buffer,expected] of [[gpu.units,cpu.units],[gpu.state,cpu.state],[services.state,state],[gpu.movement.goals,cpu.movement.goals]] as const){
            const actual=new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),word=actual.findIndex((value,i)=>value!==expected[i]);
            if(word>=0)throw new Error(`${name} ${label}, word ${word}: ${actual[word]} != ${expected[word]}`);
          }
        };
        for(let id=1;id<=total;id++){
          lifecycle.create(id,{type,cell,owner:0,facing:160,enter:-1},{ignore:0});
          applyLifecycle(cpu,(lifecycle.commands.array as Int32Array).slice());lifecycle.flush();
          for(let tick=0;tick<250;tick++){
            stepServices(cpu,state,new Int32Array(2));gpu.movement.beginOccupancyEdits();services.step(0);gpu.movement.endOccupancyEdits();cpu.movement.step();gpu.movement.step();
            if(tick%20===0)await compare(`unit ${id}, tick ${tick}`);
            if(cpu.units[id*WORDS+U.UENTER]===0)break;
          }
          await compare(`unit ${id} release`);
          if(cpu.units[id*WORDS+U.UENTER]!==0)throw new Error(`${name} unit ${id} failed to clear the factory`);
        }
        for(let tick=0;tick<100;tick++){stepServices(cpu,state,new Int32Array(2));gpu.movement.beginOccupancyEdits();services.step(0);gpu.movement.endOccupancyEdits();cpu.movement.step();gpu.movement.step();}
        await compare('settled exits');
        const positions=Array.from({length:total},(_,i)=>`${cpu.units[(i+1)*WORDS]},${cpu.units[(i+1)*WORDS+1]}`);
        if(new Set(positions).size!==total)throw new Error(`${name} production overlapped completed units: ${positions}`);
        if(infantry){const first=cpu.units[WORDS+U.UCELL];for(let id=1;id<=5;id++)if(cpu.units[id*WORDS+U.UCELL]!==first)throw new Error(`${name} omitted an infantry spot`);if(cpu.units[6*WORDS+U.UCELL]===first)throw new Error(`${name} put a sixth infantry in one cell`);}
      }finally{lifecycle.dispose();services.dispose();gpu.dispose();}
    }
    return true;
  }finally{wrapper.dispose();canvas.remove();}
}

export async function compareServiceContacts(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const width=16,passable=new Uint8Array(width*12).fill(1),setup={grid:gridEdges(width,12,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,units:[
    {type:movementType('FIX'),cell:36},{type:movementType('MTNK'),cell:80,enter:1},{type:movementType('MTNK'),cell:90,enter:1}]};
  const gpu=new GpuCombat(wrapper.three,setup),services=new GpuServices(gpu);
  try{
    for(const holder of [1,2]){
      const cpu=new CpuCombat(setup),state=initialServices(3),at=SERVICE_BASE+holder*SERVICE_WORDS;
      for(let id=0;id<3;id++)state[SERVICE_BASE+id*SERVICE_WORDS+SGENERATION]=1;
      state[at+SFACILITY]=1;state[at+SMODE]=4;state[at+SEXIT]=cpu.units[holder*WORDS+U.UCELL];
      for(const [buffer,values] of [[gpu.units,cpu.units],[gpu.state,cpu.state],[gpu.movement.goals,cpu.movement.goals],[services.state,state]] as const){(buffer.array as Int32Array).set(values);buffer.needsUpdate=true;}
      stepServices(cpu,state,Int32Array.from([1000,0]));services.step(1000);
      for(const [buffer,expected] of [[gpu.units,cpu.units],[gpu.movement.goals,cpu.movement.goals],[services.state,state]] as const){
        const actual=new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),word=actual.findIndex((value,i)=>value!==expected[i]);
        if(word>=0)throw new Error(`Repair contact held by ${holder}, word ${word}: ${actual[word]} != ${expected[word]}`);
      }
    }
    return true;
  }finally{services.dispose();gpu.dispose();wrapper.dispose();canvas.remove();}
}

export async function compareServices(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!renderer)throw new Error('WebGPU is required');
  try{
    for(const mode of ['repair','factory'] as const){
      const width=32,passable=new Uint8Array(width*16).fill(1),name=mode==='repair'?'FIX':'WEAP',origin=100;
      for(const [x,y] of BUILDINGS.get(name)!.occupy)passable[origin+y*width+x]=0;
      const setup={grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,seed:0x1995,units:[
        {type:movementType(name),cell:origin},{type:movementType('MTNK'),cell:mode==='repair'?164:132,health:mode==='repair'?384:400,enter:mode==='repair'?1:-1}]};
      const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup),services=new GpuServices(gpu),state=initialServices(2);
      try{
        await gpu.prepareForPlay();
        for(let frame=1;frame<=350;frame++){
          const budget=1000-state[0];stepServices(cpu,state,Int32Array.from([budget,0]));gpu.movement.beginOccupancyEdits();services.step(budget);gpu.movement.endOccupancyEdits();
          const commands=frame===180&&mode==='repair'?[{frame,kind:'move' as const,ids:[1],target:300}]:[];
          cpu.step(commands);gpu.step(commands);
          if(frame===150&&mode==='repair'&&(cpu.units[WORDS+U.UHEALTH]!==400||state[0]!==12))throw new Error(`Repair changed health/money incorrectly: ${cpu.units[WORDS+U.UHEALTH]}, ${state[0]}`);
          if(frame===1||frame%50===0){
            const expected=[cpu.units,cpu.state,state];const actual=await Promise.all([gpu.units,gpu.state,services.state].map(async b=>new Int32Array(await renderer.three.getArrayBufferAsync(b))));
            actual.forEach((a,i)=>{const p=a.findIndex((n,j)=>n!==expected[i][j]);if(p>=0)throw new Error(`${mode} frame ${frame}, buffer ${i}, word ${p}: ${a[p]} != ${expected[i][p]}`);});
          }
        }
        if(cpu.units[WORDS+U.UENTER]||!passable[cpu.units[WORDS+U.UCELL]])throw new Error(`${mode} unit did not exit the building`);
      }finally{services.dispose();gpu.dispose();}
    }
    return true;
  }finally{renderer.dispose();canvas.remove();}
}

export async function compareBuildingEffects(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!renderer)throw new Error('WebGPU is required');
  const scene=economyScene(await loadData(),false,8),passable=new Uint8Array(16*12).fill(1);
  const setup={grid:gridEdges(16,12,passable,true),land:new Uint8Array(passable.length),passable,seed:0x1995,units:[
    ...Array.from({length:130},()=>({type:movementType('MTNK'),cell:0,health:0})),
    {type:movementType('NUKE'),cell:34},{type:movementType('WEAP'),cell:41}]};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup),effects=new CpuBuildingEffects(cpu,scene.scene.animation!.frames),gpuEffects=new GpuBuildingEffects(gpu,scene.scene.animation!.frames);
  try{
    cpu.units[130*WORDS+U.UHEALTH]=100;cpu.state[130*C.CWORDS+C.CWARHEAD]=3;cpu.units[131*WORDS+U.UHEALTH]=0;cpu.state[131*C.CWORDS+C.CDEATH]=1;
    (gpu.units.array as Int32Array).set(cpu.units);gpu.units.needsUpdate=true;
    (gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
    await gpuEffects.prepareForPlay();
    for(let frame=1;frame<=240;frame++){
      cpu.movement.frame=frame;(gpu.movement.control.array as Int32Array)[0]=frame;gpu.movement.control.needsUpdate=true;
      effects.step();gpu.movement.beginOccupancyEdits();gpuEffects.step();gpu.movement.endOccupancyEdits();
      if([1,2,9,33,240].includes(frame)){
        const expected=[cpu.units,cpu.state,effects.layout.state,effects.smudges];
        const actual=await Promise.all([gpu.units,gpu.state,gpuEffects.state,gpuEffects.smudges].map(async buffer=>new Int32Array(await renderer.three.getArrayBufferAsync(buffer))));
        for(const [i,values] of actual.entries()){const word=values.findIndex((value,index)=>value!==expected[i][index]);if(word>=0)throw new Error(`Building effects frame ${frame}, buffer ${i}, word ${word}: ${Array.from(values.slice(Math.max(0,word-6),word+5))} != ${Array.from(expected[i].slice(Math.max(0,word-6),word+5))}`);}
      }
    }
    if(cpu.units[130*WORDS+U.UHEALTH]>=100)throw new Error('Attached building fires did not apply their original accumulated damage');
    for(const [x,y] of BUILDINGS.get('WEAP')!.occupy)if(!effects.smudges[41+y*16+x])throw new Error('Building destruction omitted an occupied cell');
    return true;
  }finally{gpuEffects.dispose();gpu.dispose();renderer.dispose();canvas.remove();}
}

export async function compareLifecycle(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!renderer)throw new Error('WebGPU is required');
  const width=32,passable=new Uint8Array(width*16).fill(1);
  const setup={grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,seed:0x1995,units:[
    {cell:99,type:movementType('MCV')},{cell:106,type:movementType('PROC')},{cell:170,type:movementType('MTNK')},
    {cell:0,type:movementType('HARV'),health:0},{cell:210,type:movementType('PYLE')},{cell:0,type:movementType('E1'),health:0}]};
  // The barracks may finish production, but cannot release its object through a blocked exit.
  for(const [x,y] of FACTORY_EXITS.PYLE)passable[210+y*width+x]=0;
  setup.grid=gridEdges(width,16,passable,true);
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup),lifecycle=new GpuLifecycle(gpu);
  try{
    const ore=new StorageBufferAttribute(new Int32Array(passable.length).fill(-1),1);
    lifecycle.validateTerrain(ore);
    lifecycle.create(0,{type:movementType('FACT'),cell:66},{ignore:0});
    lifecycle.create(3,{type:movementType('HARV'),cell:170},{ignore:1,nearby:true});
    lifecycle.create(5,{type:movementType('E1'),cell:243,enter:-5},{ignore:4});
    const commands=(lifecycle.commands.array as Int32Array).slice();
    applyLifecycle(cpu,commands);
    lifecycle.flush();
    const actual=await Promise.all([gpu.units,gpu.state].map(async buffer=>new Int32Array(await renderer.three.getArrayBufferAsync(buffer))));
    for(const [i,values] of actual.entries()){
      const expected=i?cpu.state:cpu.units,word=values.findIndex((value,index)=>value!==expected[index]);
      if(word>=0)throw new Error(`Lifecycle buffer ${i}, word ${word}: ${values[word]} != ${expected[word]}`);
    }
    if(cpu.units[U.UTYPE]!==movementType('FACT'))throw new Error('MCV did not become its construction yard');
    if(cpu.units[3*WORDS+U.UHEALTH]<=0||cpu.units[3*WORDS+U.UCELL]===170)throw new Error('The refinery gift did not use a nearby clear cell');
    if(cpu.units[5*WORDS+U.UHEALTH]!==0)throw new Error('The barracks released a unit through blocked exits');
    return true;
  }finally{lifecycle.dispose();gpu.dispose();renderer.dispose();canvas.remove();}
}

export async function compareEconomicMap(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const data=await loadData(),scene=economyScene(data,false,8),width=96,height=48,cells=width*height,cell=35*width+80;
  scene.setup={...scene.setup,grid:gridEdges(width,height,new Uint8Array(cells).fill(1),true),bounds:{x:0,y:0,width,height},land:new Uint8Array(cells),passable:new Uint8Array(cells).fill(1),
    units:[{type:movementType('MCV'),cell,facing:160},...Array.from({length:7},()=>({type:movementType('MTNK'),cell:0,health:0}))]};
  scene.mcv=0;scene.playable=new Int32Array(cells).fill(1);scene.buildable=scene.playable.slice();scene.basePassable=new Uint8Array(cells).fill(1);scene.baseLand=new Uint8Array(cells);
  scene.scene.setup.tiles={...scene.scene.setup.tiles,columns:width,rows:height,cells:new Uint32Array(cells)};
  const battle=new GpuCombat(wrapper.three,scene.setup),economy=new EconomyRuntime(battle,scene);
  try{
    economy.select(0);economy.deploy();let powerQueued=false;
    for(let tick=0;tick<100&&!economy.buildings.get(0)?.active;tick++){
      if(!economy.beginTick())throw new Error('The prior economy report was not consumed');
      if(economy.buildings.has(0)&&!powerQueued){if(economy.buildings.get(0)!.active)throw new Error('The first power plant was not queued during yard construction');economy.choose('NUKE');powerQueued=true;}
      battle.step();await economy.endTick();
    }
    if(economy.queues.items.get('building')?.rate!==2)throw new Error(`The first power plant used rate ${economy.queues.items.get('building')?.rate}, expected 2 from FACTORY.CPP Start`);
    const yard=economy.buildings.get(0),origin=cell-width-1;
    if(!yard?.active||yard.cell!==origin)throw new Error(`MCV deployment used the wrong rectangular-map cell: ${yard?.cell} != ${origin}`);
    for(const [x,y] of BUILDINGS.get('FACT')!.occupy)if(economy.placement.occupied[origin+y*width+x]!==0)throw new Error('Construction yard footprint used the wrong map stride');
    const amount=new Int32Array(cells).fill(-1);amount[40*width+85]=11;
    const ore=new GpuTiberium(wrapper.three,{width,height,amount,variants:new Int32Array(cells),clear:scene.playable,blossom:new Int32Array(cells),playable:scene.playable,seed:1995});
    const radar=new Radar(economy,ore,data),preview=new ConstructionPreview(economy,ore);
    try{
      (battle.sight.mapped.array as Int32Array).fill(1);battle.sight.mapped.needsUpdate=true;radar.update(0,0,24,24);
      if(radar.cellAt(16+80,40+35)!==cell)throw new Error('Radar clicks used the wrong rectangular-map stride');
      const density=await wrapper.three.readRenderTargetPixelsAsync(radar.density,85,40,4,1);
      if(density[0]!==12)throw new Error(`Ore density used the wrong map coordinate: ${density[0]}`);
      const placement=Array.from(scene.playable.keys()).find(cell=>cell%width>64&&canPlaceBuilding(economy.placement,'NUKE',cell,0));
      if(placement===undefined)throw new Error('No power-plant location beside the rectangular-map yard');
      economy.placing='NUKE';preview.update(placement%width*24,Math.trunc(placement/width)*24);
      const outline=await wrapper.three.readRenderTargetPixelsAsync(preview.target,placement%width,Math.trunc(placement/width),4,1);
      if(outline[0]!==1)throw new Error(`The legal rectangular-map building outline was not green: ${outline[0]}`);
    }finally{preview.dispose();radar.dispose();ore.dispose();}
    return true;
  }finally{economy.dispose();battle.dispose();wrapper.dispose();canvas.remove();}
}

export async function compareStructuralDamage(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!renderer)throw new Error('WebGPU is required');
  const cases=[['WEAP',2,100,0,325],['SAM',2,100,0,349],['TRAN',6,50,24,62],['BRIK',2,100,0,0]] as const;
  const width=64,passable=new Uint8Array(width*16).fill(1);
  const setup={grid:gridEdges(width,16,passable,true),land:new Uint8Array(passable.length),passable,seed:0x1995,units:[
    ...cases.map(([name,,,altitude],id)=>({cell:132+id*16,type:movementType(name),altitude})),{cell:1000,type:movementType('MCV')}]};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup);
  try{
    await gpu.prepareForPlay();
    // These independent targets share one world and one compiled set of kernels.
    for(let hit=0;hit<3;hit++){
      for(const [id,[name,bullet,raw,altitude]] of cases.entries()){
        if(hit&&name!=='BRIK')continue;
        const origin=setup.units[id].cell,at=id*WORDS,p=new Int32Array(C.BWORDS),offset=(4*C.SHOTS_PER_UNIT+id)*C.BWORDS;
        const x=name==='WEAP'?(origin%width)*256+128:cpu.units[at+U.UX],y=name==='WEAP'?(Math.trunc(origin/width)+2)*256+128:cpu.units[at+U.UY]-Math.trunc((altitude*256+12)/24);
        p[C.BX]=p[C.BTO_X]=x;p[C.BY]=p[C.BTO_Y]=y;p[C.BACTIVE]=1;p[C.BTYPE]=bullet;p[C.BDAMAGE]=raw;p[C.BTARGET]=id;p[C.BSOURCE]=4;p[C.BEXPLODED]=-1;p[C.BTRAIL_TICK]=-1;
        cpu.projectiles.set(p,offset);
      }
      (gpu.projectiles.array as Int32Array).set(cpu.projectiles);gpu.projectiles.needsUpdate=true;
      cpu.step();gpu.step();
      const actual=await Promise.all([gpu.units,gpu.state].map(async b=>new Int32Array(await renderer.three.getArrayBufferAsync(b))));
      for(const [i,a] of actual.entries()){const expected=i?cpu.state:cpu.units,p=a.findIndex((n,j)=>n!==expected[j]);if(p>=0)throw new Error(`Structural hit ${hit}, buffer ${i}, word ${p}: ${a[p]} != ${expected[p]}`);}
      if(hit<2&&cpu.units[3*WORDS+U.UHEALTH]!==2)throw new Error('Concrete wall was removed before three damage levels');
    }
    for(const [id,[name,,,,expected]] of cases.entries())if(cpu.units[id*WORDS+U.UHEALTH]!==expected)throw new Error(`${name} original damage: ${cpu.units[id*WORDS+U.UHEALTH]} != ${expected}`);
    return true;
  }finally{gpu.dispose();renderer.dispose();canvas.remove();}
}

export async function playEconomyOpening(faction:number){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!renderer)throw new Error('WebGPU is required');
  const scene=economyScene(await loadData(),false,64),battle=new GpuCombat(renderer.three,scene.setup),economy=new EconomyRuntime(battle,scene,faction);
  const ore=new GpuTiberium(renderer.three,scene.tiberium,battle.movement.occupancy),air=new GpuAircraft(battle.movement),operations=new GpuAirOperations(battle,air,scene.playable),transport=new GpuTransport(battle,air,scene.playable,economy.transportState),services=new GpuServices(battle,economy.serviceState),harvest=new GpuHarvest(economy,ore),effects=new GpuBuildingEffects(battle,scene.scene.animation!.frames);
  ore.connect(battle,scene.baseLand,()=>economy.placement.bibs);
  economy.lifecycle.validateTerrain(ore.amount);economy.lifecycle.useAircraft(air.state);economy.select(scene.mcv);economy.deploy();
  const tick=async()=>{
    if(!economy.beginTick())throw new Error('The prior economy report was not consumed');
    battle.movement.beginOccupancyEdits();ore.step();transport.step();services.step(economy.house.money);harvest.step();operations.before();air.step();battle.movement.endOccupancyEdits();battle.step();operations.after();ore.damage(battle.frame);battle.movement.beginOccupancyEdits();effects.step();battle.movement.endOccupancyEdits();await economy.endTick();
  };
  const until=async(test:()=>boolean,limit:number,label:string)=>{console.info(`Economy ${faction}, tick ${battle.frame}: ${label}`);for(let i=0;i<limit&&!test();i++)await tick();if(!test())throw new Error(`${label} did not finish at tick ${battle.frame}: ${economy.message}`);};
  const build=async(name:string)=>{
    const before=[...economy.buildings.values()].filter(b=>b.type===name).length;
    economy.choose(name);await until(()=>!!economy.queues.items.get('building')?.complete,2200,`Produce ${name}`);
    economy.choose(name);await tick();
    const amount=new Int32Array(await renderer.three.getArrayBufferAsync(ore.amount));
    const cell=Array.from(scene.playable.keys()).find(cell=>canPlaceBuilding(economy.placement,name,cell,0)&&placementOffsets(name).every(([x,y])=>amount[cell+y*64+x]<0));
    if(cell===undefined)throw new Error(`No legal ${name} position`);
    economy.click(cell);await until(()=>[...economy.buildings.values()].filter(b=>b.type===name&&b.active).length>before,300,`Place ${name}`);
  };
  try{
    await battle.prepareForPlay();
    await until(()=>[...economy.buildings.values()].some(b=>b.type==='FACT'&&b.active),300,'Deploy MCV');
    for(const name of ['NUKE','NUKE','PROC',faction===2?'HAND':'PYLE',faction===2?'AFLD':'WEAP','HPAD'])await build(name);
    for(const name of ['E1',faction===2?'BGGY':'JEEP',faction===2?'HELI':'ORCA'])economy.choose(name);
    await tick();
    await until(()=>economy.queues.items.size===0,2400,'Produce units');
    await until(()=>economy.house.harvested>=700,3500,'Harvest a full load');
    if(faction===2)await until(()=>economy.deliveredUnits>0,500,'Deliver Nod vehicle');
    const state=new Int32Array(await renderer.three.getArrayBufferAsync(battle.units));
    const vehicle=state.findIndex((value,index)=>index%WORDS===U.UTYPE&&value===movementType(faction===2?'BGGY':'JEEP')&&state[index-U.UTYPE+U.UHEALTH]>0&&state[index-U.UTYPE+U.UATTACHED]===0);
    if(vehicle<0)throw new Error('The produced vehicle was not delivered to the map');
    if(economy.house.money<0)throw new Error('Production overspent the house account');
    // Acceptance-only timestamps reuse this completed base; they exclude rendering and CPU bookkeeping.
    const backend=renderer.three.backend as unknown as {device:GPUDevice;trackTimestamp:boolean},gpuMs:number[]=[];
    if(backend.device.features.has('timestamp-query')){
      backend.trackTimestamp=true;
      try{for(let sample=0;sample<13;sample++){await tick();const time=await renderer.three.resolveTimestampsAsync('compute');if(sample&&time!==undefined)gpuMs.push(time);}}
      finally{backend.trackTimestamp=false;}
    }
    return {faction,ticks:battle.frame,harvested:economy.house.harvested,money:economy.house.money,pool:scene.setup.units.length,gpuComputeMs:gpuMs};
  }finally{effects.dispose();harvest.dispose();services.dispose();transport.dispose();operations.dispose();air.dispose();ore.dispose();economy.dispose();battle.dispose();renderer.dispose();canvas.remove();}
}

/** Sparse actors beyond one prefix-scan workgroup must still reach CPU reports and drawing. */
export async function compareCompactOutputs(){
  const {EconomyReport,REPORT_HEADER}=await import('../src/game/simulation/economy-report.ts');
  const {LaserView}=await import('../src/game/simulation/laser-view.ts');
  const {initialHarvest}=await import('../src/game/simulation/harvest-cpu.ts');
  const {initialTransport}=await import('../src/game/simulation/transport-cpu.ts');
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const renderer=wrapper.three,count=300,passable=new Uint8Array(32*16).fill(1);
  const units=Array.from({length:count},(_,id)=>({type:movementType(id===129||id===257?'OBLI':'MTNK'),cell:id,health:id<200||id===257?100:0}));
  const battle=new GpuCombat(renderer,{grid:gridEdges(32,16,passable,true),land:new Uint8Array(passable.length),passable,units,seed:1995});
  const ledger=new StorageBufferAttribute(initialHarvest(count),1),transport=new StorageBufferAttribute(initialTransport(count),1),services=new StorageBufferAttribute(initialServices(count),1);
  const report=new EconomyReport(battle,ledger,transport,services),laser=new LaserView(battle,new Uint8Array(256*4));
  try{
    report.request([],48);const result=await report.read();
    if(result[17]!==48)throw new Error(`Expected 48 free actor slots, got ${result[17]}`);
    for(let i=0;i<48;i++)if(result[REPORT_HEADER+i*2]!==200+i)throw new Error(`Free actor slot ${i}: ${result[REPORT_HEADER+i*2]} != ${200+i}`);
    // BUILDING.CPP Fire_At draws each Obelisk's last beam, in actor order.
    for(const [index,id] of [129,257].entries()){
      (battle.state.array as Int32Array)[id*C.CWORDS+C.CLAST_FIRE]=0;(battle.state.array as Int32Array)[id*C.CWORDS+C.CCURSOR]=1;
      for(const [i,field] of [C.BFIRE_X,C.BFIRE_Y,C.BTO_X,C.BTO_Y].entries())(battle.projectiles.array as Int32Array)[id*C.SHOTS_PER_UNIT*C.BWORDS+field]=(index*4+i+1)*256;
    }
    battle.state.needsUpdate=battle.projectiles.needsUpdate=true;laser.update(0,0,64,64);
    const actual=new Int32Array(await renderer.getArrayBufferAsync((laser as unknown as {lines:StorageBufferAttribute}).lines));
    const expected=[2,24,48,72,96,120,144,168,192];
    for(let i=0;i<expected.length;i++)if(actual[i]!==expected[i])throw new Error(`Laser beam word ${i}: ${actual[i]} != ${expected[i]}`);
    return true;
  }finally{laser.dispose();report.dispose();battle.dispose();releaseStorage(renderer,[ledger,transport,services]);wrapper.dispose();canvas.remove();}
}
