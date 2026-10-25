import type { WebGPURenderer } from 'three/webgpu';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { CpuAircraft,AMISSION,ACONTACT } from '../src/game/simulation/aircraft-cpu.ts';
import { GpuAircraft } from '../src/game/simulation/aircraft-gpu.ts';
import { CpuAirOperations } from '../src/game/simulation/air-operations-cpu.ts';
import { GpuAirOperations } from '../src/game/simulation/air-operations-gpu.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import * as U from '../src/game/simulation/units-state.ts';

export async function compareAirAI(renderer:WebGPURenderer){
  const passable=new Uint8Array(20*16).fill(1),playable=new Int32Array(passable.length).fill(1);
  const setup={grid:gridEdges(20,16,passable,true),passable,land:new Uint8Array(passable.length),seed:1995,multiplayer:true,
    units:[{cell:42,type:movementType('ORCA')},{cell:41,type:movementType('HPAD')},{cell:81,type:movementType('FIX')},{cell:245,type:movementType('NUKE'),owner:1}]};
  for(const mode of ['attack','repair']){
    const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer,setup),ca=new CpuAircraft(cpu.movement),ga=new GpuAircraft(gpu.movement);
    const co=new CpuAirOperations(cpu,ca,playable),go=new GpuAirOperations(gpu,ga,playable);
    cpu.humanOwner=-1;gpu.humanOwner.value=-1;ca.state[AMISSION]=3;ca.state[ACONTACT]=1;
    if(mode==='attack'){cpu.state[C.CMISSION]=C.HUNT;cpu.state[C.CTARGET]=3;}else cpu.units[U.UHEALTH]=60;
    (gpu.units.array as Int32Array).set(cpu.units);gpu.units.needsUpdate=true;
    (gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
    (ga.state.array as Int32Array).set(ca.state);ga.state.needsUpdate=true;
    try{
      await gpu.prepareForPlay();await renderer.compileComputeAsync([...ga.kernels,...go.beforePass,go.afterPass]);
      co.before([1000,1000]);go.before([1000,1000]);
      const buffers=[gpu.units,gpu.state,ga.state,gpu.movement.goals],expected=[cpu.units,cpu.state,ca.state,cpu.movement.goals];
      for(const [b,buffer] of buffers.entries()){
        const actual=new Int32Array(await renderer.getArrayBufferAsync(buffer));
        for(let i=0;i<actual.length;i++)if(actual[i]!==expected[b][i])throw new Error(`Aircraft AI ${mode}, buffer ${b}/${i}: GPU ${actual[i]}, CPU ${expected[b][i]}`);
      }
    }finally{go.dispose();ga.dispose();gpu.dispose();}
  }
}
