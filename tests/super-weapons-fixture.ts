import type { WebGPURenderer } from 'three/webgpu';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { GpuTiberium } from '../src/game/simulation/tiberium-gpu.ts';
import { damageTiberium } from '../src/game/simulation/tiberium-cpu.ts';
import type { ExplosionCommand } from '../src/game/simulation/combat-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import * as U from '../src/game/simulation/units-state.ts';

export async function compareMultiplayerTargets(renderer:WebGPURenderer){
  const passable=new Uint8Array(20*16).fill(1),setup={grid:gridEdges(20,16,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,multiplayer:true,
    units:[{cell:22,type:movementType('LTNK')},{cell:245,type:movementType('FACT'),owner:1},{cell:24,type:movementType('E6')},{cell:26,type:movementType('RMBO')},{cell:249,type:movementType('JEEP'),owner:1}]};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer,setup);cpu.humanOwner=-1;gpu.humanOwner.value=-1;
  for(let id=0;id<setup.units.length;id++)cpu.state[id*C.CWORDS+C.CMISSION]=[0,2,3].includes(id)?C.HUNT:C.MOVE;
  (gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
  try{
    await gpu.prepareForPlay();
    for(let tick=1;tick<=16;tick++){
      cpu.step();gpu.step();const actual=await gpu.snapshot(),expected=cpu.buffers();
      actual.forEach((buffer,b)=>{for(let i=0;i<buffer.length;i++)if(buffer[i]!==expected[b][i])throw new Error(`Multiplayer targets tick ${tick}, buffer ${b}/${i}: GPU ${buffer[i]}, CPU ${expected[b][i]}`);});
      if(tick===1&&(cpu.state[C.CTARGET]!==1||cpu.units[2*U.WORDS+U.UABILITY_TARGET]!==2||cpu.state[3*C.CWORDS+C.CTARGET]!==1))throw new Error('Multiplayer hunters did not choose eligible undiscovered targets');
    }
  }finally{gpu.dispose();}
}

export async function compareCloaking(renderer:WebGPURenderer){
  const passable=new Uint8Array(20*12).fill(1),setup={grid:gridEdges(20,12,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,
    units:[{cell:88,type:movementType('STNK'),facing:64},{cell:168,type:movementType('STNK'),owner:1,facing:192}]};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer,setup);
  try{
    await gpu.prepareForPlay();
    for(let tick=1;tick<=100;tick++){
      if(tick===40){const blasts=[{frame:40,x:cpu.units[U.UX],y:cpu.units[U.UY],damage:10,warhead:0,source:-1}];cpu.queueExplosions(blasts);gpu.queueExplosions(blasts);}
      const commands=tick===60?[{frame:60,kind:'attack-ground' as const,target:89,ids:[0]}]:[];
      cpu.step(commands);gpu.step(commands);
      const actual=await gpu.snapshot(),expected=cpu.buffers();
      actual.forEach((buffer,b)=>{for(let i=0;i<buffer.length;i++)if(buffer[i]!==expected[b][i])throw new Error(`Cloak tick ${tick}, buffer ${b}/${i}: GPU ${buffer[i]}, CPU ${expected[b][i]}`);});
    }
  }finally{gpu.dispose();}
}

export async function compareSpecialInfantry(renderer:WebGPURenderer){
  const passable=new Uint8Array(20*12).fill(1);
  const setup={grid:gridEdges(20,12,passable,true),land:new Uint8Array(passable.length),passable,seed:1995,
    units:[{cell:84,type:movementType('E6')},{cell:105,type:movementType('NUKE'),owner:1},
      {cell:94,type:movementType('RMBO')},{cell:115,type:movementType('SILO'),owner:1},
      {cell:22,type:movementType('E6')},{cell:43,type:movementType('NUKE')}]};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer,setup);
  for(let id=0;id<setup.units.length;id++)cpu.state[id*C.CWORDS+C.CMISSION]=C.MOVE;
  (gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
  const commands=[{frame:1,kind:'attack' as const,target:1,ids:[0]},{frame:1,kind:'attack' as const,target:3,ids:[2]},
    {frame:1,kind:'attack' as const,target:5,ids:[4]}];
  try{
    await gpu.prepareForPlay();cpu.step(commands);gpu.step(commands);
    for(let tick=2;tick<=200;tick++){
      cpu.step();gpu.step();
      if(tick%8===0){const actual=await gpu.snapshot(),expected=cpu.buffers();actual.forEach((buffer,b)=>{for(let i=0;i<buffer.length;i++)if(buffer[i]!==expected[b][i])throw new Error(`Special infantry tick ${tick}, buffer ${b}/${i}: GPU ${buffer[i]}, CPU ${expected[b][i]}`);});}
    }
    if(cpu.units[U.WORDS+U.UOWNER]!==0||cpu.units[U.UHEALTH]!==0||cpu.units[3*U.WORDS+U.UHEALTH]!==0)throw new Error('Capture or C4 did not finish');
    if(cpu.units[4*U.WORDS+U.UHEALTH]!==25)throw new Error('An engineer entered an allied building after an invalid attack order');
  }finally{gpu.dispose();}
}

export async function compareSpecialExplosions(renderer: WebGPURenderer) {
  const width = 20, height = 16, cells = width * height, passable = new Uint8Array(cells).fill(1);
  const setup = { grid: gridEdges(width, height, passable, true), passable, land: new Uint8Array(cells), seed: 1995,
    units: [{ cell: 84, type: movementType('NUKE') }, { cell: 128, type: movementType('MTNK') },
      { cell: 148, type: movementType('E1') }, { cell: 149, type: movementType('E4') }, { cell: 90, type: movementType('BRIK') }],
  };
  for (const kind of ['ion', 'nuke'] as const) {
    const cpu = new CpuCombat(setup), gpu = new GpuCombat(renderer, setup);
    const amount = new Int32Array(cells).fill(11);
    const ore = new GpuTiberium(renderer, { width, height, seed: 1995, amount, variants: new Int32Array(cells), clear: new Int32Array(cells), blossom: new Int32Array(cells), playable: new Int32Array(cells).fill(1) });
    ore.connect(gpu, setup.land);
    const commands: ExplosionCommand[] = kind === 'ion' ? [{ frame: 1, x: 8 * 256 + 128, y: 6 * 256 + 128, damage: 600, warhead: 5, source: -1, crater: true, scorch: true }] :
      Array.from({ length: 49 }, (_, i) => ({ frame: 1, x: (5 + Math.trunc(i / 7)) * 256 + 128, y: (3 + i % 7) * 256 + 128, damage: 100, warhead: 3, source: -1, scorch: true }));
    try {
      await gpu.prepareForPlay(); await ore.prepareForPlay();
      cpu.queueExplosions(commands); gpu.queueExplosions(commands); cpu.step(); gpu.step();
      damageTiberium(amount, cpu.projectiles, cpu.units, width, 1, commands); ore.damage(1);
      const actual = await gpu.snapshot(), expected = cpu.buffers();
      actual.forEach((buffer, b) => { for (let i = 0; i < buffer.length; i++) if (buffer[i] !== expected[b][i]) throw new Error(`${kind} damage buffer ${b}/${i}: GPU ${buffer[i]}, CPU ${expected[b][i]}`); });
      const mined = new Int32Array(await renderer.getArrayBufferAsync(ore.amount));
      for (let i = 0; i < cells; i++) if (mined[i] !== amount[i]) throw new Error(`${kind} Tiberium damage differs at ${i}`);
    } finally { ore.dispose(); gpu.dispose(); }
  }
}
