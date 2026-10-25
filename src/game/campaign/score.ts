import type { IndexedScreen } from '../../engine/indexed/screen.ts';
import { decodeFont, type BitmapFont } from '../formats/font.ts';
import { decodeShp, type Shape } from '../formats/shp.ts';
import { WsaVideo } from '../formats/wsa.ts';
import type { CampaignAssets, CampaignSide } from './assets.ts';
import type { CampaignAudio } from './audio.ts';
import { combatTypes } from '../data/combat.ts';
import { movementType } from '../data/movement.ts';
import { ScoreName } from './score-name.ts';
import { RemapCiv, ScoreRemapBldg, ScoreRemapFBall, ScoreRemapGrey, ScoreRemapYellow } from './score-remaps.ts';

export interface ScoreValues {
  leadership: number; efficiency: number; total: number; minutes: number; credits: number; level: number;
  losses: { units: number; buildings: number }[];
}
interface Fame { name: string; score: number; level: number }
interface Caption { label: string; x: number; y: number; colors: number[]; start: number; animate: boolean }
const GREEN = [16, 18, 20, 22, 24, 24, 24, 24, 24, 25, 26, 27, 28, 29, 16, 31];
const RED = [32, 34, 36, 38, 40, 40, 40, 40, 40, 41, 42, 43, 44, 45, 33, 47];
const BLUE = [96, 98, 100, 102, 104, 104, 104, 104, 104, 105, 106, 107, 108, 109, 97, 111];

/** SCORE.CPP, ScoreClass::Presentation and Do_GDI_Graph. All artwork is decoded at run time. */
export class ScorePresentation {
  private tick = 0;
  private nextTick = 0;
  private pressed = false;
  private readonly captions = new Map<string, Caption>();
  private readonly animations = new Map<string, { shape: Shape; x: number; y: number; frames: number; delay: number; start: number }>();
  private background = new Uint8Array(320 * 200);
  private readonly pixels = new Uint8Array(320 * 200);
  private readonly foreground = new Uint8Array(640 * 400);
  private palette = new Uint8Array(768);
  private table: Uint8Array = new Uint8Array(65536);
  private font!: BitmapFont;
  private editing?: { fame: Fame; index: number; name: ScoreName };
  private readonly keys: string[] = [];
  private fast = false;
  private scaledLetter?: { character: string; start: number };
  private lastCreditStage = -1;
  private readonly key = (event: KeyboardEvent) => {
    if (event.ctrlKey && event.code === 'KeyQ') { event.preventDefault(); this.fast = true; return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!this.editing) { this.pressed = true; return; }
    if (event.key === 'Enter' || event.key === 'Backspace' || /^[ -~]$/.test(event.key)) {
      event.preventDefault(); this.keys.push(event.key);
    }
  };
  private readonly click = () => { if (!this.editing) this.pressed = true; };
  constructor(private readonly assets: CampaignAssets, private readonly screen: IndexedScreen, private readonly sound: CampaignAudio,
    private readonly signal: AbortSignal, private readonly error: (error: unknown) => void, private readonly status: (value: string) => void) {}
  private soundEffect(name: string, volume: number) { void this.sound.play(name, false, false, volume / 255).catch(this.error); }
  private text(key: string, label: string, x: number, y: number, colors = GREEN, animate = true) {
    this.captions.set(key, { label, x, y, colors, animate, start: this.tick });
  }
  private shape(target: Uint8Array, shape: Shape, frame: number, x: number, y: number, remap?: Uint8Array, clip?: {x:number;y:number;width:number;height:number}) {
    const pixels = shape.frames[frame];
    for (let dy = 0; dy < shape.height && y + dy < 200; dy++) for (let dx = 0; dx < shape.width && x + dx < 320; dx++) {
      const value = pixels[dy * shape.width + dx];
      if (value && x + dx >= 0 && y + dy >= 0 && (!clip || x+dx>=clip.x&&x+dx<clip.x+clip.width&&y+dy>=clip.y&&y+dy<clip.y+clip.height)) target[(y + dy) * 320 + x + dx] = remap ? remap[value] : value;
    }
  }
  private glyph(character: string, x: number, y: number, colors: number[], white = false) {
    const glyph = this.font.glyphs[character.charCodeAt(0)];
    x*=2;y*=2;
    for (let dy = 0; dy < glyph.height && y + dy < 400; dy++) for (let dx = 0; dx < glyph.width && x + dx < 640; dx++) {
      const value = glyph.pixels[dy * glyph.width + dx];
      if (value && x + dx >= 0 && y + dy >= 0) this.foreground[(y + dy) * 640 + x + dx] = white ? 15 : colors[value];
    }
  }
  private draw() {
    this.pixels.set(this.background);
    this.foreground.fill(255);
    for (const [name, item] of this.animations) {
      const stage = Math.trunc((this.tick - item.start) / item.delay) % item.frames;
      this.shape(this.pixels, item.shape, stage, item.x, item.y);
      if (name === 'CREDS' && stage !== this.lastCreditStage) {
        this.lastCreditStage = stage;
        if (stage < 22) this.soundEffect('CLOCK1', 70);
        else if (stage === 24) this.soundEffect('CASHTURN', 70);
      }
    }
    for (const caption of this.captions.values()) {
      const visible = caption.animate ? Math.min(caption.label.length, this.tick - caption.start) : caption.label.length;
      for (let i = 0; i < visible; i++) this.glyph(caption.label[i], caption.x + i * 6, caption.y, caption.colors);
      if (visible < caption.label.length) {
        this.glyph(caption.label[visible], caption.x + visible * 6, caption.y - 1, caption.colors, true);
        this.glyph(caption.label[visible], caption.x + visible * 6, caption.y + 1, caption.colors, true);
        this.glyph(caption.label[visible], caption.x + visible * 6 + 1, caption.y, caption.colors, true);
      }
    }
    if (this.scaledLetter && this.editing) {
      const letter = this.scaledLetter, stage = 5 - (this.tick - letter.start);
      if (stage > 0) {
        const x = [0, 80, 107, 134, 180, 228][stage] * 2, width = [6, 20, 30, 40, 60, 80][stage] * 2;
        const y = (120 + this.editing.index * 8) * 2, glyph = this.font.glyphs[letter.character.charCodeAt(0)];
        for (let dy = 0; dy < width && y + dy < 400; dy++) for (let dx = 0; dx < width; dx++) {
          const sx = Math.trunc(dx * 10 / width), sy = Math.trunc(dy * 10 / width);
          const value = sx < glyph.width && sy < glyph.height ? glyph.pixels[sy * glyph.width + sx] : 0;
          if (value) this.foreground[(y + dy) * 640 + x + dx] = BLUE[value];
        }
      } else {
        this.text(`name${this.editing.index}`, this.editing.fame.name, 19, 120 + this.editing.index * 8, BLUE, false);
        this.scaledLetter = undefined;
      }
    }
    if (this.editing && Math.trunc(this.tick / 5) % 2 === 0) {
      const x = 19 + this.editing.name.cursor * 6, y = 127 + this.editing.index * 8;
      for (let dy = 0; dy < 2; dy++) this.foreground.fill(10, (y * 2 + dy) * 640 + x * 2, (y * 2 + dy) * 640 + x * 2 + 11);
    }
    this.screen.set(this.pixels, this.palette, 320, 200, this.table);
    this.screen.setForeground(this.foreground);
  }
  private async wait(ticks: number) {
    for (let i = 0; i < ticks; i++) {
      this.signal.throwIfAborted();
      if (document.hidden) { await new Promise(resolve => setTimeout(resolve, 100)); this.nextTick = 0; i--; continue; }
      // Presentation timers use the original 60 Hz clock, independently of monitor refresh.
      this.nextTick = Math.max(this.nextTick, performance.now()) + (this.fast && !this.editing ? 0 : 1000 / 60);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, this.nextTick - performance.now())));
      this.tick++; this.draw();
    }
  }
  async play(side: CampaignSide, values: ScoreValues) {
    const archives = [`${side}/general.mix`, 'general.mix'];
    const names = ['TIME', 'HISCORE1', 'HISCORE2', 'CREDS', 'BAR3YLW', 'BAR3RED'];
    const [animation, palette, font, shapes] = await Promise.all([
      this.assets.bytes(side === 'gdi' ? 'S-GDIIN2.WSA' : 'SCRSCN1.WSA', archives).then(bytes => new WsaVideo(bytes)),
      this.assets.bytes(side === 'gdi' ? 'SCORPAL1.PAL' : 'SNODPAL1.PAL'), this.assets.bytes('12GRNGRD.FNT').then(decodeFont),
      Promise.all(names.map(name => this.assets.bytes(`${name}.SHP`, ['conquer.mix']).then(decodeShp))),
    ]);
    this.palette = animation.palette.map(value => Math.min(63, value + Math.trunc(value * 30 / 100)));
    this.table = palette; this.font = font;
    window.addEventListener('keydown', this.key); window.addEventListener('pointerdown', this.click);
    try {
      void this.sound.play('WIN1', true, true).catch(this.error);
      this.soundEffect('COUNTRY4', 90); animation.next();this.background.set(animation.frameAt(1));
      for(let step=1;step<=7;step++){this.screen.fade(step/7);await this.wait(1);}
      for (let frame = 1; frame < animation.frameCount; frame++) { this.background.set(animation.frameAt(frame)); await this.wait(2); }
      if(side==='nod'){
        const logo=decodeShp(await this.assets.bytes('LOGOS.SHP',['conquer.mix'])),target=this.background.slice();this.shape(target,logo,1,0,0);
        // SCORE.CPP Presentation calls MAPSEL.CPP Bit_It_In_Scale for the Nod logo.
        const xs=Array.from({length:128},(_,i)=>i),ys=Array.from({length:88},(_,i)=>i);
        for(const list of [xs,ys])for(let i=0;i<list.length;i++){const j=Math.floor(Math.random()*list.length);[list[i],list[j]]=[list[j],list[i]];}
        for(let row=0;row<88;row++){for(let column=0;column<128;column++){const at=ys[(row+column)%88]*320+xs[column];this.background[at]=target[at];}if(row%2)await this.wait(2);}
      }
      for (const [index, x, y, frames] of [[0, 233, 2, 30], [1, 4, 97, 10], [2, 8, 172, 10]])
        this.animations.set(names[index], { shape: shapes[index], x, y, frames, delay: 4, start: this.tick });
      this.text('time', 'TIME:', 206, 3); this.text('lead', 'LEADERSHIP:', 182, 26);
      this.text('eff', 'EFFICIENCY:', 182, 38); this.text('total', 'TOTAL SCORE:', 182, 50);
      this.soundEffect('SFX4', 120); await this.wait(13); this.pressed = false;
      const minutes = Math.min(599, values.minutes);
      this.text('minutes', minutes >= 60 ? `${Math.trunc(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`, 275, 9, GREEN, false);
      for (let i = 0; i <= 160; i++) {
        this.text('lead-value', `${Math.min(i, values.leadership).toString().padStart(3)}%`, 264, 26, GREEN, false);
        if (i >= 30) this.text('eff-value', `${Math.min(i - 30, values.efficiency).toString().padStart(3)}%`, 264, 38, GREEN, false);
        if (i >= 60) this.text('total-value', String(Math.min(values.total, (i - 60) * Math.trunc(values.total / 100))).padStart(3), 264, 50, GREEN, false);
        this.soundEffect('BEEPY6', 60); await this.wait(1);
        if (this.pressed && i < Math.max(values.leadership, values.efficiency) - 5) { i = 158; this.pressed = false; }
      }
      this.text('total-value', String(values.total).padStart(3), 264, 50, GREEN, false); await this.wait(60);
      if(side==='nod')await this.showCredits(values.credits,shapes[3],side);
      await this.wait(60);
      const good = values.losses[side === 'gdi' ? 0 : 1], bad = values.losses[side === 'gdi' ? 1 : 0];
      const neutral = values.losses[2] ?? { units: 0, buildings: 0 };
      if(side==='nod')await this.nodGraphs(good,bad,neutral);
      else for (const [row, label, y, counts, colors] of [
        ['units', 'CASUALTIES:', 88, [good.units + neutral.units, bad.units], RED],
        ['buildings', 'BUILDINGS LOST', 136, [good.buildings + neutral.buildings, bad.buildings], GREEN],
      ] as const) {
        this.soundEffect('SFX4', 90); this.text(row, label, 144, y - 10, [...colors]); await this.wait(9);
        this.text(`${row}-gdi`, 'GDI:', 150, y + 2, [...colors]); this.text(`${row}-nod`, 'NOD:', 150, y + 14, [...colors]); await this.wait(7);
        const maximum = Math.max(1, ...counts), lengths = counts.map(count => maximum < 20 ? count * 5 : Math.trunc(count * 119 / maximum));
        for (let faction = 0; faction < 2; faction++) {
          for (let size = 1; size <= lengths[faction]; size++) {
            this.shape(this.background, shapes[4 + faction], size, 172, y + faction * 12);
            this.text(`${row}-${faction}`, String(Math.trunc(size * counts[faction] / Math.max(1, ...lengths))), 297, y + faction * 12 + 2, [...colors], false);
            if (!this.pressed) { this.soundEffect('BEEPY6', 110); await this.wait(2); }
          }
          this.shape(this.background, shapes[4 + faction], lengths[faction], 172, y + faction * 12);
          this.text(`${row}-${faction}`, String(counts[faction]), 297, y + faction * 12 + 2, [...colors], false);
          if (!this.pressed) await this.wait(40);
        }
        this.pressed = false;
      }
      if(side==='gdi')await this.showCredits(values.credits,shapes[3],side);
      this.text('fame', 'TOP SCORES', 28, 110, BLUE); this.soundEffect('SFX4', 90); await this.wait(9);
      let fame: Fame[] = [];
      try { fame = JSON.parse(localStorage.getItem('cnc-ultra-fame') ?? '[]'); } catch { /* An unavailable score file starts empty. */ }
      fame = fame.slice(0, 7); while (fame.length < 7) fame.push({ name: '', score: 0, level: 0 });
      if (fame[6].score >= values.total) fame[6].score = 0;
      const index = fame.findIndex(item => item.score < values.total);
      fame.splice(index, 0, { name: '', score: values.total, level: values.level }); fame.length = 7;
      for (const [i, item] of fame.entries()) {
        this.text(`name${i}`, item.name, 19, 120 + i * 8, BLUE);
        if (item.score) {
          this.text(`score${i}`, String(item.score), 109, 120 + i * 8, BLUE);
          this.text(`level${i}`, item.level < 20 ? String(item.level) : '**', 91, 120 + i * 8, BLUE); await this.wait(13);
        }
      }
      this.editing = { fame: fame[index], index, name: new ScoreName() };
      this.status('score-name');
      while (!this.editing.name.done) {
        if (!this.scaledLetter && this.keys.length) {
          const edit = this.editing, position = edit.name.cursor, character = edit.name.accept(this.keys.shift()!);
          edit.fame.name = edit.name.value;
          if (character) {
            this.scaledLetter = { character, start: this.tick };
            this.text(`name${index}`, edit.fame.name.slice(0, position), 19, 120 + index * 8, BLUE, false);
            this.soundEffect('KEYSTROK', 255);
          } else this.text(`name${index}`, edit.fame.name, 19, 120 + index * 8, BLUE, false);
        }
        await this.wait(1);
      }
      try { localStorage.setItem('cnc-ultra-fame', JSON.stringify(fame)); } catch { /* Scores remain usable when browser storage is disabled. */ }
      this.editing = undefined;
      for(let step=1;step<=7;step++){this.screen.fade(1-step/7);await this.wait(1);}
    } finally { window.removeEventListener('keydown', this.key); window.removeEventListener('pointerdown', this.click); }
  }
  private async showCredits(credits:number,shape:Shape,side:CampaignSide){
    const nod=side==='nod',y=nod?58:173,px=nod?236:228,py=nod?74:177;
    this.text('credits','ENDING CREDITS:',182,nod?62:167);await this.wait(15);
    this.animations.set('CREDS',{shape,x:276,y,frames:32,delay:2,start:this.tick});
    for(let money=-50;money<credits;){
      money+=Math.max(Math.trunc(credits/100),5+(credits-money>100?15:0)+(credits-money>1000?30:0));money=Math.max(0,money);if(this.pressed)money=credits;
      this.text('credit-value',String(Math.min(credits,money)),px,py,GREEN,false);await this.wait(2);
    }
    const item=this.animations.get('CREDS')!;while(Math.trunc((this.tick-item.start)/2)%32>=20)await this.wait(1);
    this.animations.delete('CREDS');this.shape(this.background,shape,Math.trunc((this.tick-item.start)/2)%32,276,y);this.pressed=false;
  }
  /** SCORE.CPP Do_Nod_Casualties_Graph / Draw_InfantryMen / Do_Nod_Buildings_Graph. */
  private async nodGraphs(good:{units:number;buildings:number},bad:{units:number;buildings:number},neutral:{units:number;buildings:number}){
    const [e1,c1,factory,commando,fire]=await Promise.all(['E1','C1','FACT','RMBO','FBALL1'].map(name=>this.assets.bytes(`${name}.SHP`,['conquer.mix']).then(decodeShp)));
    this.soundEffect('SFX4',90);this.text('units','CASUALTIES:',146,90,RED);await this.wait(9);
    this.text('units-neutral','NEUTRAL:',200,114,RED);await this.wait(4);this.text('units-gdi','GDI:',224,90,RED);this.text('units-nod','NOD:',224,102,RED);await this.wait(6);
    const counts=[good.units,bad.units,neutral.units],largest=Math.max(1,...counts),lengths=counts.map(count=>largest>52?Math.trunc(count*52/largest):count),maximum=Math.max(1,...lengths);
    const original=this.background.slice(),clip={x:266,y:88,width:54,height:34},remaps=[ScoreRemapYellow,ScoreRemapGrey,RemapCiv];
    const men=Array.from({length:15},(_,id)=>({row:Math.trunc(id/5),x:(id%5)*10+7,y:11+Math.trunc(id/5)*10,anim:0,stage:0,delay:Math.floor(Math.random()*32)}));
    const draw=(size:number)=>{
      for(let y=88;y<122;y++)this.background.set(original.subarray(y*320+266,y*320+320),y*320+266);
      for(const man of men){
        if(man.anim<0)continue;
        const shape=man.row===2?c1:e1,actions=combatTypes[movementType(man.row===2?'C1':'E1')].actions;
        this.shape(this.background,shape,actions[man.anim*3]+man.stage,266+man.x-Math.trunc(shape.width/2),88+man.y-Math.trunc(shape.height/2),remaps[man.row],clip);
        if(--man.delay<0){man.delay=3;if(++man.stage>=actions[man.anim*3+1]){if(man.anim>=22)man.anim=-1;else{man.anim=0;man.stage=0;man.delay=Math.floor(Math.random()*16);}}}
      }
      if(size)for(let row=0;row<3;row++)if(lengths[row]){
        const width=Math.min(size,lengths[row]),y=88+4+row*12;
        for(let dy=0;dy<2;dy++)this.background.fill(row===0?9:8,(y+dy)*320+266,(y+dy)*320+267+width);
        this.background.fill(0,(y+2)*320+267,(y+2)*320+268+width);this.background[(y+1)*320+267+width]=0;
        if(size<=lengths[row]){const man=men[row*5+Math.trunc(size/11)];if(man.anim>=0&&man.anim<22){man.anim=22+(Math.trunc(size/11)?Math.floor(Math.random()*4):0);man.stage=0;man.delay=1;}}
      }
    };
    draw(0);await this.wait(40);
    for(let size=1;size<=maximum;size++){
      for(let repeat=0;repeat<3;repeat++){
        draw(size);counts.forEach((count,row)=>this.text(`units-value${row}`,String(Math.min(count,Math.trunc(size*count/maximum))),248,90+row*12,RED,false));
        if(!this.pressed)await this.wait(3);
      }
      this.soundEffect('BEEPY6',110);
    }
    counts.forEach((count,row)=>this.text(`units-value${row}`,String(count),248,90+row*12,RED,false));
    while(men.some(man=>man.anim>=22)){draw(maximum);await this.wait(1);}this.pressed=false;
    this.soundEffect('SFX4',90);this.text('buildings1','BUILDINGS',146,128);this.text('buildings2','LOST:',146,136);await this.wait(9);
    this.text('buildings-neutral','NEUTRAL:',200,152);await this.wait(4);this.text('buildings-gdi','GDI:',224,128);this.text('buildings-nod','NOD:',224,140);await this.wait(43);
    const back=this.background.slice(),buildingClip={x:256,y:128,width:64,height:48},walk=combatTypes[movementType('E5')].actions;
    for(let frame=0;frame<98;frame++){
      for(let y=128;y<176;y++)this.background.set(back.subarray(y*320+256,y*320+320),y*320+256);
      if(frame<68)this.shape(this.background,factory,frame<60?0:factory.frames.length-(frame>65?1:2),256,128,ScoreRemapBldg,buildingClip);
      if(frame===60)this.soundEffect('CRUMBLE',255);
      if(frame>=61){const stage=(frame-61)>>1;if(stage<fire.frames.length)this.shape(this.background,fire,stage,266-Math.trunc(fire.width/2),138-Math.trunc(fire.height/2),ScoreRemapFBall,buildingClip);}
      if(frame>64){const stage=(frame-64)>>1;if(stage<fire.frames.length)this.shape(this.background,fire,stage,306-Math.trunc(fire.width/2),158-Math.trunc(fire.height/2),ScoreRemapFBall,buildingClip);}
      this.shape(this.background,commando,walk[9]+walk[11]*6+((frame>>1)%walk[10]),288+frame-Math.trunc(commando.width/2),168-Math.trunc(commando.height/2),ScoreRemapYellow,buildingClip);
      if(!this.pressed)await this.wait(1);
    }
    const buildings=[good.buildings,bad.buildings,neutral.buildings];
    for(let value=0;value<=Math.max(...buildings);value++){
      buildings.forEach((count,row)=>this.text(`buildings-value${row}`,String(Math.min(value,count)),264,128+row*12,GREEN,false));if(!this.pressed){this.soundEffect('BEEPY6',110);await this.wait(1);}
    }
    this.pressed=false;
  }
}
