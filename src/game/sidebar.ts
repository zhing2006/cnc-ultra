// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { DataTexture, NearestFilter, RedFormat, RGBAFormat, UnsignedByteType, Vector2, type Node } from 'three/webgpu';
import { Fn, If, int, ivec2, vec2, textureLoad, uniform } from 'three/tsl';
import { decodeShp, type Shape } from './formats/shp.ts';
import { decodeFont } from './formats/font.ts';
import { intMax, intMin } from '../engine/simulation/integer-nodes.ts';
import type { MixSet } from './formats/mix.ts';
import type { EconomyRuntime } from './simulation/economy-runtime.ts';
import type { Radar } from './radar.ts';

/** SIDEBAR.CPP: original Gold artwork, two strips and the 109-step clock overlay. */
export class Sidebar {
  readonly origin=uniform(new Vector2());
  readonly viewport=uniform(new Vector2());
  readonly pointer=uniform(new Vector2(-100,-100));
  readonly draw:(pixel:Node<'vec2'>,color:Node<'vec4'>)=>Node<'vec4'>;
  readonly width=160;
  private readonly pixels=new Uint8Array(160*400);
  private readonly texture:DataTexture;
  private readonly palette:DataTexture;
  private readonly cursor:DataTexture;
  private readonly shapes=new Map<string,Shape>();
  private readonly scroll=[0,0];
  private readonly scrollQueue=[0,0];
  private readonly scrollOffset=[0,0];
  private readonly scrollDirection=[0,0];
  private readonly font;
  private readonly clockMap:Uint8Array;
  private readonly cameos=new Map<string,Shape>();
  private powerHeight=0;
  private drainHeight=0;
  private recordedPower=-1;
  private recordedDrain=-1;
  private powerBounce=0;
  private drainBounce=0;
  private powerDirection=0;
  private drainDirection=0;
  private radarFrame=0;
  private radarExists=false;
  private radarActive=false;
  private radarActivating=false;
  private radarDeactivating=false;
  private readonly radarEnabled=uniform(0,'int');
  onRadarCell?:(cell:number)=>void;
  constructor(readonly economy:EconomyRuntime,readonly data:MixSet,readonly radar?:Radar){
    for(const name of ['HSIDE1.SHP','HSIDE2.SHP','HSTRIP.SHP','HCLOCK.SHP','HREPAIR.SHP','HSELL.SHP','HMAP.SHP','HTABS.SHP','HSTRIPUP.SHP','HSTRIPDN.SHP','HPWRBAR.SHP','HPOWER.SHP','HPIPS.SHP',`HRADAR.${economy.faction===2?'NOD':'GDI'}`]){
      const bytes=data.get(name);if(bytes)this.shapes.set(name,decodeShp(bytes));
    }
    this.font=decodeFont(data.require('6POINT.FNT'));
    this.clockMap=data.require('TCLOCK.MRF');
    const texture=(data:Uint8Array,width:number,height:number,rgba=false)=>{
      const t=new DataTexture(data,width,height,rgba?RGBAFormat:RedFormat,UnsignedByteType);t.minFilter=t.magFilter=NearestFilter;t.generateMipmaps=false;t.needsUpdate=true;return t;
    };
    this.texture=texture(this.pixels,160,400);
    this.palette=texture(economy.scene.scene.setup.palette,256,1,true);
    const {region,hotX,hotY}=economy.scene.scene.cursors.normal,atlas=economy.scene.scene.setup.spriteAtlas;
    const cursor=new Uint8Array(region.width*region.height);
    for(let y=0;y<region.height;y++)cursor.set(atlas.pixels.subarray((region.y+y)*atlas.width+region.x,(region.y+y)*atlas.width+region.x+region.width),y*region.width);
    this.cursor=texture(cursor,region.width,region.height);
    this.draw=(pixel,color)=>Fn(()=>{
      const point=ivec2(pixel.sub(this.origin).sub(vec2(this.viewport.x.sub(160),0))),result=color.toVar();
      If(point.x.greaterThanEqual(0).and(point.x.lessThan(160)),()=>{
        const row=intMax(int(0),intMin(int(399),point.y));
        const ink=int(textureLoad(this.texture,ivec2(point.x,row)).r.mul(255).round()).toVar();
        If(point.y.greaterThanEqual(400),()=>{ink.assign(0);});
        if(radar)If(this.radarEnabled.notEqual(0).and(point.x.greaterThanEqual(16)).and(point.x.lessThan(144)).and(point.y.greaterThanEqual(21)).and(point.y.lessThan(149)),()=>{
          ink.assign(int(textureLoad(radar.target.texture,point.sub(ivec2(16,21))).r.mul(255).round()));
        });
        const cursorPoint=point.sub(ivec2(this.pointer)).add(ivec2(hotX,hotY));
        If(cursorPoint.x.greaterThanEqual(0).and(cursorPoint.y.greaterThanEqual(0)).and(cursorPoint.x.lessThan(region.width)).and(cursorPoint.y.lessThan(region.height)),()=>{
          const value=int(textureLoad(this.cursor,cursorPoint).r.mul(255).round());If(value.notEqual(0),()=>{ink.assign(value);});
        });
        result.assign(textureLoad(this.palette,ivec2(ink,0)));
      });
      return result;
    })();
    this.update();
  }
  private blit(shape:Shape|undefined,frame:number,x:number,y:number,ghost=false,clipTop=0,clipBottom=400){
    const pixels=shape?.frames[frame];if(!shape||!pixels)return;
    for(let yy=0;yy<shape.height;yy++)for(let xx=0;xx<shape.width;xx++){
      const dx=x+xx,dy=y+yy,ink=pixels[yy*shape.width+xx];if(!ink||dx<0||dx>=160||dy<clipTop||dy>=clipBottom)continue;
      const at=dy*160+dx,map=this.clockMap[ink];
      this.pixels[at]=ghost&&map!==255?this.clockMap[(map+1)*256+this.pixels[at]]:ink;
    }
  }
  private shape(name:string,frame:number,x:number,y:number){this.blit(this.shapes.get(name),frame,x,y);}
  private text(value:string,x:number,y:number,color=15){
    for(const ch of value){const glyph=this.font.glyphs[ch.charCodeAt(0)];if(!glyph)continue;
      for(let yy=0;yy<glyph.height;yy++)for(let xx=0;xx<glyph.width;xx++)if(glyph.pixels[yy*glyph.width+xx]&&x+xx>=0&&x+xx<160&&y+yy>=0&&y+yy<400)this.pixels[(y+yy)*160+x+xx]=color;
      x+=glyph.width+1;
    }
  }
  columns(){const all=this.economy.available;return [all.filter(t=>t.category==='building'),all.filter(t=>t.category!=='building')];}
  hit(x:number,y:number,button:number){
    x-=this.viewport.value.x-160;if(x<0)return false;
    if(this.radarActive&&x>=16&&x<144&&y>=21&&y<149&&button===0){const cell=this.radar?.cellAt(x-16,y-21);if(cell!==undefined)this.onRadarCell?.(cell);return true;}
    if(y>=160&&y<176&&button===0){if(x<54)this.economy.toggle('repair');else if(x<108)this.economy.toggle('sell');else this.radar?.toggle();return true;}
    const col=x<86?0:1,left=col?88:18;
    if(!this.scrollDirection[col]&&x>=left&&x<left+64&&y>=184&&y<376){const item=this.columns()[col][this.scroll[col]+Math.trunc((y-184)/48)];if(item)this.economy.choose(item.name,button===2);}
    if(y>=376&&y<396&&button===0)this.scrollQueue[col]+=x-left<32?-1:1;
    return true;
  }
  update(){
    this.pixels.fill(0);
    // Ported from RADAR.CPP Radar_Activate and AI; a restored radar opens backwards.
    if(this.economy.radar&&!this.radarActive&&!this.radarActivating){
      this.radarActivating=true;
      if(!this.radarDeactivating)this.radarFrame=this.radarExists?41:0;
      this.radarDeactivating=false;
    }else if(!this.economy.radar&&this.radarActive){
      this.radarActive=false;this.radarDeactivating=true;this.radarActivating=false;this.radarFrame=22;
    }
    if(this.radarActivating){
      this.radarFrame+=this.radarExists?-1:1;
      if(this.radarFrame===22){this.radarExists=true;this.radarActive=true;this.radarActivating=false;}
    }
    if(this.radarDeactivating&&++this.radarFrame>=41)this.radarDeactivating=false;
    this.radarEnabled.value=Number(this.radarActive);
    this.shape('HTABS.SHP',0,0,0);
    this.shape(`HRADAR.${this.economy.faction===2?'NOD':'GDI'}`,this.radarFrame,0,15);
    this.shape('HSIDE1.SHP',0,0,158);this.shape('HSIDE2.SHP',0,0,276);
    // POWER.CPP Power_Height: each 100 power fills one sixth of the remaining bar.
    const powerHeight=(value:number)=>{let h=0;while(value>=100){h+=Math.trunc((218-h)/6);value-=100;}return h+Math.trunc(Math.trunc((218-h)/6)*value/100);};
    // Ported from POWER.CPP AI and Draw_It, including the twelve-tick overshoot.
    const desiredPower=powerHeight(this.economy.house.power),desiredDrain=powerHeight(this.economy.house.drain);
    if(this.recordedPower!==this.economy.house.power){this.recordedPower=this.economy.house.power;this.powerDirection=Math.sign(desiredPower-this.powerHeight);this.powerBounce=this.powerDirection?12:0;}
    if(this.recordedDrain!==this.economy.house.drain){this.recordedDrain=this.economy.house.drain;this.drainDirection=Math.sign(desiredDrain-this.drainHeight);this.drainBounce=this.drainDirection?12:0;}
    if(this.powerHeight!==desiredPower)this.powerHeight+=this.powerDirection;else if(this.powerBounce)this.powerBounce--;
    if(this.drainHeight!==desiredDrain)this.drainHeight+=this.drainDirection;else if(this.drainBounce)this.drainBounce--;
    const bounce=[0,-1,0,1,0,-1,-2,-1,0,1,2,1,0];
    const power=Math.max(0,Math.min(218,this.powerHeight+(this.powerHeight===desiredPower?bounce[this.powerBounce]*this.powerDirection:0)));
    const drain=Math.max(0,Math.min(218,this.drainHeight+(this.drainHeight===desiredDrain?bounce[this.drainBounce]*this.drainDirection:0)));
    const bottom=399-power,bar=this.shapes.get('HPWRBAR.SHP'),color=this.economy.house.drain>this.economy.house.power*2?4:this.economy.house.drain>this.economy.house.power?2:0;
    this.blit(bar,0,0,180,false,0,bottom);this.blit(bar,1,0,280,false,0,bottom);
    this.blit(bar,2+color,0,180,false,bottom);this.blit(bar,3+color,0,280,false,bottom);this.shape('HPOWER.SHP',0,0,400-drain);
    this.shape('HREPAIR.SHP',Number(this.economy.mode==='repair'),4,160);
    this.shape('HSELL.SHP',Number(this.economy.mode==='sell'),57,160);this.shape('HMAP.SHP',0,110,160);
    this.text(String(this.economy.house.money),45,3);
    const columns=this.columns();
    for(let col=0;col<2;col++){
      const x=col?88:18;this.scroll[col]=Math.min(this.scroll[col],Math.max(0,columns[col].length-4));
      // SIDEBAR.CPP StripClass::AI: scroll one cameo at eight pixels per logic tick.
      if(!this.scrollDirection[col]&&this.scrollQueue[col]){
        const direction=Math.sign(this.scrollQueue[col]);
        if(direction<0?this.scroll[col]>0:this.scroll[col]+4<columns[col].length){
          this.scrollDirection[col]=direction;this.scrollQueue[col]-=direction;
          if(direction<0){this.scroll[col]--;this.scrollOffset[col]=-48;}
        }else this.scrollQueue[col]=0;
      }
      if(this.scrollDirection[col]){
        this.scrollOffset[col]-=this.scrollDirection[col]*8;
        if(this.scrollDirection[col]<0?this.scrollOffset[col]>=0:this.scrollOffset[col]<=-48){
          if(this.scrollDirection[col]>0)this.scroll[col]++;
          this.scrollOffset[col]=this.scrollDirection[col]=0;
        }
      }
      this.shape('HSTRIP.SHP',col,x,184);
      for(let row=0;row<(this.scrollDirection[col]?5:4);row++){
        const type=columns[col][this.scroll[col]+row];if(!type)continue;
        let cameo=this.cameos.get(type.name);
        if(!cameo){const bytes=this.data.get(`${type.name}ICNH.TEM`)??this.data.get(`${type.name}ICON.SHP`);if(bytes){cameo=decodeShp(bytes);this.cameos.set(type.name,cameo);}}
        const y=184+row*48+this.scrollOffset[col];this.blit(cameo,0,x,y,false,184,376);
        const item=this.economy.queues.items.get(type.category);
        if(item){
          const selected=item.type.name===type.name;
          if(!selected||!item.complete)this.blit(this.shapes.get('HCLOCK.SHP'),selected?item.stage+1:0,x,y,true,184,376);
          if(selected&&(item.complete||item.suspended)){
            const pips=this.shapes.get('HPIPS.SHP');this.blit(pips,item.complete?3:4,x+32-Math.trunc((pips?.width??0)/2),y+40-Math.trunc((pips?.height??0)*3/2),false,184,376);
          }
        }
      }
      this.shape('HSTRIPUP.SHP',0,x+2,376);this.shape('HSTRIPDN.SHP',0,x+34,376);
    }
    this.texture.needsUpdate=true;
  }
  dispose(){this.texture.dispose();this.palette.dispose();this.cursor.dispose();}
}
