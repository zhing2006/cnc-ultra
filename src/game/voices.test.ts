import { it, expect, vi } from 'vitest';
import { UnitVoices } from './voices.ts';
import type { MixSet } from './formats/mix.ts';

it.each([
  ['MTNK',false,3,['ACKNO.V00','AFFIRM1.V00','YESSIR1.V00']],
  ['C3',true,1,['GIRLYEAH.AUD']],
  ['C4',true,2,['GIRLOKAY.AUD']],
  ['DELPHI',true,1,['GUYYEAH1.AUD']],
  ['MOEBIUS',true,1,['MCOMND1.AUD','MHELLO1.AUD','MHMMM1.AUD','MYES1.AUD']],
  ['MOEBIUS',true,2,['MCOURSE1.AUD','MYESYES1.AUD']],
] as const)('uses the original %s response table for action %s', (name,infantry,action,expected) => {
  let loading = '';
  const played: string[] = [];
  class AudioStub {
    state = 'running'; destination = {};
    createGain(){return {gain:{value:1},connect(){}};}
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
    for(let frame=0;frame<128;frame++) voices.play(name,infantry,0,action,frame);
    // UNIT.CPP and INFANTRY.CPP Response_Select/Move/Attack; names from AUDIO.CPP.
    expect([...new Set(played)].sort()).toEqual(expected);
  } finally { voices.dispose(); vi.unstubAllGlobals(); }
});
