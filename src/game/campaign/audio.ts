import { decodeAud } from '../formats/aud.ts';
import type { CampaignAssets } from './assets.ts';
import { MusicStream } from './music-stream.ts';

/** One music track at a time; never retain an entire scores.mix archive or decoded playlist. */
export class CampaignAudio {
  private music?: MusicStream;
  private sequence = 0;
  private readonly nodes = new Set<AudioBufferSourceNode>();
  private readonly effects = new Map<string, Promise<AudioBuffer | undefined>>();
  private readonly musicGain: GainNode;
  private readonly effectGain: GainNode;
  constructor(readonly context: AudioContext, private readonly assets: CampaignAssets,private readonly onError:(error:unknown)=>void=error=>{throw error;}) {
    this.musicGain = context.createGain(); this.effectGain = context.createGain();
    this.musicGain.connect(context.destination); this.effectGain.connect(context.destination);
  }
  setVolume(music: number, effects: number) { this.musicGain.gain.value = music / 255; this.effectGain.gain.value = effects / 255; }
  stop() { this.sequence++; this.music?.stop(); this.music = undefined; }
  async fadeMusic(){const stream=this.music;await stream?.fadeOut();if(this.music===stream)this.stop();}
  private async decode(name: string) {
    const source = await this.assets.source(`${name}.AUD`, ['transit.mix', 'scores.mix', 'sounds.mix', 'speech.mix', 'gdi/general.mix', 'general.mix']);
    if (!source) return;
    const sound = decodeAud(await source.read(0, source.size));
    const buffer = this.context.createBuffer(sound.channels, sound.pcm.length / (sound.bits / 8) / sound.channels, sound.rate);
    const view = new DataView(sound.pcm.buffer, sound.pcm.byteOffset, sound.pcm.byteLength);
    for (let channel = 0; channel < sound.channels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) samples[i] = sound.bits === 16
        ? view.getInt16((i * sound.channels + channel) * 2, true) / 32768
        : (sound.pcm[i * sound.channels + channel] - 128) / 128;
    }
    return buffer;
  }
  play(name:string,loop?:boolean,music?:false,volume?:number):Promise<AudioBufferSourceNode|undefined>;
  play(name:string,loop:boolean,music:true,volume?:number):Promise<MusicStream|undefined>;
  async play(name: string, loop = false, music = false, volume = 1):Promise<AudioBufferSourceNode|MusicStream|undefined> {
    if (music) this.stop();
    const sequence = this.sequence;
    if(music){
      if(!this.musicGain.gain.value)return;
      const source=await this.assets.source(`${name}.AUD`,['transit.mix','scores.mix']);
      if(!source||sequence!==this.sequence)return;
      const stream=this.music=new MusicStream(this.context,source,this.musicGain,loop,this.onError,volume);
      try{await stream.ready;}catch(error){if(sequence!==this.sequence)return;throw error;}
      if(sequence!==this.sequence){stream.stop();return;}
      this.music=stream;return stream;
    }
    let pending = this.effects.get(name);
    if (!pending) {
      pending = this.decode(name);
      if (this.effects.size >= 24) this.effects.delete(this.effects.keys().next().value!);
      this.effects.set(name, pending); void pending.catch(() => this.effects.delete(name));
    }
    const buffer = await pending;
    if (!buffer || sequence !== this.sequence) return;
    const node = this.context.createBufferSource(), gain = this.context.createGain();
    node.buffer = buffer; node.loop = loop; gain.gain.value = volume; node.connect(gain); gain.connect(this.effectGain);
    this.nodes.add(node);
    node.addEventListener('ended', () => { this.nodes.delete(node); node.disconnect(); gain.disconnect(); });
    node.start();
    return node;
  }
  dispose() { this.stop(); for (const node of this.nodes) node.stop(); this.nodes.clear(); this.effects.clear(); }
}
