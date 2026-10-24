import type { WebGPURenderer } from 'three/webgpu';
import { CombatAudio } from '../src/game/simulation/combat-audio.ts';
import type { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import type { MixSet } from '../src/game/formats/mix.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import { movementType } from '../src/game/data/movement.ts';
/** Capture actual GPU-selected Web Audio events without depending on speakers or autoplay. */
export async function verifyCombatAudio(renderer: WebGPURenderer, battle: GpuCombat, mix: MixSet) {
  const original = globalThis.AudioContext, played: {
    name: string;
    gain: number;
  }[] = [];
  let loading = '';
  class AudioStub {
    state = 'running';
    destination = {};
    createBuffer(_channels: number, length: number) { return { name: loading, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() {
      return {
        buffer: null as null | {
          name: string;
        }, next: null as null | {
          gain: {
            value: number;
          };
        },
        connect(target: {
          gain: {
            value: number;
          };
        }) { this.next = target; }, disconnect() { }, stop() { },
        start() { played.push({ name: this.buffer!.name, gain: this.next!.gain.value }); }
      };
    }
    createGain() { return { gain: { value: 0 }, connect() { }, disconnect() { } }; }
    createStereoPanner() { return { pan: { value: 0 }, connect() { }, disconnect() { } }; }
    close() { return Promise.resolve(); }
  }
  Object.defineProperty(globalThis, 'AudioContext', { value: AudioStub, configurable: true });
  const clock = battle.movement.control, shots = battle.projectiles;
  const saved = [clock, shots, battle.state].map(attribute => ({ attribute, values: (attribute.array as Int32Array).slice() }));
  const audio = new CombatAudio(renderer, battle, { get(name: string) { loading = name; return mix.get(name); } } as MixSet);
  const device = (renderer.backend as unknown as {
    device: GPUDevice;
  }).device;
  const create = device.createBuffer;
  let copies = 0;
  device.createBuffer = function(descriptor) {
    if (descriptor.label?.endsWith('_readback'))
      copies++;
    return create.call(this, descriptor);
  };
  try {
    for (let tick = 1; tick <= 2; tick++) {
      (clock.array as Int32Array)[0] = tick;
      clock.needsUpdate = true;
      const p = shots.array as Int32Array;
      p.fill(0);
      for (let id = 0; id < 2; id++) {
        const at = id * C.BWORDS;
        p[at + C.BBORN] = tick;
        p[at + C.BWEAPON] = 10;
        p[at + C.BFIRE_X] = id === 0 ? 30000 : 10000;
        p[at + C.BFIRE_Y] = 512;
      }
      shots.needsUpdate = true;
      audio.update(0, 0, 10240, 8192);
      while (audio['busy'])
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (played.length !== 2 || played.some(p => Math.abs(p.gain - 0.65) > 1e-6))
      throw new Error(`Visible repeated cannon sounds were lost or attenuated: ${JSON.stringify(played)}`);
    let shakes=0;
    audio.onShake=()=>{shakes++;};
    const tank=battle.setup.units.findIndex(u=>u.type===movementType('HTNK'));
    const infantry=battle.setup.units.findIndex(u=>u.type===movementType('E1'));
    const state=battle.state.array as Int32Array;
    state[tank*C.CWORDS+C.CDEATH]=3;
    state[infantry*C.CWORDS+C.CDEATH]=3;
    state[infantry*C.CWORDS+C.CWARHEAD]=3;
    (clock.array as Int32Array)[0]=3;
    (shots.array as Int32Array).fill(0);
    battle.state.needsUpdate=clock.needsUpdate=shots.needsUpdate=true;
    audio.update(0,0,10240,8192);
    while(audio['busy']) await new Promise(resolve=>setTimeout(resolve,0));
    if(shakes!==1 || !played.some(p=>p.name==='YELL1.AUD'))
      throw new Error('Mammoth screen shake or burning infantry voice was lost');
    const commando=battle.setup.units.findIndex(u=>u.type===movementType('RMBO'));
    const comments=['LEFTY1.AUD','LAUGH1.AUD','KEEPEM1.AUD','TUFFGUY1.AUD'];
    for(let i=0;i<comments.length;i++) {
      const tick=4+i;
      state[commando*C.CWORDS+C.CCELEBRATED]=tick;
      state[commando*C.CWORDS+C.CTAUNT]=i;
      (clock.array as Int32Array)[0]=tick;
      battle.state.needsUpdate=clock.needsUpdate=true;
      audio.update(0,0,16384,16384);
      while(audio['busy']) await new Promise(resolve=>setTimeout(resolve,0));
      if(!played.some(p=>p.name===comments[i])) throw new Error(`Commando comment ${comments[i]} was not played`);
    }
    if (copies !== 1)
      throw new Error(`Audio allocated ${copies} readback buffers for seven ticks`);
  }
  finally {
    device.createBuffer = create;
    audio.dispose();
    Object.defineProperty(globalThis, 'AudioContext', { value: original, configurable: true });
    for (const { attribute, values } of saved) {
      (attribute.array as Int32Array).set(values);
      attribute.needsUpdate = true;
    }
  }
}
