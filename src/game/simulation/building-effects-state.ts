import { animations } from '../data/combat.ts';
import { initialUnits,UHEALTH,UGENERATION,WORDS,type UnitsSetup } from './units-state.ts';

export const EFFECT_WORDS=11;
export const ETYPE=0,EFRAME=1,EDELAY=2,ELOOPS=3,EACCUM=4,EPARENT=5,EX=6,EY=7,EBORN=8,EGEN=9,ETIMER=10;
export interface EffectFrames { get(name:string):readonly unknown[]|undefined }
export function buildingEffectCapacity(count:number){return Math.max(128,count*32);}
export function effectDefinitions(frames:EffectFrames){
  return animations.map(a=>({...a,count:a.count<0?(frames.get(a.name)?.length??0):a.count,
    loopEnd:a.loopEnd<0?(frames.get(a.name)?.length??0):a.loopEnd}));
}
export function initialBuildingEffects(setup:UnitsSetup){
  const count=setup.units.length,capacity=buildingEffectCapacity(count),units=initialUnits(setup);
  const state=new Int32Array(count*2+capacity*EFFECT_WORDS);
  for(let id=0;id<count;id++){state[id*2]=units[id*WORDS+UHEALTH];state[id*2+1]=units[id*WORDS+UGENERATION];}
  return {state,capacity,base:count*2};
}
