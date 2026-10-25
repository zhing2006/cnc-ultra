import type { IndexedScreen } from '../../engine/indexed/screen.ts';
import { decodeCps } from '../formats/cps.ts';
import { decodeFont, type BitmapFont } from '../formats/font.ts';
import { decodeShp } from '../formats/shp.ts';
import { GameStrings } from '../formats/strings.ts';
import { WsaVideo } from '../formats/wsa.ts';
import { COUNTRY_ROUTES, GDI_STATS, MAP_TEXT, NOD_STATS } from './map-data.ts';
import type { CampaignAssets, CampaignSide } from './assets.ts';
import type { CampaignAudio } from './audio.ts';
import { nextCampaignMission } from './country-route.ts';

const X = [195,217,115,167,244,97,130,142,171,170,139,158,180,207,177,213,201,198,69,82,105,119,184,149,187,130,153,124,162,144,145,164,166,200,201];
const Y = [35,57,82,75,93,111,108,91,100,111,120,136,136,117,158,143,167,21,45,80,75,76,31,64,69,89,88,106,115,139,168,164,183,123,154];
const GREEN = [0,65,66,67,68,68,68,68,68,68,68,68,68,68,68,68];
const OTHER_GREEN = [0,33,34,35,36,37,38,38,38,38,38,38,38,38,38,38];

/** MAPSEL.CPP Map_Selection / Print_Statistics, with original click masks and route tables. */
export class MapSelection {
  private readonly background = new Uint8Array(64000);
  private readonly pixels = new Uint8Array(64000);
  private readonly foreground = new Uint8Array(640 * 400);
  private readonly captions = new Map<string, { value: string; x: number; y: number; start: number; colors: number[]; speed: number }>();
  private palette = new Uint8Array(768);
  private table: Uint8Array = new Uint8Array(65536);
  private font!: BitmapFont;
  private strings!: GameStrings;
  private ticks = 0;
  private click?: (x: number, y: number) => void;
  private proceed?: () => void;
  private fast=false;
  private readonly key=(event:KeyboardEvent)=>{
    if(event.ctrlKey&&event.code==='KeyQ'){event.preventDefault();this.fast=true;return;}
    this.proceed?.();
  };
  private readonly pointer = (event: PointerEvent) => {
    if (event.button !== 0 || !this.click) return;
    const ratio=devicePixelRatio,w=innerWidth*ratio,h=innerHeight*ratio,fit=Math.min(w/640,h/400),scale=fit>=1?Math.floor(fit):fit;
    const x=Math.floor((event.clientX*ratio-Math.floor((w-640*scale)/2))/scale/2);
    const y=Math.floor((event.clientY*ratio-Math.floor((h-400*scale)/2))/scale/2);
    if(x>=0&&x<320&&y>=0&&y<200)this.click(x,y);
  };
  constructor(private readonly assets: CampaignAssets, private readonly screen: IndexedScreen, private readonly sound: CampaignAudio,
    private readonly signal: AbortSignal, private readonly error: (error: unknown) => void, private readonly status: (value: string) => void) {}
  private effect(name: string, volume=90){void this.sound.play(name,false,false,volume/255).catch(this.error);}
  private text(key:string,value:string,x:number,y:number,colors=GREEN,speed=1){this.captions.set(key,{value,x,y,start:this.ticks,colors,speed});}
  private label(key:string){return this.strings.get(MAP_TEXT[key]);}
  private draw(){
    this.pixels.set(this.background);
    this.foreground.fill(255);
    for(const caption of this.captions.values()){
      const visible=Math.min(caption.value.length,(this.ticks-caption.start)*caption.speed);
      for(let i=0;i<=visible&&i<caption.value.length;i++){
        const glyph=this.font.glyphs[caption.value.charCodeAt(i)];if(!glyph)continue;
        for(const [ox,oy] of i===visible?[[0,-2],[0,2],[2,0]]:[[0,0]])for(let y=0;y<glyph.height;y++)for(let x=0;x<glyph.width;x++){
          const px=caption.x*2+i*12+x+ox,py=caption.y*2+y+oy,index=glyph.pixels[y*glyph.width+x];
          if(index&&px>=0&&px<640&&py>=0&&py<400)this.foreground[py*640+px]=i===visible?15:caption.colors[index]??caption.colors[1];
        }
      }
    }
    this.screen.set(this.pixels,this.palette,320,200,this.table);
    this.screen.setForeground(this.foreground);
  }
  private async wait(ticks:number,cycle=false){
    for(let i=0;i<ticks;i++){
      this.signal.throwIfAborted();
      if(document.hidden){await new Promise(resolve=>setTimeout(resolve,100));i--;continue;}
      await new Promise(resolve=>setTimeout(resolve,this.fast&&!this.click?0:1000/60));this.ticks++;
      if(cycle&&this.ticks%4===0){const first=this.palette.slice(249*3,250*3);this.palette.copyWithin(249*3,250*3,255*3);this.palette.set(first,254*3);}
      this.draw();
    }
  }
  private async colors(palette:Uint8Array,table:string){
    this.palette=palette.map(value=>Math.min(63,value+Math.trunc(value*30/100)));
    this.table=await this.assets.bytes(table);this.draw();
  }
  private frame(animation:WsaVideo,index:number){
    const pixels=animation.frameAt(index);
    for(let y=0;y<animation.height;y++)this.background.set(pixels.subarray(y*animation.width,(y+1)*animation.width),(y+animation.y)*320+animation.x);
    this.draw();
  }
  private async dissolve(target:Uint8Array){
    const xs=Array.from({length:320},(_,i)=>i),ys=Array.from({length:200},(_,i)=>i);
    for(const values of [xs,ys])for(let i=0;i<values.length;i++){const pick=Math.floor(Math.random()*values.length);[values[i],values[pick]]=[values[pick],values[i]];}
    for(let row=0;row<200;row++){
      for(let x=0;x<320;x++){const p=ys[(row+x)%200]*320+xs[x];this.background[p]=target[p];}
      for(let y=0;y<=row;y++)for(const x of [160-(row-y),160+(row-y)])if(x>=0&&x<320)this.background[y*320+x]=target[y*320+x];
      if(row%2)await this.wait(2);
    }
  }
  async play(side:CampaignSide,name:string,completed=Number(name.slice(3,5))){
    const direction=name[5]==='W'?1:0,row=COUNTRY_ROUTES[completed+(side==='nod'?14:0)],last=completed===(side==='gdi'?14:12);
    if(!row||!row.choices[direction])return nextCampaignMission(side,name,completed,0);
    const archives=['update.mix','transit.mix',`${side}/general.mix`,'general.mix','cclocal.mix','conquer.mix'];
    const load=(file:string)=>this.assets.bytes(file,archives);
    const [grey,transition,earth,progress,font,strings,mask]=await Promise.all([
      load('GREYERTH.WSA').then(bytes=>new WsaVideo(bytes)),load('E-BWTOCL.WSA').then(bytes=>new WsaVideo(bytes)),
      load(side==='gdi'?'HEARTH_E.WSA':'HEARTH_A.WSA').then(bytes=>new WsaVideo(bytes)),
      load(side==='gdi'?(last?'HBOSNIA.WSA':'EUROPE.WSA'):(last?'HSAFRICA.WSA':'AFRICA.WSA')).then(bytes=>new WsaVideo(bytes)),
      load('12GRNGRD.FNT').then(decodeFont),load('CONQUER.ENG').then(bytes=>new GameStrings(bytes)),
      load(side==='gdi'?(last?'CLICK_EB.CPS':'CLICK_E.CPS'):(last?'CLICK_SA.CPS':'CLICK_A.CPS')).then(decodeCps),
    ]);
    this.font=font;this.strings=strings;this.status('map');
    window.addEventListener('pointerdown',this.pointer);
    window.addEventListener('keydown',this.key);
    try{
      void this.sound.play('MAP1',true,true).catch(this.error);
      this.screen.fade(0);await this.colors(grey.palette,'MAP_LOCL.PAL');this.frame(grey,0);this.effect('APPEAR1',110);
      for(let step=1;step<=15;step++){this.screen.fade(step/15);await this.wait(1);}
      for(let frame=0;frame<grey.frameCount;frame++){this.frame(grey,frame);await this.wait(4);}
      await this.colors(transition.palette,'MAP_GRY2.PAL');
      for(let frame=0;frame<transition.frameCount;frame++){this.frame(transition,frame);await this.wait(4);}
      this.effect('SFX4',130);this.effect('TEXT2');
      const messages:Record<number,string>={1:'TXT_READING_IMAGE_DATA',17:'TXT_ANALYZING',34:'TXT_ENHANCING_IMAGE_DATA',45:'TXT_ISOLATING_OPERATIONAL_THEATER',71:'TXT_ESTABLISHING_TRADITIONAL_BOUNDARIES'};
      for(let frame=1;frame<earth.frameCount;frame++){
        if([16,33,44,70].includes(frame))this.captions.delete('analysis');
        if(messages[frame])this.text('analysis',this.label(messages[frame]),0,10,OTHER_GREEN,10);
        if([16,33,44,70,73].includes(frame))this.effect('TEXT2');
        if([21,27].includes(frame))this.effect('TARGET1');if([45,47,49].includes(frame))this.effect('BEEPY6');
        if(frame===51)this.effect('WORLD2');if([70,72].includes(frame))this.effect('BEEPY2');if(frame===74){this.effect('TARGET2',110);this.text('reference',this.label('TXT_FOR_VISUAL_REFERENCE'),0,22,OTHER_GREEN,10);}
        this.frame(earth,frame);await this.wait(3);
      }
      this.captions.clear();this.background.fill(0);this.frame(progress,0);const continent=this.background.slice();
      await this.colors(progress.palette,'MAP_PROG.PAL');this.frame(progress,row.start[direction]);await this.wait(45);
      const tx=side==='gdi'?0:204;this.effect('TEXT2');this.text('control',this.label(side==='gdi'?'TXT_MAP_GDI':'TXT_MAP_NOD'),tx,2);await this.wait(60);
      this.effect('COUNTRY1');const start=this.background.slice();this.frame(progress,row.start[direction]+1);const first=this.background.slice();this.background.set(start);await this.dissolve(first);await this.wait(85);
      this.captions.clear();
      if(!last){this.effect('TEXT2');this.text('control',this.label(side==='gdi'?'TXT_MAP_NOD':'TXT_MAP_GDI'),tx,12);await this.wait(65);}
      this.effect('COUNTRY1');const previous=this.background.slice();this.frame(progress,row.start[direction]+2);const second=this.background.slice();this.background.set(previous);await this.dissolve(second);if(!last)await this.wait(85);
      this.captions.clear();this.effect('TEXT2');this.text('locate',this.label('TXT_MAP_LOCATE'),0,160);await this.wait(20);this.text('next',this.label('TXT_MAP_NEXT_MISSION'),0,170);await this.wait(50);
      if(last){this.captions.clear();this.table=await load(side==='gdi'?'LASTSCNG.PAL':'LASTSCNB.PAL');}
      const count=last?progress.frameCount-4:13;let repeat=0;
      for(let frame=0;frame<count;frame++){
        if(frame===0||frame===2)this.effect('BEEPY3');if(frame===6)this.effect('NEWTARG1');
        if(last&&frame===23)this.text('enhancing',this.label('TXT_ENHANCING_IMAGE'),side==='gdi'?0:210,10,OTHER_GREEN,10);
        if(last&&frame===35)this.captions.delete('enhancing');
        this.frame(progress,row.continuation[direction]+frame);await this.wait(6);
        if(!last&&frame===4&&repeat++<4)frame=2;
      }
      this.captions.clear();this.effect('BEEPY6');this.text('select',this.label('TXT_MAP_SELECT'),side==='nod'&&last?200:0,160);await this.wait(16,true);
      this.text('attack',this.label('TXT_MAP_TO_ATTACK'),side==='nod'&&last?200:0,170);await this.wait(24,true);
      let chosen=-1,color=0;
      this.click=(x,y)=>{
        const pixel=mask.pixels[y*320+x];
        for(let i=0;i<row.choices[direction];i++){
          const value=row.colors[direction][i]===160&&(pixel===128||pixel===129)?160:pixel;
          if(value===row.colors[direction][i]){chosen=i;color=value;this.effect('WORLD2');return;}
          this.effect('SCOLD1');
        }
      };
      this.status('map-select');while(chosen<0)await this.wait(1,true);this.click=undefined;this.captions.clear();
      const nextDirection=row.directions[direction][chosen];
      let sx=160,sy=side==='gdi'?0:160,stats=20;
      if(!last){
        const countries=decodeShp(await load(side==='gdi'?'COUNTRYE.SHP':'COUNTRYA.SHP'));
        const shape=row.shapes[nextDirection][chosen],xy=shape+(side==='gdi'?0:18);sx=X[xy];sy=Y[xy];stats=color&127;
        this.background.set(continent);const frame=countries.frames[shape];
        for(let y=0;y<countries.height;y++)for(let x=0;x<countries.width;x++){
          const px=sx-Math.trunc(countries.width/2)+x,py=sy-Math.trunc(countries.height/2)+y,value=frame[y*countries.width+x];
          if(value&&px>=0&&px<320&&py>=0&&py<200)this.background[py*320+px]=value;
        }
      }else this.frame(progress,progress.frameCount-1);
      await this.colors(await load(last?(side==='gdi'?'DARK_B.PAL':'DARK_SA.PAL'):'DARK_E.PAL'),last?'MAP_LOC3.PAL':'MAP_LOC2.PAL');
      await this.statistics(side,stats,sx,sy);
      for(let step=1;step<=15;step++){this.screen.fade(1-step/15);await this.wait(1);}
      return nextCampaignMission(side,name,completed,chosen);
    }finally{this.click=undefined;this.proceed=undefined;window.removeEventListener('pointerdown',this.pointer);window.removeEventListener('keydown',this.key);this.sound.stop();}
  }
  private async statistics(side:CampaignSide,country:number,x:number,y:number){
    x=x>128?8:136;y=y>100?8:98;
    if(side==='nod'){if(country>30)country=15;else if(country>=15)country++;country++;}
    const row=(side==='gdi'?GDI_STATS:NOD_STATS)[country];
    this.text('country',this.label(`TXT_MAP_COUNTRYNAME${row[0]}`),x,y);await this.wait(this.label(`TXT_MAP_COUNTRYNAME${row[0]}`).length*3);y+=16;
    const titles=side==='gdi'?Array.from({length:7},(_,i)=>`TXT_MAP_GDISTAT${i}`):['TXT_MAP_GDISTAT0','TXT_MAP_NODSTAT0','TXT_MAP_GDISTAT2','TXT_MAP_GDISTAT3','TXT_MAP_NODSTAT1','TXT_MAP_NODSTAT2','TXT_MAP_GDISTAT5','TXT_MAP_NODSTAT3','TXT_MAP_NODSTAT4'];
    const values=side==='gdi'?[this.strings.get(row[1]),this.strings.get(row[2]),this.strings.get(row[3]),this.label(`TXT_MAP_GOVT${row[4]}`),this.strings.get(row[5]),this.strings.get(row[6]),this.label(`TXT_MAP_ARMY${row[7]}`)]
      :[this.strings.get(row[1]),`${row[2]}%`,this.strings.get(row[3]),this.label(`TXT_MAP_GOVT${row[4]}`),`${row[5]}%`,this.strings.get(row[6]),this.strings.get(row[7]),this.label(`TXT_MAP_MILITARY${row[8]}`),`${row[9]}%`];
    for(let i=0;i<titles.length;i++){
      this.text(`stat${i}`,this.label(titles[i]),x,y+i*8);
      await this.wait(this.strings.get(MAP_TEXT[titles[i]]+3).length);
      this.text(`value${i}`,values[i],x+this.label(titles[i]).length*6,y+i*8);
    }
    this.text('continue',this.label('TXT_MAP_CLICK2'),109,187);
    while([...this.captions.values()].some(caption=>(this.ticks-caption.start)*caption.speed<=caption.value.length))await this.wait(1);
    let done=false;this.click=this.proceed=()=>{done=true;};this.status('map-continue');while(!done&&!this.fast)await this.wait(1);this.click=undefined;this.proceed=undefined;
  }
}
