// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { decodeAud } from './formats/aud.ts';
import type { MixSet } from './formats/mix.ts';

const SPEECH:Record<string,string>={complete:'CONSTRU1',unitready:'UNITREDY',newoptions:'NEWOPT1',cantdeploy:'DEPLOY1',cantbuild:'DEPLOY1',
  funds:'NOCASH1',reinforcements:'REINFOR1',cancelled:'CANCEL1',building:'BLDGING1',lowpower:'LOPOWER1',underattack:'BASEATK1',
  unitlost:'UNITLOST',buildinglost:'STRCLOST',harvester:'NEEDHARV',silos:'SILOS1',hold:'ONHOLD1',primary:'PRIBLDG1',busy:'BLDG1'};

/** AUDIO.CPP Speak/Speak_AI: one queued line, with duplicate current/queued requests discarded. */
export class Eva {
  private readonly context=new AudioContext();
  private readonly buffers=new Map<string,AudioBuffer>();
  private source:AudioBufferSourceNode|undefined;
  private current='';
  private queued='';
  constructor(mix:MixSet){
    for(const name of new Set(Object.values(SPEECH))){
      const bytes=mix.get(`${name}.AUD`);if(!bytes)continue;
      const sound=decodeAud(bytes),view=new DataView(sound.pcm.buffer,sound.pcm.byteOffset,sound.pcm.byteLength);
      const buffer=this.context.createBuffer(sound.channels,sound.pcm.length/(sound.bits/8)/sound.channels,sound.rate);
      for(let channel=0;channel<sound.channels;channel++){
        const out=buffer.getChannelData(channel);
        for(let i=0;i<out.length;i++){const sample=i*sound.channels+channel;out[i]=sound.bits===8?(sound.pcm[sample]-128)/128:view.getInt16(sample*2,true)/32768;}
      }
      this.buffers.set(name,buffer);
    }
  }
  unlock(){if(this.context.state==='suspended')void this.context.resume();}
  speak(event:string){const name=SPEECH[event];if(name&&name!==this.current&&!this.queued)this.queued=name;}
  step(){
    if(this.source||!this.queued||this.context.state!=='running')return;
    const name=this.queued;this.queued='';const buffer=this.buffers.get(name);if(!buffer)return;
    const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);
    this.current=name;this.source=source;source.onended=()=>{if(this.source===source){this.source=undefined;this.current='';}source.disconnect();};source.start();
  }
  dispose(){this.source?.stop();this.source=undefined;void this.context.close();}
}
