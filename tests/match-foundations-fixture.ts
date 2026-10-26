import { StorageBufferAttribute, type WebGPURenderer } from 'three/webgpu';
import { Fn, instanceIndex, int, storage } from 'three/tsl';
import { createRenderer } from '../src/engine/renderer.ts';
import { releaseStorage } from '../src/engine/simulation/resources.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { CpuSight, GpuSight } from '../src/game/simulation/sight.ts';
import { SightView } from '../src/game/simulation/sight-view.ts';
import { movementType } from '../src/game/data/movement.ts';
import { initialUnits, WORDS, UX, UTYPE, UGENERATION, UOWNER, UATTACHED } from '../src/game/simulation/units-state.ts';
import { compareAirAI } from './air-ai-fixture.ts';
import { compareSpecialExplosions, compareSpecialInfantry, compareCloaking, compareMultiplayerTargets } from './super-weapons-fixture.ts';
import { GpuArmyOrders, applyArmyOrder } from '../src/game/ai/army-orders.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';

function equal(actual: ArrayLike<number>, expected: ArrayLike<number>, label: string) {
  if (actual.length !== expected.length) throw new Error(`${label}: length differs`);
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) throw new Error(`${label}, word ${i}: ${actual[i]} != ${expected[i]}`);
}

async function compareSight(renderer: WebGPURenderer) {
  const width = 32, height = 12, cells = width * height;
  const values = initialUnits({ grid: gridEdges(width, height, new Uint8Array(cells).fill(1)), land: new Uint8Array(cells), seed: 1995,
    units: [{ cell: 5 * width + 4, type: movementType('MCV'), owner: 0 }, { cell: 5 * width + 26, type: movementType('MCV'), owner: 1 }],
  });
  const units = new StorageBufferAttribute(values, 1);
  const cpu = [0, 1].map(owner => new CpuSight(width, height, 2, owner));
  const gpu = [0, 1].map(owner => new GpuSight(renderer, width, height, units, owner));
  const view = new SightView(gpu[0], gpu[1]);
  const output = new StorageBufferAttribute(new Int32Array(cells * 3), 1), out = storage(output, 'int', cells * 3);
  const project = Fn(() => {
    const cell = int(instanceIndex);
    out.element(cell.mul(3)).assign(view.mappedAt(cell));
    out.element(cell.mul(3).add(1)).assign(int(view.currentAt(cell)));
    out.element(cell.mul(3).add(2)).assign(view.shadowAt(cell));
  })().compute(cells);
  try {
    await renderer.compileComputeAsync([project]);
    for (let position = 0; position < 3; position++) {
      values[WORDS + UX] = (26 - position * 5) * 256 + 128;
      units.needsUpdate = true;
      cpu.forEach(s => s.step(values)); gpu.forEach(s => s.step());
      const before = await Promise.all(gpu.flatMap(s => [s.mapped, s.current, s.shadow]).map(async b => new Int32Array(await renderer.getArrayBufferAsync(b))));
      before.forEach((data, i) => equal(data, [cpu[Math.trunc(i / 3)].mapped, cpu[Math.trunc(i / 3)].current, cpu[Math.trunc(i / 3)].shadow][i % 3], `house sight ${position}/${i}`));
      for (const perspective of [0, 1, 'all'] as const) {
        view.setPerspective(perspective); view.update(); renderer.compute(project);
        const actual = new Int32Array(await renderer.getArrayBufferAsync(output));
        const expected = new Int32Array(cells * 3);
        for (let cell = 0; cell < cells; cell++) {
          const source = perspective === 'all' ? undefined : cpu[perspective];
          expected.set(source ? [source.mapped[cell], source.current[cell], source.shadow[cell]] : [1, cpu[0].current[cell] | cpu[1].current[cell], -1], cell * 3);
        }
        equal(actual, expected, `perspective ${perspective}`);
      }
      const after = await Promise.all(gpu.flatMap(s => [s.mapped, s.current, s.shadow]).map(async b => new Int32Array(await renderer.getArrayBufferAsync(b))));
      after.forEach((data, i) => equal(data, before[i], 'view switching must preserve simulation sight'));
      equal(new Int32Array(await renderer.getArrayBufferAsync(units)), values, 'view switching must preserve actors');
    }
  } finally { project.dispose(); view.dispose(); gpu.forEach(s => s.dispose()); releaseStorage(renderer, [units, output]); }
}

async function compareSightLifecycle(renderer: WebGPURenderer) {
  const width = 20, height = 12, cells = width * height, bounds = { x: 4, y: 3, width: 12, height: 6 };
  const values = initialUnits({ grid: gridEdges(width, height, new Uint8Array(cells).fill(1)), land: new Uint8Array(cells), seed: 1995,
    units: [{ cell: 5 * width + 3, type: movementType('E1'), owner: 0 }, { cell: 5 * width + 16, type: movementType('E1'), owner: 1 }],
  });
  const units = new StorageBufferAttribute(values, 1);
  const cpu = [0, 1].map(owner => new CpuSight(width, height, 2, owner, bounds));
  const gpu = [0, 1].map(owner => new GpuSight(renderer, width, height, units, owner, bounds));
  const step = async (label: string) => {
    units.needsUpdate = true;
    cpu.forEach(s => s.step(values)); gpu.forEach(s => s.step());
    const actual = await Promise.all(gpu.flatMap(s => [s.mapped, s.current, s.shadow]).map(async b => new Int32Array(await renderer.getArrayBufferAsync(b))));
    const expected = cpu.flatMap(s => [s.mapped, s.current, s.shadow]);
    actual.forEach((data, i) => equal(data, expected[i], `${label}/${i}`));
  };
  try {
    await step('off-map reinforcements');
    if (cpu.some(s => s.mapped.some(Boolean))) throw new Error('An off-map source revealed the battlefield');
    values[UX] += 256; values[WORDS + UX] -= 256;
    await step('reinforcements enter playable bounds');
    if (!cpu[0].mapped[5 * width + 3] || !cpu[1].mapped[5 * width + 16]) throw new Error('A valid source footprint was clipped to playable bounds');
    for (const at of [0, WORDS]) { values[at + UTYPE] = movementType('MTNK'); values[at + UGENERATION]++; }
    await step('actor slots reused with a larger sight radius');
    if (!cpu[0].mapped[5 * width + 7] || !cpu[1].mapped[5 * width + 12]) throw new Error('A replacement actor did not reveal its larger footprint');
    values[UATTACHED] = 2;
    await step('boarded actor');
    if (cpu[0].current.some(Boolean)) throw new Error('A boarded actor continued revealing terrain');
    values[UATTACHED] = 0; values[UOWNER] = 1;
    await step('actor changes owner');
    if (!cpu[1].current[5 * width + 4] || cpu[0].current.some(Boolean)) throw new Error('Sight did not follow the actor owner');
  } finally { gpu.forEach(s => s.dispose()); releaseStorage(renderer, [units]); }
}

async function compareArmyOrders(renderer: WebGPURenderer) {
  const setup = { grid: gridEdges(20, 12, new Uint8Array(240).fill(1), true), land: new Uint8Array(240), seed: 1995,
    units: ['MTNK', 'MTNK', 'E6', 'HARV', 'HELI', 'E1'].map((name, id) => ({ cell: 44 + id * 2, type: movementType(name), owner: id % 2 })),
  };
  const cpu = new CpuCombat(setup), gpu = new GpuCombat(renderer, setup), orders = new GpuArmyOrders(gpu);
  try {
    await orders.prepare(); cpu.step(); gpu.step();
    for (const order of [{ owner: 0, frame: 900, attack: true, forced: false }, { owner: 1, frame: 1800, attack: true, forced: true }]) {
      applyArmyOrder(cpu, order); orders.issue(order);
      const actual = await gpu.snapshot();
      actual.forEach((data, i) => equal(data, cpu.buffers()[i], `army order ${order.owner}/${i}`));
    }
  } finally { orders.dispose(); gpu.dispose(); }
}

export async function compareMatchFoundations() {
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:16px;height:16px'; document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!wrapper) throw new Error('No WebGPU');
  try {
    await compareSight(wrapper.three); await compareSightLifecycle(wrapper.three);
    await compareArmyOrders(wrapper.three); await compareSpecialExplosions(wrapper.three); await compareSpecialInfantry(wrapper.three); await compareCloaking(wrapper.three); await compareMultiplayerTargets(wrapper.three); await compareAirAI(wrapper.three);
  }
  finally { wrapper.dispose(); canvas.remove(); }
}
