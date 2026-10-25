import { decodeAud } from './formats/aud.ts';
import type { MixSet } from './formats/mix.ts';

/** Decode short game sounds on first use instead of blocking battlefield loading. */
export class AudioBuffers {
  private readonly cache=new Map<string,AudioBuffer|null>();
  constructor(private readonly context:AudioContext,private readonly mix:MixSet,private readonly capacity=32){}
  get(name:string):AudioBuffer|undefined{
    const cached=this.cache.get(name);
    if(cached!==undefined){this.cache.delete(name);this.cache.set(name,cached);return cached??undefined;}
    const bytes=this.mix.get(name);let buffer:AudioBuffer|null=null;
    if(bytes){
      const sound=decodeAud(bytes),view=new DataView(sound.pcm.buffer,sound.pcm.byteOffset,sound.pcm.byteLength);
      buffer=this.context.createBuffer(sound.channels,sound.pcm.length/(sound.bits/8)/sound.channels,sound.rate);
      for(let channel=0;channel<sound.channels;channel++){
        const out=buffer.getChannelData(channel);
        for(let i=0;i<out.length;i++){const sample=i*sound.channels+channel;out[i]=sound.bits===8?(sound.pcm[sample]-128)/128:view.getInt16(sample*2,true)/32768;}
      }
    }
    if(this.cache.size>=this.capacity)this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(name,buffer);return buffer??undefined;
  }
  clear(){this.cache.clear();}
}
