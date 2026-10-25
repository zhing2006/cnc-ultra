// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { ReadbackBuffer, StorageBufferAttribute, Vector4, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, int, uint, storage, instanceIndex, atomicMin, atomicStore, atomicLoad, uniform, abs, select } from 'three/tsl';
import { weapons, bullets, animations, combatTypes } from '../data/combat.ts';
import { MOVEMENT,movementType } from '../data/movement.ts';
import { PRODUCTION } from '../data/production.ts';
import { decodeAud } from '../formats/aud.ts';
import type { MixSet } from '../formats/mix.ts';
import type { GpuCombat } from './combat-gpu.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { randomNode, intMin, intMax } from '../../engine/simulation/integer-nodes.ts';
import { deathAnimation, deathVoice, DEATH_SOUNDS, COMMANDO_TAUNTS, soundGain } from './combat-effects.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
/** Bounded sound events, with visible sources preferred before reducing duplicate sounds. */
export class CombatAudio {
  private readonly context = new AudioContext();
  private readonly buffers = new Map<number, AudioBuffer>();
  private readonly playing = new Set<{
    sound: number;
    gain: number;
    source: AudioBufferSourceNode;
  }>();
  private readonly attributes: StorageBufferAttribute[] = [];
  private readonly passes: ComputeNode[];
  private readonly events: StorageBufferAttribute;
  private readonly readback: ReadbackBuffer;
  private readonly view = uniform(new Vector4());
  private busy = false;
  private disposed = false;
  private lastFrame = -1;
  onShake?: () => void;
  constructor(private readonly renderer: WebGPURenderer, battle: GpuCombat, mix: MixSet) {
    const names = [...new Set([...weapons.map(w => w.sound), ...animations.map(a => a.sound), ...DEATH_SOUNDS, ...COMMANDO_TAUNTS,'CRUMBLE','OBELPOWR'])].filter(Boolean);
    names.forEach((name, i) => {
      const bytes = mix.get(`${name}.AUD`);
      if (!bytes)
        return;
      const sound = decodeAud(bytes), input = new DataView(sound.pcm.buffer, sound.pcm.byteOffset, sound.pcm.byteLength);
      const buffer = this.context.createBuffer(1, sound.pcm.length / (sound.bits / 8), sound.rate);
      const data = buffer.getChannelData(0);
      for (let j = 0; j < data.length; j++)
        data[j] = sound.bits === 8 ? (sound.pcm[j] - 128) / 128 : input.getInt16(j * 2, true) / 32768;
      this.buffers.set(i, buffer);
    });
    const keep = (array: Int32Array | Uint32Array) => {
      const b = new StorageBufferAttribute(array, 1);
      this.attributes.push(b);
      return b;
    };
    this.events = keep(new Int32Array(names.length * 3 + 2));
    this.readback = new ReadbackBuffer(this.events.array.byteLength);
    const result = storage(this.events, 'int', this.events.count);
    const chosen = storage(keep(new Uint32Array(names.length)), 'uint', names.length).toAtomic();
    const shake = storage(keep(new Uint32Array(1)), 'uint', 1).toAtomic();
    const c = storage(battle.state, 'int', battle.state.count).toReadOnly();
    const u = storage(battle.units, 'int', battle.units.count).toReadOnly();
    const p = storage(battle.projectiles, 'int', battle.projectiles.count).toReadOnly();
    const clock = storage(battle.movement.control, 'int', 2).toReadOnly();
    const count = battle.setup.units.length, shots = count * C.SHOTS_PER_UNIT;
    const stride = 2 ** Math.ceil(Math.log2(shots * 2 + count * 3));
    const rankLimit = Math.floor(0xffffffff / stride) - 1;
    const values = [...weapons.map(w => names.indexOf(w.sound)),
    ...bullets.map(b => names.indexOf(animations[b.explosion]?.sound ?? '')),
    ...combatTypes.flatMap((_, type) => [0, 1].map(ammo => names.indexOf(animations[deathAnimation(type, ammo)]?.sound ?? ''))),
    ...combatTypes.flatMap((_, type) => Array.from({ length: 4 }, (_, i) => names.indexOf(deathVoice(type, 0, i)))),
    ...combatTypes.map((_, type) => names.indexOf(deathVoice(type, 3, 0))),
      ...MOVEMENT.map((m, i) => m.domain===2?Math.trunc((PRODUCTION.get(m.name)?.cost??0)/400):Number(!m.infantry && m.strength > 400 && combatTypes[i].explosion >= 0)),
      ...COMMANDO_TAUNTS.map(name=>names.indexOf(name))];
    const animBase = weapons.length + bullets.length, voiceBase = animBase + combatTypes.length * 2;
    const fireBase = voiceBase + combatTypes.length * 4, shakeBase = fireBase + combatTypes.length;
    const tauntBase = shakeBase + MOVEMENT.length;
    const table = storage(keep(Int32Array.from(values)), 'int', values.length).toReadOnly();
    const choose = (sound: Node<'int'>, event: Node<'int'>, x: Node<'int'>, y: Node<'int'>) => {
      const onScreen = x.greaterThanEqual(int(this.view.x)).and(y.greaterThanEqual(int(this.view.y)))
        .and(x.lessThan(int(this.view.x.add(this.view.z)))).and(y.lessThan(int(this.view.y.add(this.view.w))));
      const distance = intMax(abs(x.sub(int(this.view.x.add(this.view.z.div(2))))), abs(y.sub(int(this.view.y.add(this.view.w.div(2)))))).div(256);
      const rank = select(onScreen, int(0), intMin(int(rankLimit), distance.add(1)));
      If(sound.greaterThanEqual(0), () => { atomicMin(chosen.element(sound), uint(rank).mul(uint(stride)).add(uint(event))); });
    };
    const clear = Fn(() => {
      atomicStore(chosen.element(instanceIndex), uint(0xffffffff));
      If(instanceIndex.equal(0), () => { atomicStore(shake.element(0), uint(0)); });
    })().compute(names.length);
    const collect = Fn(() => {
      const id = int(instanceIndex), b = id.mul(C.BWORDS);
      If(p.element(b.add(C.BBORN)).equal(clock.element(0)).and(clock.element(0).greaterThan(0)), () => {
        const source=p.element(b.add(C.BSOURCE));
        // EA BUILDING.CPP Fire_At leaves SAM silent; Nyerguds adds its firing sound.
        If(source.lessThan(0).or(u.element(source.mul(U.WORDS).add(U.UTYPE)).notEqual(movementType('SAM'))),()=>{
          choose(table.element(p.element(b.add(C.BWEAPON))), id, p.element(b.add(C.BFIRE_X)), p.element(b.add(C.BFIRE_Y)));
        });
      });
      If(p.element(b.add(C.BIMPACT)).notEqual(0), () => {
        choose(table.element(p.element(b.add(C.BTYPE)).add(weapons.length)), id.add(shots), p.element(b), p.element(b.add(1)));
      });
    })().compute(shots);
    const deaths = Fn(() => {
      const id = int(instanceIndex), at = id.mul(U.WORDS), state = id.mul(C.CWORDS), type = u.element(at.add(U.UTYPE));
      If(type.equal(movementType('OBLI')).and(c.element(state.add(C.CCHARGE)).equal(1)),()=>{choose(int(names.indexOf('OBELPOWR')),id.add(shots*2),u.element(at),u.element(at.add(1)));});
      If(c.element(state.add(C.CCELEBRATED)).equal(clock.element(0))
        .and(type.equal(int(MOVEMENT.findIndex(t=>t.name==='RMBO')))), () => {
        choose(table.element(c.element(state.add(C.CTAUNT)).add(tauntBase)),
          id.add(shots*2+count*2),u.element(at),u.element(at.add(1)));
      });
      If(c.element(state.add(C.CDEATH)).equal(clock.element(0)), () => {
        const wh = c.element(state.add(C.CWARHEAD));
        const random = int(randomNode(uint(battle.setup.seed), uint(clock.element(0)), uint(id), uint(70)).mod(uint(4)));
        const voice = table.element(type.mul(4).add(voiceBase).add(random)).toVar();
        If(wh.equal(3).or(wh.equal(4)).or(wh.equal(5)), () => { voice.assign(table.element(type.add(fireBase))); });
        If(wh.equal(C.CRUSHED), () => { voice.assign(names.indexOf('SQUISH2')); });
        choose(voice, id.add(shots * 2), u.element(at), u.element(at.add(1)));
        If(wh.notEqual(C.CRUSHED), () => {
          choose(table.element(type.mul(2).add(animBase).add(int(c.element(state.add(C.CAMMO)).greaterThan(0)))), id.add(shots * 2 + count), u.element(at), u.element(at.add(1)));
          // UNIT.CPP Take_Damage: exploding vehicles with MaxStrength > 400.
          If(table.element(type.add(shakeBase)).notEqual(0), () => { atomicStore(shake.element(0), uint(1)); });
          If(u.element(at.add(U.UDOMAIN)).equal(2),()=>{
            choose(int(names.indexOf('CRUMBLE')),id.add(shots*2),u.element(at),u.element(at.add(1)));
            choose(int(names.indexOf('XPLOBIG4')),id.add(shots*2),u.element(at),u.element(at.add(1)));
          });
        });
      });
    })().compute(count);
    const finish = Fn(() => {
      const sound = int(instanceIndex), key = atomicLoad(chosen.element(sound)), event = int(key.mod(uint(stride))), at = sound.mul(3);
      result.element(at).assign(-1);
      If(key.notEqual(uint(0xffffffff)), () => {
        result.element(at).assign(clock.element(0));
        If(event.lessThan(shots * 2), () => {
          const b = event.mod(shots).mul(C.BWORDS);
          result.element(at.add(1)).assign(select(event.lessThan(shots), p.element(b.add(C.BFIRE_X)), p.element(b)));
          result.element(at.add(2)).assign(select(event.lessThan(shots), p.element(b.add(C.BFIRE_Y)), p.element(b.add(1))));
        }).Else(() => {
          const unit = event.sub(shots * 2).mod(count).mul(U.WORDS);
          result.element(at.add(1)).assign(u.element(unit));
          result.element(at.add(2)).assign(u.element(unit.add(1)));
        });
      });
      If(instanceIndex.equal(0), () => {
        result.element(names.length * 3).assign(int(atomicLoad(shake.element(0))));
        result.element(names.length * 3 + 1).assign(clock.element(0));
      });
    })().compute(names.length);
    this.passes = [clear, collect, deaths, finish];
  }
  async prepareForPlay() {
    await this.renderer.compileComputeAsync(this.passes);
  }
  unlock() {
    if (this.context.state === 'suspended')
      void this.context.resume();
  }
  update(x: number, y: number, width: number, height: number) {
    if (this.busy || this.disposed)
      return;
    this.busy = true;
    this.view.value.set(x, y, width, height);
    const view = { x, y, width, height };
    this.renderer.compute(this.passes);
    void this.renderer.getArrayBufferAsync(this.events, this.readback).then(() => {
      if (this.disposed)
        return;
      const events = new Int32Array(this.readback.buffer!);
      if (events[events.length - 1] <= this.lastFrame)
        return;
      for (let i = 0; i < events.length - 2; i += 3) {
        if (events[i] <= this.lastFrame)
          continue;
        const sound = i / 3, buffer = this.buffers.get(sound);
        if (!buffer)
          continue;
        const gain = soundGain(events[i + 1], events[i + 2], view);
        const same = [...this.playing].filter(p => p.sound === sound);
        const candidates = same.length >= 3 ? same : this.playing.size >= 16 ? [...this.playing] : [];
        if (candidates.length) {
          const quiet = candidates.reduce((a, b) => a.gain <= b.gain ? a : b);
          if (quiet.gain > gain)
            continue;
          quiet.source.stop();
          this.playing.delete(quiet);
        }
        const source = this.context.createBufferSource(), volume = this.context.createGain(), pan = this.context.createStereoPanner();
        source.buffer = buffer;
        volume.gain.value = gain * 0.65;
        pan.pan.value = gain === 1 ? 0 : Math.max(-1, Math.min(1, (events[i + 1] - x - width / 2) / 4096));
        source.connect(volume);
        volume.connect(pan);
        pan.connect(this.context.destination);
        const playing = { sound, gain, source };
        this.playing.add(playing);
        source.onended = () => { this.playing.delete(playing); source.disconnect(); volume.disconnect(); pan.disconnect(); };
        source.start();
      }
      if (events[events.length - 2])
        this.onShake?.();
      this.lastFrame = events[events.length - 1];
    }).finally(() => {
      this.readback.release();
      this.busy = false;
      if (this.disposed)
        this.readback.dispose();
    });
  }
  dispose() {
    this.disposed = true;
    for (const p of this.playing)
      p.source.stop();
    void this.context.close();
    if (!this.busy)
      this.readback.dispose();
    for (const p of this.passes)
      p.dispose();
    releaseStorage(this.renderer, this.attributes);
  }
}
