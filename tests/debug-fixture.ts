import { createRenderer } from '../src/engine/renderer.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { ANIMATION_IDS } from '../src/game/data/combat.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { CpuBuildingEffects } from '../src/game/simulation/building-effects-cpu.ts';
import { GpuBuildingEffects } from '../src/game/simulation/building-effects-gpu.ts';
import * as E from '../src/game/simulation/building-effects-state.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import { GpuCampaignEvents,ATTACKED } from '../src/game/campaign/events.ts';

function equal(actual: ArrayLike<number>, expected: ArrayLike<number>, label: string) {
  if (actual.length !== expected.length) throw new Error(`${label}: length differs`);
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) throw new Error(`${label}, word ${i}: ${actual[i]} != ${expected[i]}`);
}

export async function checkDebugDamage() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const renderer = await createRenderer(canvas, { onDeviceLost: message => { throw new Error(message); } });
  if (!renderer) throw new Error('WebGPU is required');
  try {
    const setup={grid:gridEdges(20,12,new Uint8Array(240).fill(1),true),land:new Uint8Array(240),seed:1995,
      units:[{type:movementType('MTNK'),cell:105},{type:movementType('MTNK'),cell:107,owner:1}]};
    const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup),events=new GpuCampaignEvents(gpu);
    try{
      cpu.debugDamageOwner=gpu.debugDamageOwner.value=0;cpu.debugDamageScale=gpu.debugDamageScale.value=0;
      cpu.state[C.CSCAN]=100;(gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
      await gpu.prepareForPlay();await events.prepare();
      const hits=[{frame:1,x:cpu.units[0],y:cpu.units[1],damage:100,warhead:3,source:1}];
      cpu.queueExplosions(hits);gpu.queueExplosions(hits);cpu.step();gpu.step();
      (await gpu.snapshot()).forEach((actual,i)=>equal(actual,cpu.buffers()[i],`immune retaliation/${i}`));
      if(!((await events.read())[0]&ATTACKED)||cpu.state[C.CTARGET]!==1)throw new Error('Immune units lost attacked events or retaliation');
    }finally{events.dispose();gpu.dispose();}
    for (const scale of [0, 500, 1000]) {
      const setup = { grid: gridEdges(20, 12, new Uint8Array(240).fill(1), true), land: new Uint8Array(240), seed: 1995,
        units: [{ type: movementType('MCV'), cell: 42 }, { type: movementType('MCV'), cell: 198, owner: 1 },
          { type: movementType('MTNK'), cell: 80, owner: 1 }, { type: movementType('C1'), cell: 81 }] };
      const cpu = new CpuCombat(setup), gpu = new GpuCombat(renderer.three, setup);
      cpu.debugDamageOwner = gpu.debugDamageOwner.value = 0;
      cpu.debugDamageScale = gpu.debugDamageScale.value = scale;
      const check = async (label: string) => (await gpu.snapshot()).forEach((a, i) => equal(a, cpu.buffers()[i], `${label}/${scale}/${i}`));
      try {
        await gpu.prepareForPlay();
        const blasts = [0, 1].map(id => ({ frame: 1, x: cpu.units[id * U.WORDS], y: cpu.units[id * U.WORDS + 1], damage: 100, warhead: 3, source: -1 }));
        cpu.queueExplosions(blasts); gpu.queueExplosions(blasts); cpu.step(); gpu.step(); await check('blast');
        if (cpu.units[U.UHEALTH] !== 600 - (scale ? Math.trunc(69 * scale / 1000) : 0) || cpu.units[U.WORDS + U.UHEALTH] !== 531) throw new Error('Incorrect player blast scaling');

        // Replay a recorded overrun through both combat implementations.
        cpu.units[2 * U.WORDS + U.UOVERRUN_CELL] = 81;
        cpu.units[2 * U.WORDS + U.UOVERRUN_X] = cpu.units[3 * U.WORDS];
        cpu.units[2 * U.WORDS + U.UOVERRUN_Y] = cpu.units[3 * U.WORDS + 1];
        (gpu.units.array as Int32Array).set(cpu.units); gpu.units.needsUpdate = true;
        cpu.resolveStep(); gpu.resolveStep(); await check('crush');
        if (cpu.units[3 * U.WORDS + U.UHEALTH] !== 25 - Math.trunc(25 * scale / 1000)) throw new Error('Incorrect player crush scaling');

        // Sabotage enters the same damage path without creating a projectile.
        for (const id of [0, 1]) { cpu.units[id * U.WORDS + U.UBOMB_TICK] = 2; cpu.units[id * U.WORDS + U.UBOMB_SOURCE] = 0; }
        (gpu.units.array as Int32Array).set(cpu.units); gpu.units.needsUpdate = true;
        cpu.step(); gpu.step(); await check('sabotage');
        if (cpu.units[U.UHEALTH] !== (scale ? 0 : 600) || cpu.units[U.WORDS + U.UHEALTH] !== 0) throw new Error('Incorrect sabotage immunity');
      } finally { gpu.dispose(); }

      // Feed the real attached animation rules enough frames to accumulate damage.
      const fireSetup = { ...setup, units: [{ type: movementType('NUKE'), cell: 42 }, { type: movementType('NUKE'), cell: 198, owner: 1 }] };
      const fireCpu = new CpuCombat(fireSetup), fireGpu = new GpuCombat(renderer.three, fireSetup);
      fireCpu.debugDamageOwner = fireGpu.debugDamageOwner.value = 0; fireCpu.debugDamageScale = fireGpu.debugDamageScale.value = scale;
      const frames = new Map([['BURN-L', new Array(70)]]), effects = new CpuBuildingEffects(fireCpu, frames), gpuEffects = new GpuBuildingEffects(fireGpu, frames);
      try {
        for (const id of [0, 1]) {
          const at = effects.layout.base + id * E.EFFECT_WORDS;
          effects.layout.state[at + E.ETYPE] = ANIMATION_IDS.ANIM_ON_FIRE_BIG + 1;
          effects.layout.state[at + E.ELOOPS] = 4; effects.layout.state[at + E.EPARENT] = id + 1;
          effects.layout.state[at + E.EGEN] = fireCpu.units[id * U.WORDS + U.UGENERATION];
        }
        (gpuEffects.state.array as Int32Array).set(effects.layout.state); gpuEffects.state.needsUpdate = true;
        await gpuEffects.prepareForPlay();
        for (let frame = 1; frame <= 90; frame++) {
          fireCpu.movement.frame = frame; (fireGpu.movement.control.array as Int32Array)[0] = frame; fireGpu.movement.control.needsUpdate = true;
          effects.step(); fireGpu.movement.beginOccupancyEdits(); gpuEffects.step(); fireGpu.movement.endOccupancyEdits();
        }
        const expected = [fireCpu.units, fireCpu.state, effects.layout.state, effects.smudges];
        const actual = await Promise.all([fireGpu.units, fireGpu.state, gpuEffects.state, gpuEffects.smudges].map(async buffer => new Int32Array(await renderer.three.getArrayBufferAsync(buffer))));
        actual.forEach((a, i) => equal(a, expected[i], `attached fire/${scale}/${i}`));
        if (fireCpu.units[U.UHEALTH] !== (scale ? fireCpu.units[U.WORDS + U.UHEALTH] : 400) || fireCpu.units[U.WORDS + U.UHEALTH] >= 400) throw new Error('Incorrect attached fire immunity');
      } finally { gpuEffects.dispose(); fireGpu.dispose(); }
    }
    return true;
  } finally { renderer.dispose(); canvas.remove(); }
}
