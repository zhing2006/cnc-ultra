import { gridEdges } from '../src/engine/simulation/state.ts';
import { BUILDINGS } from '../src/game/data/buildings.ts';
import { MOVEMENT, movementType } from '../src/game/data/movement.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { applyLifecycle } from '../src/game/simulation/lifecycle-cpu.ts';
import { CREATE, CHANGE_WORDS } from '../src/game/simulation/lifecycle-state.ts';
import { FACTORY_POINT, initialServices, stepServices } from '../src/game/simulation/services-cpu.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';

export function factoryOrderFixture(name: string) {
  const width = 20, height = 16, origin = 84, passable = new Uint8Array(width * height).fill(1);
  for (const [x, y] of BUILDINGS.get(name)!.occupy) passable[origin + y * width + x] = 0;
  const type = movementType(name === 'PROC' ? 'HARV' : name === 'WEAP' ? 'MTNK' : 'E1');
  const setup = { grid: gridEdges(width, height, passable, true), land: new Uint8Array(passable.length), passable,
    bounds: { x: 0, y: 0, width, height }, seed: 1995, units: [
      { type: movementType(name), cell: origin }, { type, cell: 0, health: 0 }, { type, cell: 0, health: 0 },
    ] };
  const cpu = new CpuCombat(setup), services = initialServices(3), [x, y] = FACTORY_POINT[name];
  const cell = origin + Math.trunc(y / 256) * width + Math.trunc(x / 256);
  const spawn = new Int32Array(3 * CHANGE_WORDS);
  spawn.set([CREATE, type, 0, cell, MOVEMENT[type].strength, 160, 0, 0, C.GUARD, 0, 0, 0, -1], CHANGE_WORDS);
  applyLifecycle(cpu, spawn);
  const target = 12 * width + 14;
  const step = (orders: (U.UnitCommand | C.AttackCommand)[] = []) => {
    stepServices(cpu, services, new Int32Array(2)); cpu.step(orders);
  };
  return { setup, cpu, services, spawn, target, step };
}

export async function compareFactoryOrders() {
  const { createRenderer } = await import('../src/engine/renderer.ts');
  const { GpuCombat } = await import('../src/game/simulation/combat-gpu.ts');
  const { GpuServices } = await import('../src/game/simulation/services-gpu.ts');
  const { GpuLifecycle } = await import('../src/game/simulation/lifecycle-gpu.ts');
  const { EconomyReport } = await import('../src/game/simulation/economy-report.ts');
  const { initialHarvest } = await import('../src/game/simulation/harvest-cpu.ts');
  const { initialTransport } = await import('../src/game/simulation/transport-cpu.ts');
  const { StorageBufferAttribute } = await import('three/webgpu');
  const { releaseStorage } = await import('../src/engine/simulation/resources.ts');
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => { throw new Error(message); } });
  if (!wrapper) throw new Error('WebGPU is required');
  const renderer = wrapper.three;
  try {
    for (const name of ['PYLE', 'HAND', 'WEAP', 'PROC']) for (const timing of ['opening', 'moving']) {
      const { setup, cpu, services, spawn, target, step } = factoryOrderFixture(name);
      const gpu = new GpuCombat(renderer, setup), service = new GpuServices(gpu), lifecycle = new GpuLifecycle(gpu);
      const ledger = new StorageBufferAttribute(initialHarvest(3), 1), transport = new StorageBufferAttribute(initialTransport(3), 1);
      const report = new EconomyReport(gpu, ledger, transport, service.state);
      const create = (id: number) => {
        lifecycle.create(id, { type: spawn[CHANGE_WORDS + 1], cell: spawn[CHANGE_WORDS + 3], health: spawn[CHANGE_WORDS + 4], facing: 160, enter: -1 }, { ignore: 0, mission: C.GUARD, arm: 0 });
        if (id !== 1) applyLifecycle(cpu, (lifecycle.commands.array as Int32Array).slice());
        lifecycle.flush();
      };
      const advance = (orders: (U.UnitCommand | C.AttackCommand)[] = []) => { step(orders); service.step(0); gpu.step(orders); };
      const compare = async () => {
        for (const [buffer, expected] of [[gpu.units, cpu.units], [gpu.state, cpu.state], [service.state, services], [gpu.movement.goals, cpu.movement.goals]] as const) {
          const actual = new Int32Array(await renderer.getArrayBufferAsync(buffer));
          const word = actual.findIndex((value, i) => value !== expected[i]);
          if (word >= 0) throw new Error(`${name}/${timing} tick ${cpu.frame}, word ${word}: ${actual[word]} != ${expected[word]}`);
        }
      };
      try {
        await gpu.prepareForPlay(); create(1); advance();
        if (timing === 'moving') for (let tick = 0; tick < 100 && cpu.units[U.WORDS + U.UDEST] < 0; tick++) advance();
        advance([{ frame: cpu.frame + 1, kind: 'move', target, ids: [1] }]);
        for (let tick = 0; tick < 800; tick++) { advance(); if (tick % 100 === 0) await compare(); }
        await compare();
        if (cpu.units[U.WORDS + U.UCELL] !== target || cpu.units[U.WORDS + U.UENTER] !== 0) throw new Error(`${name}/${timing} did not retain the player's destination`);
        report.request([0], 0);
        const facts = await report.read();
        if (facts[report.header + 4] !== 0) throw new Error(`${name}/${timing} still reports its factory busy and would leave production Ready`);
        create(2);
        for (let tick = 0; tick < 250; tick++) advance();
        await compare();
        if (cpu.units[2 * U.WORDS + U.UHEALTH] <= 0 || cpu.units[2 * U.WORDS + U.UENTER] !== 0) throw new Error(`${name}/${timing} cannot release the next produced unit`);
        if (cpu.units[U.WORDS + U.UCELL] !== target) throw new Error(`${name}/${timing} sent the first unit back to its factory`);
      } finally { report.dispose(); releaseStorage(renderer, [ledger, transport]); lifecycle.dispose(); service.dispose(); gpu.dispose(); }
    }
    return true;
  } finally { wrapper.dispose(); canvas.remove(); }
}

export async function compareAirProductionOrders() {
  const { createRenderer } = await import('../src/engine/renderer.ts');
  const { GpuCombat } = await import('../src/game/simulation/combat-gpu.ts');
  const { CpuAircraft, AIR_WORDS, ACONTACT, AMISSION } = await import('../src/game/simulation/aircraft-cpu.ts');
  const { GpuAircraft } = await import('../src/game/simulation/aircraft-gpu.ts');
  const { CpuAirOperations } = await import('../src/game/simulation/air-operations-cpu.ts');
  const { GpuAirOperations } = await import('../src/game/simulation/air-operations-gpu.ts');
  const { GpuTransport } = await import('../src/game/simulation/transport-gpu.ts');
  const { initialTransport, stepTransport } = await import('../src/game/simulation/transport-cpu.ts');
  const { GpuLifecycle } = await import('../src/game/simulation/lifecycle-gpu.ts');
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => { throw new Error(message); } });
  if (!wrapper) throw new Error('WebGPU is required');
  try {
    for (const delivery of ['helipad', 'occupied helipad', 'airstrip']) {
      const width = 20, height = 16, origin = 84, name = delivery === 'airstrip' ? 'AFLD' : 'HPAD';
      const passable = new Uint8Array(width * height).fill(1), playable = new Int32Array(passable.length).fill(1);
      for (const [x, y] of BUILDINGS.get(name)!.occupy) passable[origin + y * width + x] = 0;
      const edge = (Math.trunc(origin / width) + 1) * width + width - 1;
      const setup = { grid: gridEdges(width, height, passable, true), land: new Uint8Array(passable.length), passable,
        bounds: { x: 1, y: 1, width: width - 2, height: height - 2 }, seed: 1995, units: [
          { type: movementType(name), cell: origin },
          delivery === 'airstrip' ? { type: movementType('C17'), cell: edge, facing: 192, altitude: 24, enter: 1 }
            : { type: movementType('ORCA'), cell: origin + 1, health: delivery === 'occupied helipad' ? 125 : 0 },
          delivery === 'airstrip' ? { type: movementType('LTNK'), cell: edge, attached: 2 } : { type: movementType('ORCA'), cell: 0, health: 0 },
        ] };
      const cpu = new CpuCombat(setup), gpu = new GpuCombat(wrapper.three, setup);
      const air = new CpuAircraft(cpu.movement), flight = new GpuAircraft(gpu.movement);
      const ops = new CpuAirOperations(cpu, air, playable), gpuOps = new GpuAirOperations(gpu, flight, playable);
      const transportState = initialTransport(3), pending = new Int32Array(6).fill(-1), transport = new GpuTransport(gpu, flight, playable);
      const lifecycle = new GpuLifecycle(gpu);
      try {
        await gpu.prepareForPlay();
        if (delivery === 'occupied helipad') {
          air.state[AIR_WORDS + ACONTACT] = 0; air.state[AIR_WORDS + AMISSION] = 3;
          cpu.units[U.WORDS] = origin % width * 256 + 256; cpu.units[U.WORDS + 1] = Math.trunc(origin / width) * 256 + 192;
          (gpu.units.array as Int32Array).set(cpu.units); gpu.units.needsUpdate = true;
          (flight.state.array as Int32Array).set(air.state); flight.state.needsUpdate = true;
        }
        if (delivery !== 'airstrip') {
          lifecycle.useAircraft(flight.state);
          lifecycle.create(2, { type: movementType('ORCA'), cell: origin + 1, facing: 32, enter: 1 }, { ignore: 0 });
          applyLifecycle(cpu, (lifecycle.commands.array as Int32Array).slice(), passable, air.state); lifecycle.flush();
        }
        let commanded = false;
        const target = 11 * width + 12;
        for (let tick = 0; tick < 900; tick++) {
          const orders: U.UnitCommand[] = !commanded && tick > 0 && cpu.units[2 * U.WORDS + U.UATTACHED] === 0
            ? [{ frame: cpu.frame + 1, kind: 'move', target, ids: [2] }] : [];
          commanded ||= orders.length > 0;
          stepTransport(cpu, air.state, transportState, pending, playable); ops.before(); air.step(); cpu.step(orders); ops.after();
          gpu.movement.beginOccupancyEdits(); transport.step(); gpuOps.before(); flight.step(); gpu.movement.endOccupancyEdits(); gpu.step(orders); gpuOps.after();
          if (tick % 100 === 0 || tick === 899) for (const [label, buffer, expected] of [
            ['units', gpu.units, cpu.units], ['combat', gpu.state, cpu.state], ['aircraft', flight.state, air.state], ['transport', transport.state, transportState], ['goals', gpu.movement.goals, cpu.movement.goals],
          ] as const) {
            const actual = new Int32Array(await wrapper.three.getArrayBufferAsync(buffer));
            const word = actual.findIndex((value, i) => value !== expected[i]);
            if (word >= 0) throw new Error(`${delivery} tick ${tick}, ${label} word ${word}: ${actual[word]} != ${expected[word]}`);
          }
        }
        if (!commanded || cpu.units[2 * U.WORDS + U.UCELL] !== target || cpu.units[2 * U.WORDS + U.UENTER] !== 0
          || cpu.units[2 * U.WORDS + U.UATTACHED] !== 0 || cpu.movement.goals[2] >= 0) throw new Error(`${delivery} replaced the player's destination or retained a factory contact`);
      } finally { lifecycle.dispose(); transport.dispose(); gpuOps.dispose(); flight.dispose(); gpu.dispose(); }
    }
    return true;
  } finally { wrapper.dispose(); canvas.remove(); }
}
