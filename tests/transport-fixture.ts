import { createRenderer } from '../src/engine/renderer.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { GpuTransport } from '../src/game/simulation/transport-gpu.ts';
import { initialTransport,stepTransport,TBASE,TWORDS,TORDER } from '../src/game/simulation/transport-cpu.ts';
import { GpuSelection } from '../src/game/simulation/selection.ts';
import { CpuSight,GpuSight } from '../src/game/simulation/sight.ts';
import { StorageBufferAttribute } from 'three/webgpu';
import { releaseStorage } from '../src/engine/simulation/resources.ts';
import * as U from '../src/game/simulation/units-state.ts';

function equal(actual:ArrayLike<number>,expected:ArrayLike<number>,context:string){
  for(let i=0;i<expected.length;i++)if(actual[i]!==expected[i])throw new Error(`${context}, word ${i}: ${actual[i]} != ${expected[i]}`);
}

export async function compareApcTransport(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  try{
    for(const blocked of [false,true]){
      const width=12,passable=new Uint8Array(144).fill(1),playable=new Int32Array(144).fill(1),carrier=3;
      if(blocked)for(const delta of [-13,-12,-11,-1,1,11,12,13])passable[65+delta]=0;
      const units:U.UnitPlacement[]=Array.from({length:7},(_,i)=>i===carrier?{type:movementType('APC'),cell:65}:
        {type:movementType('E1'),cell:blocked?65:i===6?90:78,slot:(i>carrier?i-1:i)%5,attached:blocked?carrier+1:0});
      // The blocked case starts with one passenger; normal boarding includes a sixth applicant.
      if(blocked)for(let id=1;id<7;id++)if(id!==carrier)units[id].health=0;
      const setup={grid:gridEdges(width,12,passable,true),passable,land:new Uint8Array(144),units,seed:1995};
      const cpu=new CpuCombat(setup),gpu=new GpuCombat(wrapper.three,setup),state=initialTransport(7),air=new Int32Array(),pending=new Int32Array(14).fill(-1);
      const transport=new GpuTransport(gpu,undefined,playable),selection=new GpuSelection(wrapper.three,gpu.movement,gpu.sight,true);
      let moving=false,unloading=blocked;const dropped:number[]=[],expected:number[]=[];
      try{
        await gpu.prepareForPlay();await selection.prepare();await wrapper.three.compileComputeAsync(transport.kernels);
        if(blocked){pending[carrier*2]=6;(gpu.movement.pending.array as Int32Array).set(pending);gpu.movement.pending.needsUpdate=true;}
        else{
          for(let id=0;id<7;id++)if(id!==carrier){pending[id*2]=5;pending[id*2+1]=carrier;}
          selection.apply({action:'box',x:6*256,y:6*256,x2:7*256,y2:8*256});
          selection.apply({action:'point',x:cpu.units[carrier*U.WORDS],y:cpu.units[carrier*U.WORDS+1]});
        }
        for(let frame=1;frame<=750;frame++){
          const cargo=units.map((_,id)=>id).filter(id=>cpu.units[id*U.WORDS+U.UATTACHED]===carrier+1&&cpu.units[id*U.WORDS+U.UHEALTH]>0);
          const commands:U.UnitCommand[]=[];
          if(!blocked&&!moving&&cargo.length===5){
            moving=true;expected.push(...cargo.sort((a,b)=>state[TBASE+b*TWORDS+TORDER]-state[TBASE+a*TWORDS+TORDER]));
            selection.apply({action:'clear'});selection.apply({action:'point',x:cpu.units[carrier*U.WORDS],y:cpu.units[carrier*U.WORDS+1]});
            selection.apply({action:'point',x:8*256+128,y:5*256+128});
            pending[carrier*2]=1;commands.push({frame,kind:'move',ids:[carrier],target:68});
          }else if(!blocked&&moving&&!unloading&&cpu.units[carrier*U.WORDS+U.UCELL]===68&&cpu.units[carrier*U.WORDS+U.UDEST]<0){
            unloading=true;pending[carrier*2]=6;
            selection.apply({action:'point',x:cpu.units[carrier*U.WORDS],y:cpu.units[carrier*U.WORDS+1]});
          }
          stepTransport(cpu,air,state,pending,playable);transport.step();cpu.step(commands);gpu.step();pending.fill(-1);
          for(const id of expected)if(!cpu.units[id*U.WORDS+U.UATTACHED]&&!dropped.includes(id))dropped.push(id);
          if(frame===1||frame%10===0){
            for(const [buffer,want,name] of [[gpu.units,cpu.units,'units'],[gpu.state,cpu.state,'combat'],[transport.state,state,'transport']] as const)
              equal(new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),want,`APC blocked=${blocked}, frame ${frame}, ${name}`);
          }
          if(blocked&&frame===60)break;
          if(dropped.length===5&&cpu.units[carrier*U.WORDS+U.UDOOR]===0&&expected.every(id=>cpu.movement.goals[id]<0))break;
        }
        for(const [buffer,want,name] of [[gpu.units,cpu.units,'units'],[gpu.state,cpu.state,'combat'],[transport.state,state,'transport']] as const)
          equal(new Int32Array(await wrapper.three.getArrayBufferAsync(buffer)),want,`APC final blocked=${blocked}, ${name}`);
        if(blocked){if(cpu.units[U.UATTACHED]!==carrier+1)throw new Error('A blocked APC lost its passenger');}
        else{
          if(!unloading||dropped.length!==5)throw new Error(`APC did not complete boarding, driving and unloading: ${dropped}; ${JSON.stringify(units.map((_,id)=>({id,cell:cpu.units[id*U.WORDS+U.UCELL],attached:cpu.units[id*U.WORDS+U.UATTACHED],goal:cpu.movement.goals[id],slot:cpu.units[id*U.WORDS+U.USLOT],dest:cpu.units[id*U.WORDS+U.UDEST]})))}`);
          equal(dropped,expected,'APC LIFO cargo');
          if(new Set(dropped.map(id=>`${cpu.units[id*U.WORDS]},${cpu.units[id*U.WORDS+1]}`)).size!==5)throw new Error('APC passengers overlap after unloading');
        }
      }finally{selection.dispose();transport.dispose();gpu.dispose();}
    }
    return true;
  }finally{wrapper.dispose();canvas.remove();}
}

export async function compareAircraftSight(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('WebGPU is required');
  const names=['TRAN','ORCA','HELI','A10','C17'],width=48,height=12;
  const units=U.initialUnits({grid:gridEdges(width,height,new Uint8Array(width*height).fill(1),true),land:new Uint8Array(width*height),seed:1995,
    units:[...names.map((name,i)=>({type:movementType(name),cell:width*3+i*8+3,altitude:24})),
      {type:movementType('TRAN'),cell:width*10+3,owner:1,altitude:24},{type:movementType('E1'),cell:width*10+12,attached:1}]});
  const buffer=new StorageBufferAttribute(units,1),cpu=new CpuSight(width,height,7),gpu=new GpuSight(wrapper.three,width,height,buffer);
  try{
    for(let step=0;step<3;step++){
      if(step)for(let id=0;id<5;id++){units[id*U.WORDS+U.UX]+=3*256;units[id*U.WORDS+U.UALTITUDE]=step===1?12:24;}
      buffer.needsUpdate=true;cpu.step(units);gpu.step();
      if(cpu.current.reduce((a,b)=>a+b)!==36)throw new Error('Four scouting aircraft must each reveal one cell; the C-17 reveals none');
      for(const [actual,expected,name] of [[gpu.current,cpu.current,'footprint'],[gpu.mapped,cpu.mapped,'exploration'],[gpu.shadow,cpu.shadow,'shroud']] as const)
        equal(new Int32Array(await wrapper.three.getArrayBufferAsync(actual)),expected,`Aircraft ${name}, step ${step}`);
      if(cpu.mapped[width*3+35+step*3]!==0)throw new Error('C-17 revealed unexplored terrain');
      for(let id=0;id<4;id++)if(cpu.mapped[width*3+id*8+3]!==1)throw new Error('The aircraft route became unexplored');
    }
    return true;
  }finally{gpu.dispose();releaseStorage(wrapper.three,[buffer]);wrapper.dispose();canvas.remove();}
}
