import type { ComputeNode } from 'three/webgpu';
import { createRenderer } from '../src/engine/renderer.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { makeReviewBattle, reviewScenarios } from './review-scenarios.ts';
import { loadData } from '../src/game/data-files.ts';
import { economyScene } from '../src/demo/economy-scene.ts';
import { FactoryProduction } from '../src/game/simulation/economy.ts';
import { PRODUCTION } from '../src/game/data/production.ts';
import { MatchRuntime } from '../src/game/match-runtime.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import type { WebGPURenderer } from 'three/webgpu';

async function checkWallDefeat(renderer:WebGPURenderer){
  const source=economyScene(await loadData(false,true,true),false,16),width=16,height=12,cells=width*height;
  const passable=new Uint8Array(cells).fill(1),playable=new Int32Array(cells).fill(1);
  const units=Array.from({length:16},(_,id)=>({cell:id===0?50:150,type:movementType(id===0?'BRIK':id===1?'MCV':'E1'),owner:id===1?1:0,health:id===0?200:id===1?600:0}));
  const setup={...source.setup,grid:gridEdges(width,height,passable,true),bounds:{x:0,y:0,width,height},passable,land:new Uint8Array(cells),units};
  const world={...source,setup,passable,basePassable:passable,baseLand:setup.land,playable,buildable:playable,
    buildings:[{id:0,type:'BRIK',cell:50,owner:0,faction:1}],mcvs:[1],houses:[{faction:1,credits:10000},{faction:2,credits:10000}] as const};
  const gpu=new GpuCombat(renderer,setup),match=new MatchRuntime(gpu,world);
  for(const commander of match.commanders)commander.enabled=false;
  try{
    await gpu.prepareForPlay();await match.prepareForPlay();
    match.beginTick();gpu.step();await match.endTick();match.beginTick();
    if(match.outcome!==1)throw new Error('A house with only walls was not defeated');
  }finally{match.dispose();gpu.dispose();}
}

async function checkPlacementRetry(renderer:WebGPURenderer){
  const source=economyScene(await loadData(false,true,true),false,16),width=16,height=12,cells=width*height;
  const passable=new Uint8Array(cells).fill(1),playable=new Int32Array(cells).fill(1);
  const units=Array.from({length:16},(_,id)=>({cell:id===0?50:id===2?53:150,
    type:movementType(id===0?'FACT':id===1?'MCV':id===2?'MTNK':'E1'),owner:id===1?1:0,health:id<3?600:0}));
  const setup={...source.setup,grid:gridEdges(width,height,passable,true),bounds:{x:0,y:0,width,height},passable,land:new Uint8Array(cells),units};
  const world={...source,setup,passable,basePassable:passable,baseLand:setup.land,playable,buildable:playable,
    tiberium:{...source.tiberium,width,height,amount:new Int32Array(cells).fill(-1)},
    buildings:[{id:0,type:'FACT',cell:50,owner:0,faction:1}],mcvs:[1],houses:[{faction:1,credits:10000},{faction:2,credits:10000}] as const};
  const gpu=new GpuCombat(renderer,setup),match=new MatchRuntime(gpu,world);
  for(const commander of match.commanders)commander.enabled=false;
  try{
    await gpu.prepareForPlay();await match.prepareForPlay();
    const building=new FactoryProduction(PRODUCTION.get('NUKE')!,match.houses[0].economy);building.stage=108;building.balance=0;match.houses[0].queues.items.set('building',building);
    match.withOwner(0,()=>match.place('NUKE',53));
    match.beginTick();gpu.step();await match.endTick();match.beginTick();
    if(match.houses[0].placementRetryFrame!==46)throw new Error(`Blocked placement retry is ${match.houses[0].placementRetryFrame}, expected tick 46`);
    if(match.houses[0].queues.items.get('building')!==building)throw new Error('A temporary blocker discarded completed production');
  }finally{match.dispose();gpu.dispose();}
}

export async function checkMatchRegressions() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!wrapper) throw new Error('WebGPU is required');
  wrapper.three.setAnimationLoop(null); wrapper.three.render = () => { throw new Error('Logic regressions must not draw'); };
  const failures: string[] = [];
  try {
    for (const scenario of reviewScenarios) {
      const cpu = makeReviewBattle(scenario), gpu = new GpuCombat(wrapper.three, cpu.setup);
      gpu.humanOwner.value = cpu.humanOwner; gpu.movement.frame = cpu.frame;
      (gpu.movement.control.array as Int32Array)[0] = cpu.frame; gpu.movement.control.needsUpdate = true;
      for (const [buffer, values] of [[gpu.units, cpu.units], [gpu.state, cpu.state], [gpu.projectiles, cpu.projectiles],
        [gpu.movement.goals, cpu.movement.goals]] as const) { (buffer.array as Int32Array).set(values); buffer.needsUpdate = true; }
      try {
        await gpu.prepareForPlay(); gpu.movement.refreshOccupancy();
        // A post-movement fixture skips prepareStep, which normally initializes COMMANDS.
        if(scenario.resolveOnly)wrapper.three.compute((gpu as unknown as {upload:ComputeNode}).upload);
        for (let tick = 0; tick < (scenario.ticks ?? 1); tick++) {
          if (scenario.resolveOnly) { cpu.resolveStep(); gpu.syncUploads(); gpu.resolveStep(); }
          else { cpu.step(); gpu.step(); }
          for (const [buffer, expected] of [[gpu.units, cpu.units], [gpu.state, cpu.state], [gpu.projectiles, cpu.projectiles],
            [gpu.movement.goals, cpu.movement.goals], [gpu.movement.pathGoals, cpu.movement.pathGoals], [gpu.sight.mapped, cpu.sight.mapped]] as const) {
            const actual = new Int32Array(await wrapper.three.getArrayBufferAsync(buffer));
            const word = actual.findIndex((value, i) => value !== expected[i]);
            if (word >= 0) throw new Error(`tick ${tick + 1}, word ${word}: GPU ${actual[word]}, CPU ${expected[word]}`);
          }
        }
        scenario.verify(cpu);
      } catch (error) { failures.push(`${scenario.name}: ${error}`); }
      finally { gpu.dispose(); }
    }
    try{await checkWallDefeat(wrapper.three);}catch(error){failures.push(`Wall defeat: ${error}`);}
    try{await checkPlacementRetry(wrapper.three);}catch(error){failures.push(`Placement retry: ${error}`);}
    if (failures.length) throw new Error(failures.join('\n'));
  } finally { wrapper.dispose(); canvas.remove(); }
}
