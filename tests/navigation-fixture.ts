import { createRenderer } from '../src/engine/renderer.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { CpuUnits } from '../src/game/simulation/units-cpu.ts';
import { GpuUnits } from '../src/game/simulation/units-gpu.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { obstructionScenario, buildingObstructionScenario } from './obstruction-scenario.ts';
import type { WebGPURenderer } from 'three/webgpu';
import { applyArmyOrder, GpuArmyOrders } from '../src/game/ai/army-orders.ts';
import { blockedTerrainExitScenario, infantryTerrainScenario, terrainExitScenario } from './terrain-movement-scenario.ts';
import { PATH_DELAY } from '../src/game/simulation/navigation.ts';

export async function compareUnreachablePrefixes() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!wrapper) throw new Error('WebGPU is required');
  wrapper.three.setAnimationLoop(null);
  wrapper.three.render = () => { throw new Error('Navigation checks must not draw'); };
  const width = 12, height = 8, passable = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y++) passable[y * width + 8] = 0;
  passable[3 * width + 4] = 0;
  const setup = { grid: gridEdges(width, height, passable, true), passable,
    land: new Uint8Array(passable.length), seed: 1995,
    units: [{ cell: 3 * width + 2, type: movementType('E1'), facing: 64 },
      { cell: 5 * width + 2, type: movementType('MTNK'), facing: 64 },
      { cell: 1, type: movementType('E1'), facing: 64 },
      { cell: 3, type: movementType('E1'), facing: 192, owner: 1 }],
  };
  const cpu = new CpuUnits(setup), gpu = new GpuUnits(wrapper.three, setup);
  try {
    await gpu.prepareForPlay();
    for (let frame = 1; frame <= 400; frame++) {
      const commands = frame === 1 ? [
        { frame, kind: 'move' as const, ids: [0], target: 3 * width + 10 },
        { frame, kind: 'move' as const, ids: [1], target: 5 * width + 10 },
        { frame, kind: 'move' as const, ids: [2, 3], target: 2 },
      ] : [];
      cpu.step(commands); gpu.step(commands);
      const reserved = [2, 3].map(id => cpu.units[id * U.WORDS + U.UDEST] >= 0
        ? cpu.units[id * U.WORDS + U.UDEST] : cpu.units[id * U.WORDS + U.UCELL]);
      if (reserved[0] === reserved[1]) throw new Error(`Opposing infantry shared a reservation at tick ${frame}`);
      if (frame === 1 || frame % 10 === 0) {
        const expected = cpu.buffers();
        const actual = await Promise.all(gpu.buffers().map(async buffer =>
          new Int32Array(await wrapper.three.getArrayBufferAsync(buffer))));
        actual.forEach((values, b) => {
          for (let i = 0; i < values.length; i++) if (values[i] !== expected[b][i]) {
            throw new Error(`Partial path tick ${frame}, buffer ${b}/${i}: GPU ${values[i]}, CPU ${expected[b][i]}; goals ${actual[2]} / ${expected[2]}; paths ${actual[9]} / ${expected[9]}`);
          }
        });
      }
    }
    if (cpu.units[U.UCELL] !== 3 * width + 7 || cpu.units[U.WORDS + U.UCELL] !== 5 * width + 7) {
      throw new Error('Actors did not follow the reachable prefix around intermediate obstacles');
    }
    await compareObstructions(wrapper.three);
    await compareInfantryTerrain(wrapper.three);
    await compareTerrainExits(wrapper.three);
    await compareBlockedTerrainExits(wrapper.three);
  } finally { gpu.dispose(); wrapper.dispose(); canvas.remove(); }
}

async function compareBlockedTerrainExits(renderer:WebGPURenderer){
  for(const name of ['E1','MTNK'])for(const headOn of [true,false]){
    const setup=blockedTerrainExitScenario(name,headOn),cpu=new CpuUnits(setup),gpu=new GpuUnits(renderer,setup);
    const goal=3*setup.grid.width+15;
    // The ally is waiting for its previous path retry while retaining a move order.
    cpu.goals.set([goal,3*setup.grid.width+1]);
    cpu.units[U.WORDS+U.UWAIT]=PATH_DELAY;
    (gpu.goals.array as Int32Array).set(cpu.goals);gpu.goals.needsUpdate=true;
    (gpu.units.array as Int32Array).set(cpu.units);gpu.units.needsUpdate=true;
    try{
      await gpu.prepareForPlay();
      for(let frame=1;frame<=600;frame++){
        cpu.step();gpu.step();
        if(frame<=20||frame%10===0){
          const expected=cpu.buffers(),actual=await gpu.snapshot();
          actual.forEach((values,b)=>{
            for(let i=0;i<values.length;i++)if(values[i]!==expected[b][i])throw new Error(`${name} blocked terrain exit (head-on ${headOn}) tick ${frame}, buffer ${b}/${i}: GPU ${values[i]}, CPU ${expected[b][i]}`);
          });
        }
      }
      if(cpu.units[U.UCELL]!==goal)throw new Error(`${name} did not take a free exit around the waiting ally`);
    }finally{gpu.dispose();}
  }
}

async function compareTerrainExits(renderer:WebGPURenderer){
  for(const name of ['E1','MTNK'])for(const scatter of [false,true]){
    const setup=terrainExitScenario(name),cpu=new CpuUnits(setup),gpu=new GpuUnits(renderer,setup);
    try{
      await gpu.prepareForPlay();
      for(let frame=1;frame<=480;frame++){
        const commands:U.UnitCommand[]=frame===1?[{frame,kind:scatter?'scatter':'move',ids:[0],target:17}]:
          frame===241?[{frame,kind:'move',ids:[0],target:29}]:[];
        cpu.step(commands);gpu.step(commands);
        for(const field of [U.UDEST,U.UMIDDLE]){
          const cell=cpu.units[field];
          if(cell>=0&&!setup.passable![cell])throw new Error(`${name} reserved blocked terrain at tick ${frame}`);
        }
        const cell=cpu.units[U.UCELL];
        if(cell!==27&&!setup.passable![cell])throw new Error(`${name} entered another blocked cell at tick ${frame}`);
        if(frame===1||frame%10===0){
          const expected=cpu.buffers(),actual=await gpu.snapshot();
          actual.forEach((values,b)=>{
            for(let i=0;i<values.length;i++)if(values[i]!==expected[b][i])throw new Error(`${name} terrain exit (scatter ${scatter}) tick ${frame}, buffer ${b}/${i}: GPU ${values[i]}, CPU ${expected[b][i]}`);
          });
        }
        if(frame===240&&(scatter?!setup.passable![cell]:cell!==17))throw new Error(`${name} did not leave blocked terrain`);
      }
      if(cpu.units[U.UCELL]!==29)throw new Error(`${name} did not path around terrain after leaving it`);
    }finally{gpu.dispose();}
  }
}

async function compareInfantryTerrain(renderer:WebGPURenderer){
  for(const trapped of [false,true]){
    const setup=infantryTerrainScenario(trapped),cpu=new CpuUnits(setup),gpu=new GpuUnits(renderer,setup),ids=[0,1,2,3,4];
    try{
      await gpu.prepareForPlay();
      for(let frame=1;frame<=360;frame++){
        const commands:U.UnitCommand[]=frame===1||frame===181?[{frame,kind:'move',ids,target:frame===1?35:20}]:[];
        cpu.step(commands);gpu.step(commands);
        for(const id of ids){
          const destination=cpu.units[id*U.WORDS+U.UDEST];
          if(destination>=0&&!setup.passable![destination])throw new Error(`Infantry reserved terrain at tick ${frame}`);
        }
        if(frame===1||frame%10===0){
          const expected=cpu.buffers(),actual=await gpu.snapshot();
          actual.forEach((values,b)=>{
            for(let i=0;i<values.length;i++)if(values[i]!==expected[b][i])throw new Error(`Infantry terrain (saved ${trapped}) tick ${frame}, buffer ${b}/${i}: GPU ${values[i]}, CPU ${expected[b][i]}`);
          });
        }
        if(frame===180&&ids.some(id=>cpu.units[id*U.WORDS+U.UCELL]!==35))throw new Error('The squad did not leave the tree and reach its destination');
      }
    }finally{gpu.dispose();}
  }
}

async function compareObstructions(renderer: WebGPURenderer) {
  const scenarios = [obstructionScenario('E1'), obstructionScenario('MTNK'),
    obstructionScenario('E1', 'E1'), buildingObstructionScenario(),
    obstructionScenario('MTNK'), obstructionScenario('MTNK'), obstructionScenario('E1'), obstructionScenario('C1')];
  scenarios[4].units = [...scenarios[4].units, { cell: 70, type: movementType('MCV'), owner: 1 }];
  scenarios[5].units = [scenarios[5].units[0], { ...scenarios[5].units[1], health: 400 }];
  scenarios[6].units = [{ cell: 52, type: movementType('E1'), owner: 1, facing: 64 },
    { cell: 56, type: movementType('MTNK'), owner: 0, facing: 192 }];
  scenarios[7].units = [{ cell: 51, type: movementType('C1'), owner: 1 },
    { cell: 50, type: movementType('E1') }, { cell: 52, type: movementType('E1') }];
  // Separate corridors by more than weapon range, sharing one renderer and compute setup.
  const width = 24, height = 12 * scenarios.length, passable = new Uint8Array(width * height);
  const units: U.UnitPlacement[] = [], groups: { id: number; goal: number; replacement: number }[] = [];
  scenarios.forEach((scenario, index) => {
    const offset = index * 12 * width;
    passable.set(scenario.passable!, offset);
    groups.push({ id: units.length, goal: (index === 6 ? 53 : 70) + offset, replacement: 50 + offset });
    units.push(...scenario.units.map(unit => ({ ...unit, cell: unit.cell + offset })));
  });
  const setup = { grid: gridEdges(width, height, passable, true), passable,
    land: new Uint8Array(passable.length), seed: 1995, units, multiplayer: true };
  const cpu = new CpuCombat(setup), gpu = new GpuCombat(renderer, setup);
  for (const group of groups) cpu.state[(group.id + 1) * C.CWORDS + C.CARM] = 10000;
  cpu.state[groups[4].id * C.CWORDS + C.CMISSION] = C.HUNT;
  cpu.state[groups[4].id * C.CWORDS + C.CTARGET] = groups[4].id + 2;
  cpu.state[groups[7].id * C.CWORDS + C.CFEAR] = 100;
  cpu.state[groups[7].id * C.CWORDS + C.CPRONE] = 1;
  cpu.state[(groups[7].id + 2) * C.CWORDS + C.CARM] = 10000;
  (gpu.state.array as Int32Array).set(cpu.state); gpu.state.needsUpdate = true;
  let replaced = false;
  try {
    await gpu.prepareForPlay();
    for (let frame = 1; frame <= 1000; frame++) {
      const commands: U.UnitCommand[] = frame === 1 ? groups.flatMap((group, index) =>
        index === 4 || index === 7 ? [] : [{ frame, kind: 'move' as const, ids: [group.id], target: group.goal }]) : [];
      if (!replaced && cpu.state[groups[5].id * C.CWORDS + C.CSUSPENDED_MISSION]) {
        commands.push({ frame, kind: 'move', ids: [groups[5].id], target: groups[5].replacement });
        replaced = true;
      }
      cpu.step(commands); gpu.step(commands);
      if (frame === 1 && cpu.movement.goals[groups[7].id] !== -1) throw new Error('Panic selected a hostile infantry reservation');
      if (frame === 1 || frame % 10 === 0) {
        const expected = cpu.buffers();
        const actual = await Promise.all(gpu.buffers().map(async buffer =>
          new Int32Array(await renderer.getArrayBufferAsync(buffer))));
        actual.forEach((values, b) => {
          for (let i = 0; i < values.length; i++) if (values[i] !== expected[b][i]) {
            throw new Error(`Obstruction tick ${frame}, buffer ${b}/${i}: GPU ${values[i]}, CPU ${expected[b][i]}`);
          }
        });
      }
    }
    for (const group of groups.slice(0, 3)) {
      if (cpu.units[group.id * U.WORDS + U.UCELL] !== group.goal) throw new Error('Move order did not resume after clearing the corridor');
    }
    if (!replaced || cpu.units[groups[5].id * U.WORDS + U.UCELL] !== groups[5].replacement) {
      throw new Error('A replacement player order was lost to the suspended move');
    }
    if (cpu.state[groups[6].id * C.CWORDS + C.CLAST_FIRE] <= 0) throw new Error('The skirmish area guard did not pursue its target');
    const army = new GpuArmyOrders(gpu);
    try {
      await army.prepare();
      for (let frame = 1000; frame < 1040; frame++) {
        const order = { owner: 1, frame, attack: false, forced: false,
          base: { x: 8 * 256 + 128, y: Math.trunc(groups[6].goal / width) * 256 + 128, radius: 512 } };
        applyArmyOrder(cpu, order); army.issue(order);
      }
      const actual = new Int32Array(await renderer.getArrayBufferAsync(gpu.state));
      for (let i = 0; i < actual.length; i++) if (actual[i] !== cpu.state[i]) {
        throw new Error(`Guard shuffle word ${i}: GPU ${actual[i]}, CPU ${cpu.state[i]}`);
      }
    } finally { army.dispose(); }
  } finally { gpu.dispose(); }
}
