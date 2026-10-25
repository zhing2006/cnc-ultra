import type { CampaignAssets } from './assets.ts';
import type { CampaignAudio } from './audio.ts';

/** THEME.CPP _themes, Is_Allowed: normal-play tracks, in the original playlist order. */
export const THEMES = [
  ['CHRG226M', 'Depth Charge', 256], ['CREP226M', 'Creeping Upon', 222], ['DRIL226M', 'Drill', 272],
  ['DRON226M', 'Drone', 275], ['FIST226M', 'Iron Fist', 212], ['RECN226M', 'Recon', 261], ['VOIC226M', 'Voice Rhythm', 306],
  ['HEAVYG', 'Demolition', 180], ['J1', 'Untamed Land', 187], ['JDI_V2', "Take 'em Out", 183], ['RADIO', 'Radio', 183],
  ['RAIN', 'Rain In The Night', 156], ['AOI', 'Act On Instinct', 168], ['CCTHANG', 'C&C Thang', 193],
  ['FWP', 'Fight, Win, Prevail', 53], ['IND', 'Industrial', 175], ['IND2', 'Canyon Chase', 38], ['JUSTDOIT', 'Just Do It!', 142],
  ['LINEFIRE', 'In The Line Of Fire', 125], ['MARCH', 'March To Doom', 157], ['TARGET', 'Mechanical Man', 173],
  ['NOMERCY', 'No Mercy', 204], ['OTP', 'On The Prowl', 182], ['PRP', 'Prepare For Battle', 211],
  ['STOPTHEM', 'Deception', 190], ['TROUBLE', 'Trouble', 191], ['WARFARE', 'Warfare', 182],
] as const;

/** THEME.CPP From_Name: exact filename first, then a case-sensitive title substring. */
export function resolveTheme(name: string | undefined) {
  if(!name)return undefined;
  return THEMES.find(track=>track[0].toLowerCase()===name.toLowerCase())?.[0]??THEMES.find(track=>track[1].includes(name))?.[0];
}

export class CampaignMusic {
  tracks: (typeof THEMES)[number][] = [];
  selected = 'AOI';
  shuffle = false;
  repeat = false;
  private source?: EventTarget & {stop():void};
  private lastPlayed?:string;
  private epoch = 0;
  constructor(private readonly sound: CampaignAudio, private readonly assets: CampaignAssets, private readonly error: (error: unknown) => void) {}
  async start(theme?:string) {
    const epoch=this.epoch;
    if(!this.tracks.length){
      const available = await Promise.all(THEMES.map(async track => !!await this.assets.source(`${track[0]}.AUD`, ['scores.mix', 'transit.mix'])));
      this.tracks = THEMES.filter((_, index) => available[index]);
    }
    if(epoch!==this.epoch)return;
    await this.play(theme===undefined&&this.lastPlayed?this.nextSong(this.lastPlayed):resolveTheme(theme)??'AOI');
  }
  private nextSong(name:string){
    const choices=this.tracks.filter(track=>track[0]!==name);
    return this.repeat||!choices.length?name:this.shuffle?choices[Math.floor(Math.random()*choices.length)][0]
      :this.tracks[(this.tracks.findIndex(track=>track[0]===name)+1)%this.tracks.length][0];
  }
  /** THEME.CPP Queue_Song: fade the current track for one original timer second. */
  async queue(name?:string){
    const epoch=++this.epoch;this.source=undefined;await this.sound.fadeMusic();
    if(epoch===this.epoch&&name!==undefined)await this.play(name);
  }
  /** THEME.CPP Next_Song: repeat or sequential wrap; shuffle never chooses the same song. */
  async play(name = this.selected) {
    const epoch = ++this.epoch;
    this.selected = name;
    this.lastPlayed=name;
    const source = await this.sound.play(name, false, true);
    if (epoch !== this.epoch) { source?.stop(); return; }
    this.source = source;
    source?.addEventListener('ended', () => {
      if (this.source !== source || epoch !== this.epoch || !this.tracks.length) return;
      // Music selection is presentation state and never consumes the simulation RNG.
      void this.play(this.nextSong(name)).catch(this.error);
    });
  }
  stop() { this.epoch++; this.source = undefined; this.sound.stop(); }
}
