import { createRenderer } from '../src/engine/renderer.ts';
import { batchCompute } from '../src/engine/compute-batch.ts';
import { checksum } from '../src/engine/simulation/fixed.ts';
import { loadData } from '../src/game/data-files.ts';
import { collectMapSamples } from '../src/game/map-generator/samples.ts';
import { ultraScene } from '../src/game/ultra-scene.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { CpuAircraft, AIR_WORDS, ACONTACT, AMISSION, ASTATUS, ATIMER } from '../src/game/simulation/aircraft-cpu.ts';
import { GpuAircraft } from '../src/game/simulation/aircraft-gpu.ts';
import { CpuAirOperations } from '../src/game/simulation/air-operations-cpu.ts';
import { GpuAirOperations } from '../src/game/simulation/air-operations-gpu.ts';
import { initialTransport, stepTransport } from '../src/game/simulation/transport-cpu.ts';
import { GpuTransport } from '../src/game/simulation/transport-gpu.ts';
import { initialServices, stepServices } from '../src/game/simulation/services-cpu.ts';
import { GpuServices } from '../src/game/simulation/services-gpu.ts';
import { GpuNaval, NAVAL_WORDS, stepNaval } from '../src/game/campaign/naval.ts';
import { GpuSelection } from '../src/game/simulation/selection.ts';
import { MOVEMENT, movementType } from '../src/game/data/movement.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import type { WebGPURenderer } from 'three/webgpu';
import * as U from '../src/game/simulation/units-state.ts';
import { GpuLifecycle } from '../src/game/simulation/lifecycle-gpu.ts';
import { CWORDS, CMISSION, CAMMO, CLAST_FIRE, CTARGET } from '../src/game/simulation/combat-state.ts';
import { combatTypes } from '../src/game/data/combat.ts';
import { GpuArmyOrders } from '../src/game/ai/army-orders.ts';

function equal(actual: ArrayLike<number>, expected: ArrayLike<number>, label: string) {
  if (actual.length !== expected.length) throw new Error(`${label}: buffer length differs`);
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) throw new Error(`${label} word ${i}: GPU ${actual[i]}, CPU ${expected[i]}`);
}

/** UNIT.CPP Can_Enter_Cell permits opposing gunboats to cross occupied water. */
async function crossingPatrols(renderer:WebGPURenderer){
  const width=16,height=8,cells=width*height,land=new Uint8Array(cells).fill(2),clear=new Uint8Array(cells);
  const setup={grid:gridEdges(width,height,clear,true),land,passable:clear,seed:1995,multiplayer:true,
    units:[{cell:4*width+7,type:movementType('BOAT'),facing:64},{cell:4*width+8,type:movementType('BOAT'),facing:192,owner:1}]};
  const map={width,land,clear,bounds:{x:1,y:1,width:14,height:6},desert:false};
  const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer,setup),state=new Int32Array(2*NAVAL_WORDS),naval=new GpuNaval(gpu,map);
  try{
    await gpu.prepareForPlay();await naval.prepare();
    for(let tick=0;tick<80;tick++){
      stepNaval(cpu,state,map);cpu.step();naval.step();gpu.step();
      const expected=cpu.buffers();(await gpu.snapshot()).forEach((actual,i)=>equal(actual,expected[i],`Crossing patrols ${tick+1}/${i}`));
    }
    if(cpu.units[U.UX]<=cpu.units[U.WORDS+U.UX])throw new Error('The opposing patrols did not pass each other');
  }finally{naval.dispose();gpu.dispose();}
}

/** Actual generated-map opening, including flights, naval missions and a full-army player order. */
export async function compareUltra(journey = false, reference = true) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!wrapper) throw new Error('WebGPU is required');
  const renderer = wrapper.three, mix = await loadData(false, false, true);
  await crossingPatrols(renderer);
  const world = ultraScene(mix, collectMapSamples(mix), { seed: 1995 });
  const cpu = new CpuCombat(world.setup), gpu = new GpuCombat(renderer, world.setup);
  const ca = new CpuAircraft(cpu.movement), ga = new GpuAircraft(gpu.movement);
  const co = new CpuAirOperations(cpu, ca, world.playable), go = new GpuAirOperations(gpu, ga, world.playable);
  const gt = new GpuTransport(gpu, ga, world.playable), gs = new GpuServices(gpu), gn = new GpuNaval(gpu, world.navalMap);
  const count = world.setup.units.length, transport = initialTransport(count), services = initialServices(count), naval = new Int32Array(count * NAVAL_WORDS);
  const pending = new Int32Array(count * 2).fill(-1), selection = new GpuSelection(renderer, gpu.movement, gpu.sight, true);
  const cash = Int32Array.from([10000, 10000]);
  const controlled = world.setup.units.flatMap((unit, id) => unit.owner === 0 && unit.health !== 0 && !unit.attached && MOVEMENT[unit.type].domain !== 2 ? [id] : []);
  gpu.movement.enableOccupancyEdits();
  const lifecycle = new GpuLifecycle(gpu);
  try {
    await gpu.prepareForPlay(); await renderer.compileComputeAsync([...ga.kernels, ...go.beforePass, go.afterPass, ...gt.kernels, ...gs.kernels]);
    await gn.prepare(); await selection.prepare();
    await lifecycle.prepareForPlay();
    for (const order of world.openingOrders) {
      lifecycle.order(order.id, order.mission, order.target, order.cell);
      cpu.movement.goals[order.id] = order.cell; cpu.state[order.id * CWORDS + CMISSION] = order.mission; cpu.state[order.id * CWORDS + CTARGET] = order.target;
    }
    lifecycle.flush();
    const checksums: string[] = [];
    for (let frame = 1; frame <= (reference ? 28 : 0); frame++) {
      // EVENT.CPP MEGAMISSION: group recall and orders resolve on the selected tick.
      if (frame === 25) {
        selection.apply({ action: 'box', x: 0, y: 0, x2: world.setup.grid.width * 256, y2: world.setup.grid.height * 256 });
        const selected = await selection.read();
        if (selected[1] !== controlled.length) throw new Error(`Full-army selection: ${selected[1]} != ${controlled.length}`);
        selection.apply({ action: 'group', group: 4, modifier: 2 });
        selection.apply({ action: 'clear' }); selection.apply({ action: 'group', group: 4 });
        if((await selection.read())[1]!==controlled.length)throw new Error('Full-army group recall lost members');
        selection.apply({action:'point',x:384,y:384});
        for (const id of controlled) if (cpu.units[id * U.WORDS + U.UDOMAIN] === 0) cpu.units[id * U.WORDS + U.UFLAGS] |= U.PLAYER_ORDER;
      }
      if(frame===26)selection.apply({action:'stop'});
      stepNaval(cpu, naval, world.navalMap); cpu.movement.occupy();
      stepTransport(cpu, ca.state, transport, pending, world.playable); stepServices(cpu, services, cash);
      co.before([...cash]); ca.step(); cpu.step(frame === 25 ? [{ kind: 'move', frame, ids: controlled, target:world.setup.grid.width+1 }] : frame===26?[{kind:'stop',frame,ids:controlled}]:[]); co.after();
      batchCompute(renderer, () => {
        gn.step(); gpu.movement.beginOccupancyEdits(); gt.step(); gs.step(10000, 10000); go.before([10000, 10000]); ga.step();
        gpu.movement.endOccupancyEdits(); gpu.step(); go.after();
      });
      if (![1, 8, 20, 28].includes(frame)) continue;
      const expected = [...cpu.buffers(), ca.state, transport, services, naval];
      const actual = [...await gpu.snapshot(), ...await Promise.all([ga.state, gt.state, gs.state, gn.state].map(async buffer => new Int32Array(await renderer.getArrayBufferAsync(buffer))))];
      for(let i=actual.length-1;i>=0;i--)try{equal(actual[i],expected[i],`Ultra tick ${frame}, buffer ${i}`);}catch(error){
        if(i===1||i===9){const word=actual[i].findIndex((value,index)=>value!==expected[i][index]),id=i===1?Math.trunc(word/U.WORDS):word;throw new Error(`${String(error)}; actor ${id} ${MOVEMENT[world.setup.units[id].type].name}; GPU ${Array.from(actual[1].subarray(id*U.WORDS,(id+1)*U.WORDS))}; CPU ${Array.from(cpu.units.subarray(id*U.WORDS,(id+1)*U.WORDS))}`);}throw error;
      }
      checksums.push(Array.from(checksum(expected), word => word.toString(16).padStart(8, '0')).join(''));
    }
    if(reference && cpu.ultraHunt!.flow.status[3]<2)throw new Error('Ultra flow refresh did not publish a second field');
    let operations: { frames: number; rearmed: number[]; landed: number[]; firingOwners: number[]; navalFire: boolean } | undefined;
    if (journey) {
      const army = new GpuArmyOrders(gpu);
      try {
        await army.prepare(); army.issue({ owner: 0, frame: gpu.frame, attack: true, forced: true, all: true });
        for (const order of world.openingOrders) lifecycle.order(order.id, order.mission, order.target, order.cell);
        lifecycle.flush();
        const aircraft = world.setup.units.flatMap((unit, id) => MOVEMENT[unit.type].domain === 1 && combatTypes[unit.type].ammo > 0 ? [id] : []);
        const passengers = world.setup.units.flatMap((unit, id) => unit.attached ? [id] : []);
        const spent = new Set<number>(), rearmed = new Set<number>(), landed = new Set<number>(), firingOwners = new Set<number>();
        let navalFire = false;
        const samples: unknown[] = [];
        while (gpu.frame < 6000) {
          for (let n = 0; n < 100; n++) batchCompute(renderer, () => {
            gn.step(); gpu.movement.beginOccupancyEdits(); gt.step(); gs.step(10000, 10000); go.before([10000, 10000]); ga.step();
            gpu.movement.endOccupancyEdits(); gpu.step(); go.after();
          });
          const [units, combat, air] = await Promise.all([gpu.units, gpu.state, ga.state].map(async buffer => new Int32Array(await renderer.getArrayBufferAsync(buffer))));
          for (const id of aircraft) {
            if (combat[id * CWORDS + CAMMO] < combatTypes[world.setup.units[id].type].ammo) spent.add(id);
            if (spent.has(id) && units[id * U.WORDS + U.UHEALTH] > 0 && combat[id * CWORDS + CAMMO] === combatTypes[world.setup.units[id].type].ammo && air[id * AIR_WORDS + ACONTACT] >= 0) rearmed.add(id);
          }
          if (gpu.frame % 500 < 100) samples.push({ frame: gpu.frame, spent: spent.size, alive: aircraft.filter(id => units[id * U.WORDS + U.UHEALTH] > 0).length,
            aircraft: [aircraft[0], aircraft.at(-1)!].map(id => ({ id, health: units[id * U.WORDS + U.UHEALTH], ammo: combat[id * CWORDS + CAMMO],
              cell: units[id * U.WORDS + U.UCELL], altitude: units[id * U.WORDS + U.UALTITUDE], contact: air[id * AIR_WORDS + ACONTACT],
              mission: air[id * AIR_WORDS + AMISSION], status: air[id * AIR_WORDS + ASTATUS], timer: air[id * AIR_WORDS + ATIMER], target: combat[id * CWORDS + CTARGET] })) });
          if (!reference && gpu.frame % 500 < 100) console.info(`Ultra journey ${gpu.frame}: spent=${spent.size}, rearmed=${rearmed.size}, landed=${landed.size}`);
          for (const id of passengers) if (units[id * U.WORDS + U.UHEALTH] > 0 && units[id * U.WORDS + U.UATTACHED] === 0) landed.add(id);
          for (let id = 0; id < count; id++) if (!MOVEMENT[world.setup.units[id].type].domain && MOVEMENT[world.setup.units[id].type].locomotion < 5 && combat[id * CWORDS + CLAST_FIRE] >= 0) firingOwners.add(units[id * U.WORDS + U.UOWNER]);
          navalFire ||= world.navalIds.some(id => combat[id * CWORDS + CLAST_FIRE] >= 0);
          if (rearmed.size && landed.size && firingOwners.size === 2 && navalFire) break;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        operations = { frames: gpu.frame, rearmed: [...rearmed], landed: [...landed], firingOwners: [...firingOwners], navalFire };
        if (!rearmed.size || !landed.size || firingOwners.size !== 2 || !navalFire) throw new Error(`Ultra combined-arms journey: ${JSON.stringify({ ...operations, samples })}`);
      } finally { army.dispose(); }
    }
    return { units: world.armySize * 2, slots: count, width: world.setup.grid.width, height: world.setup.grid.height, frames: reference ? 28 : 0, checksums, selected: controlled.length, operations };
  } finally { lifecycle.dispose(); selection.dispose(); gn.dispose(); gs.dispose(); gt.dispose(); go.dispose(); ga.dispose(); gpu.dispose(); wrapper.dispose(); canvas.remove(); }
}
