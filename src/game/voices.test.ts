import { it, expect, vi } from 'vitest';
import { UnitVoices } from './voices.ts';
import type { MixSet } from './formats/mix.ts';

it('uses the original vehicle attack response table', () => {
  let loading = '';
  const played: string[] = [];
  class AudioStub {
    state = 'running'; destination = {};
    createBuffer() { return {name:loading,getChannelData:()=>new Float32Array(0)}; }
    createBufferSource() {
      return {buffer:null as null | {name:string},connect(){},disconnect(){},stop(){},
        start() { played.push(this.buffer!.name); }};
    }
    close() { return Promise.resolve(); }
  }
  vi.stubGlobal('AudioContext',AudioStub);
  const bytes = new Uint8Array(12); bytes[11]=1;
  const mix = {get(name:string) { loading=name; return bytes; }} as unknown as MixSet;
  const voices = new UnitVoices(mix);
  try {
    for(let frame=0;frame<128;frame++) voices.play('MTNK',false,0,3 as never,frame);
    // UNIT.CPP Response_Attack: AFFIRM, ACKNOWL, YESSIR, YESSIR, YESSIR.
    expect([...new Set(played)].sort()).toEqual(['ACKNO.V00','AFFIRM1.V00','YESSIR1.V00']);
  } finally { voices.dispose(); vi.unstubAllGlobals(); }
});
