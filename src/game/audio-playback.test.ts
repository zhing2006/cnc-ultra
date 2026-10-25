import { expect, it, vi } from 'vitest';
import { Eva } from './eva.ts';
import { UnitVoices } from './voices.ts';
import type { MixSet } from './formats/mix.ts';

it('drops fast-forward speech and resumes only with new events', () => {
  let loading = '', stopped = 0;
  const played: string[] = [];
  class AudioStub {
    state = 'running'; destination = {};
    createBuffer() { return { name: loading, getChannelData: () => new Float32Array(0) }; }
    createBufferSource() {
      return { buffer: null as null | { name: string }, connect() {}, disconnect() {},
        stop() { stopped++; }, start() { played.push(this.buffer!.name); },
      };
    }
    close() { return Promise.resolve(); }
  }
  vi.stubGlobal('AudioContext', AudioStub);
  const bytes = new Uint8Array(12); bytes[11] = 1;
  const mix = { get(name: string) { loading = name; return bytes; } } as unknown as MixSet;
  const eva = new Eva(mix), voices = new UnitVoices(mix);
  try {
    eva.speak('complete'); eva.step();
    voices.play('MTNK', false, 0, 1, 1);
    expect(played).toHaveLength(2);
    expect(played[0]).toBe('CONSTRU1.AUD');
    eva.speak('underattack');
    const pendingOrder = voices.epoch;
    eva.setMuted(true); voices.setMuted(true);
    const fastOrder = voices.epoch;
    expect(stopped).toBe(2);
    eva.speak('lowpower'); eva.step();
    voices.play('MTNK', false, 0, 2, 2);
    eva.setMuted(false); voices.setMuted(false); eva.step();
    // Selection readbacks may arrive after fast-forward has already been switched off.
    voices.play('MTNK', false, 0, 2, 3, pendingOrder);
    voices.play('MTNK', false, 0, 2, 3, fastOrder);
    expect(played).toHaveLength(2);
    eva.speak('newoptions'); eva.step();
    voices.play('MTNK', false, 0, 2, 3);
    expect(played).toHaveLength(4);
    expect(played[2]).toBe('NEWOPT1.AUD');
  } finally { eva.dispose(); voices.dispose(); vi.unstubAllGlobals(); }
});
