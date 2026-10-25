// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { randomWord } from '../engine/simulation/fixed.ts';
import { decodeAud } from './formats/aud.ts';
import type { MixSet } from './formats/mix.ts';
// Ported from UNIT.CPP, AIRCRAFT.CPP and INFANTRY.CPP, Response_Select/Response_Move/Response_Attack,
// and AUDIO.CPP, SoundEffectName. Repeated entries preserve the original probabilities.
const VEHICLE = [['VEHIC1', 'UNIT1', 'YESSIR1', 'YESSIR1', 'YESSIR1', 'AWAIT1'], ['MOVOUT1', 'MOVOUT1', 'MOVOUT1', 'ACKNO', 'AFFIRM1', 'AFFIRM1'], ['AFFIRM1', 'ACKNO', 'YESSIR1', 'YESSIR1', 'YESSIR1']];
const INFANTRY = [['ACKNO', 'REPORT1', 'REPORT1', 'YESSIR1', 'YESSIR1', 'READY', 'AWAIT1'], ['MOVOUT1', 'MOVOUT1', 'MOVOUT1', 'ROGER', 'RITWAWA', 'UGOTIT', 'AFFIRM1', 'AFFIRM1'], ['RITWAWA', 'AFFIRM1', 'AFFIRM1', 'UGOTIT', 'NOPROB', 'YESSIR1', 'YESSIR1', 'YESSIR1']];
const COMMANDO = [['YEAH1', 'YES1', 'YO1'], ['GOTIT1', 'ONIT1', 'NOPRBLM1'], ['NOPRBLM1', 'GOTIT1', 'NOPRBLM1', 'ONIT1']];
export class UnitVoices {
  private readonly context = new AudioContext();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly playing = new Set<AudioBufferSourceNode>();
  private sequence = 0;
  private muted = false;
  private playbackEpoch = 0;
  get epoch() { return this.playbackEpoch; }
  constructor(mix: MixSet) {
    const names = new Set([...VEHICLE.flat(), ...INFANTRY.flat()].flatMap(name => ['V00', 'V01', 'V02', 'V03'].map(ext => `${name}.${ext}`)));
    for (const name of COMMANDO.flat())
      names.add(`${name}.AUD`);
    for (const name of names) {
      const bytes = mix.get(name);
      if (!bytes)
        continue;
      const sound = decodeAud(bytes), data = new DataView(sound.pcm.buffer, sound.pcm.byteOffset, sound.pcm.byteLength);
      const buffer = this.context.createBuffer(sound.channels, sound.pcm.length / (sound.bits / 8) / sound.channels, sound.rate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++)
        channel[i] = sound.bits === 8 ? (sound.pcm[i] - 128) / 128 : data.getInt16(i * 2, true) / 32768;
      this.buffers.set(name, buffer);
    }
  }
  unlock() {
    if (this.context.state === 'suspended')
      void this.context.resume();
  }
  setMuted(muted: boolean) {
    if (muted === this.muted) return;
    this.muted = muted;
    this.playbackEpoch++;
    if (muted) { for (const source of this.playing) source.stop(); this.playing.clear(); }
  }
  play(name: string, infantry: boolean, id: number, responseKind: number, frame: number, epoch = this.playbackEpoch) {
    if (this.muted || epoch !== this.playbackEpoch) return;
    const choices = (name === 'RMBO' ? COMMANDO : infantry ? INFANTRY : VEHICLE)[responseKind - 1];
    const response = choices[randomWord(0x1995, frame, id, this.sequence++) % choices.length];
    // Ported from AUDIO.CPP, Sound_Effect: object index parity selects its persistent voice.
    const ext = name === 'RMBO' ? 'AUD' : infantry ? (id % 2 ? 'V03' : 'V01') : (id % 2 ? 'V02' : 'V00');
    const buffer = this.buffers.get(`${response}.${ext}`);
    if (!buffer)
      return;
    // A selection/order has one spokesperson. Bound overlap during rapid repeated input.
    if (this.playing.size >= 4) {
      const first = this.playing.values().next().value!;
      first.stop();
      this.playing.delete(first);
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.playing.add(source);
    source.onended = () => { this.playing.delete(source); source.disconnect(); };
    source.start();
  }
  dispose() {
    for (const source of this.playing)
      source.stop(); this.playing.clear(); void this.context.close();
  }
}
