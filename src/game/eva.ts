// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { AudioBuffers } from './audio-buffers.ts';
import type { MixSet } from './formats/mix.ts';

const SPEECH:Record<string,string>={complete:'CONSTRU1',unitready:'UNITREDY',newoptions:'NEWOPT1',cantdeploy:'DEPLOY1',cantbuild:'DEPLOY1',
  funds:'NOCASH1',reinforcements:'REINFOR1',cancelled:'CANCEL1',building:'BLDGING1',lowpower:'LOPOWER1',underattack:'BASEATK1',
  unitlost:'UNITLOST',buildinglost:'STRCLOST',harvester:'NEEDHARV',silos:'SILOS1',hold:'ONHOLD1',primary:'PRIBLDG1',busy:'BLDG1',
  ioncharging:'IONCHRG1',ionready:'IONREDY1',airready:'AIRREDY1',nukeready:'NUKAVAIL',nukelaunched:'NUKLNCH1',nukeincoming:'NUKE1',notready:'NOREDY1',gdicaptured:'GDICAPT1',nodcaptured:'NODCAPT1'};

const GLOBAL_SPEECH=new Set(['nukeincoming','gdicaptured','nodcaptured']);
/** HOUSE.CPP AI/Attacked, BUILDING.CPP Captured; spectators hear only global announcements. */
export function hearHouseEvent(event:string,owner:number,controller:number|null){return owner===controller||GLOBAL_SPEECH.has(event);}

/** AUDIO.CPP Speak/Speak_AI: one queued line, with duplicate current/queued requests discarded. */
export class Eva {
  private readonly context=new AudioContext();
  private readonly output=this.context.createGain();
  private readonly buffers:AudioBuffers;
  private source:AudioBufferSourceNode|undefined;
  private current='';
  private queued='';
  private muted=false;
  constructor(mix:MixSet){
    this.output.connect(this.context.destination);
    this.buffers=new AudioBuffers(this.context,mix);
  }
  unlock(){if(this.context.state==='suspended')void this.context.resume();}
  setVolume(volume:number){this.output.gain.value=volume/255;}
  setMuted(muted:boolean){
    this.muted=muted;
    if(muted)this.clear();
  }
  clear(){this.queued='';this.current='';this.source?.stop();this.source=undefined;}
  speak(event:string){const name=SPEECH[event];if(!this.muted&&name&&name!==this.current&&!this.queued)this.queued=name;}
  step(){
    if(this.muted||this.source||!this.queued||this.context.state!=='running')return;
    const name=this.queued;this.queued='';const buffer=this.buffers.get(`${name}.AUD`);if(!buffer)return;
    const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.output);
    this.current=name;this.source=source;source.onended=()=>{if(this.source===source){this.source=undefined;this.current='';}source.disconnect();};source.start();
  }
  dispose(){this.source?.stop();this.source=undefined;this.buffers.clear();void this.context.close();}
}
