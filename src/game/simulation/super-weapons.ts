// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { movePoint } from '../coord.ts';
import { BUILDINGS } from '../data/buildings.ts';
import type { ExplosionCommand } from './combat-state.ts';

export type SuperKind = 'ion' | 'nuke';
export const SUPER_RECHARGE = { ion: 10 * 900, nuke: 14 * 900 };
export const SUPER_SPRITES = 8, SUPER_VISUAL_WORDS = 5;
export const SUPER_SHAPES = ['IONSFX', 'ART-EXP1', 'ATOMDOOR', 'ATOMICUP', 'ATOMICDN', 'ATOMSFX'] as const;

/** Ported from SUPER.CPP. The countdown uses logical frame numbers, including suspension. */
export class SuperCharge {
  present = false;
  ready = false;
  suspended = false;
  private deadline = 0;
  private saved = 0;
  constructor(readonly kind: SuperKind) {}
  remaining(frame: number) { return this.suspended ? this.saved : Math.max(0, this.deadline - frame); }
  stage(frame: number) {
    if (!this.present) return 0;
    if (this.ready) return 102;
    const fraction = Math.trunc((SUPER_RECHARGE[this.kind] - this.remaining(frame)) * 256 / SUPER_RECHARGE[this.kind]);
    return (fraction * 102 + 128) >> 8;
  }
  step(frame: number, available: boolean, powered: boolean) {
    if (!available) { this.present = this.ready = this.suspended = false; return false; }
    if (!this.present) {
      this.present = true; this.deadline = frame + SUPER_RECHARGE[this.kind];
      // HOUSE.CPP enables ion quietly at low power; nuclear suspension starts on the next AI call.
      this.suspended = this.kind === 'ion' && !powered; this.saved = SUPER_RECHARGE[this.kind];
      return false;
    }
    if (this.ready) return false;
    if (!powered && !this.suspended) { this.saved = this.remaining(frame); this.suspended = true; }
    else if (powered && this.suspended) { this.deadline = frame + this.saved; this.suspended = false; }
    if (!this.suspended && this.remaining(frame) === 0) { this.ready = true; return true; }
    return false;
  }
  discharge(frame: number) {
    if (!this.present || !this.ready || this.suspended) return false;
    this.ready = false; this.deadline = frame + SUPER_RECHARGE[this.kind]; return true;
  }
}

export interface SuperBuilding { id:number; type:string; cell:number; owner:number; health:number; active:boolean; selling:boolean }
interface Attack { owner:number; kind:SuperKind; target:number; born:number; launch:number; centerX:number; centerY:number; launchX:number; launchY:number; impact:number; damaged:boolean; cancelled:boolean; doorStarted:boolean; launched:boolean }
export interface SuperEvent { owner:number; x:number; y:number; sound?:string; speech?:string; shake?:boolean }

/** Few CPU-owned superweapon timelines; damage still uses the shared GPU combat pipeline. */
export class SuperWeapons {
  readonly charges = [0, 1].map(() => ({ ion: new SuperCharge('ion'), nuke: new SuperCharge('nuke') }));
  readonly visuals = new Int32Array(SUPER_SPRITES * SUPER_VISUAL_WORDS).fill(-1);
  private readonly attacks: Attack[] = [];
  readonly events:SuperEvent[]=[];
  constructor(readonly width:number, readonly height:number, readonly bounds:{x:number;y:number;width:number;height:number},
    private readonly frameCounts:ReadonlyMap<string,number>) {}
  private center(b:SuperBuilding):[number,number] {
    const shape=BUILDINGS.get(b.type)!;
    return [b.cell%this.width*256+(shape.width===2?255:shape.width*128),Math.trunc(b.cell/this.width)*256+(shape.height===2?255:shape.height*128)];
  }
  targetCell(building:SuperBuilding){
    const [x,y]=this.center(building);
    return Math.trunc(y/256)*this.width+Math.trunc(x/256);
  }
  fire(owner:number,kind:SuperKind,cell:number,frame:number,buildings:readonly SuperBuilding[]) {
    const x=cell%this.width,y=Math.trunc(cell/this.width);
    if(x<this.bounds.x||x>=this.bounds.x+this.bounds.width||y<this.bounds.y||y>=this.bounds.y+this.bounds.height)return false;
    if(!this.charges[owner][kind].discharge(frame))return false;
    const site=buildings.find(b=>b.owner===owner&&b.type===(kind==='ion'?'EYE':'TMPL')&&b.health>0);
    const [centerX,centerY]=site?this.center(site):[x*256+128,128];
    const [launchX,launchY]=site?movePoint(centerX,centerY,1,0x1a0):[centerX,centerY];
    // BUILDING.CPP Mission_Missile: five door stages, 14 ticks of smoke, then 8 seconds aloft.
    const down=frame+(site?5+14+120:0),targetY=y*256+128,startY=site?384:128;
    let missileY=startY,previous=Math.abs(targetY-startY),travel=0,timer=Math.min(255,Math.trunc(previous/100)+4);
    if(kind==='nuke')do{
      missileY+=100;travel++;timer--;
      const proximity=Math.abs(targetY-missileY);
      if(!timer||proximity<16||proximity<256&&proximity>previous)break;
      previous=proximity;
    }while(travel<255);
    this.attacks.push({owner,kind,target:cell,born:frame,launch:site?.id??-1,centerX,centerY,launchX,launchY,impact:kind==='ion'?frame:down+travel,damaged:false,cancelled:false,doorStarted:false,launched:false});
    return true;
  }
  doorFrame(id:number,frame:number) {
    const attack=this.attacks.find(a=>a.kind==='nuke'&&a.launch===id&&frame-a.born<5);
    return attack?frame-attack.born:-1;
  }
  step(frame:number,buildings?:readonly SuperBuilding[]):ExplosionCommand[] {
    const result:ExplosionCommand[]=[];
    this.events.length=0;
    this.visuals.fill(-1);
    const show=(slot:number,shape:number,stage:number,x:number,y:number)=>{
      if(stage>=0&&stage<(this.frameCounts.get(SUPER_SHAPES[shape])??0))this.visuals.set([shape,stage,x,y,0],slot*SUPER_VISUAL_WORDS);
    };
    for(const a of this.attacks){
      const x=a.target%this.width*256+128,y=Math.trunc(a.target/this.width)*256+128,base=a.owner*4;
      if(a.kind==='ion'){
        const age=frame-a.born;
        if(age===0)this.events.push({owner:a.owner,x,y,sound:'ION1',speech:'ioncharging'});
        if(age<15)show(base,0,age,x,y);else show(base,1,age-15,x,y);
        if(!a.damaged&&age===11){result.push({frame,x,y,damage:600,warhead:5,source:a.launch,scorch:true,crater:true});a.damaged=true;}
      }else{
        const age=frame-a.born,down=a.born+(a.launch>=0?139:0);
        if(a.launch>=0&&frame<down&&buildings&&!buildings.some(b=>b.id===a.launch&&b.health>0))a.cancelled=true;
        if(a.launch>=0&&!a.cancelled){
          if(age===5)a.doorStarted=true;
          if(age===19){a.launched=true;this.events.push({owner:a.owner,x:a.launchX,y:a.launchY,sound:'NUKEMISL',speech:'nukelaunched'});}
        }
        if(a.doorStarted)show(base+1,2,age-5,a.centerX,a.centerY);
        if(a.launched&&a.launchY-(age-19)*100>=0)show(base+2,3,0,a.launchX,a.launchY-(age-19)*100);
        if(a.cancelled)continue;
        if(frame===down)this.events.push({owner:a.owner,x,y:384,sound:'NUKEMISL',speech:'nukeincoming'});
        if(frame===a.impact)this.events.push({owner:a.owner,x,y,sound:'NUKEXPLO'});
        if(frame===a.impact+19)this.events.push({owner:a.owner,x,y,shake:true});
        if(frame>=down&&frame<a.impact)show(base+3,4,0,x,(a.launch>=0?384:128)+(frame-down)*100);
        if(frame>=a.impact)show(base+3,5,frame-a.impact,x,y);
        if(frame===a.impact)result.push({frame,x,y,damage:1,warhead:1,source:-1});
        if(!a.damaged&&frame-a.impact===19){
          // ANIM.CPP Middle, multiplayer: 7x7 cells, each explosion has 200 / (3/2+1) = 100 damage.
          for(let dx=-3;dx<=3;dx++)for(let dy=-3;dy<=3;dy++){
            const xx=Math.trunc(x/256)+dx,yy=Math.trunc(y/256)+dy;
            if(xx>=this.bounds.x&&xx<this.bounds.x+this.bounds.width&&yy>=this.bounds.y&&yy<this.bounds.y+this.bounds.height)result.push({frame,x:xx*256+128,y:yy*256+128,damage:100,warhead:3,source:-1,scorch:true,crater:dx===0&&dy===0});
          }
          a.damaged=true;
        }
      }
    }
    for(let i=this.attacks.length-1;i>=0;i--){const a=this.attacks[i];if(frame>(a.kind==='ion'?a.born+15+(this.frameCounts.get('ART-EXP1')??0):a.impact+(this.frameCounts.get('ATOMSFX')??0)))this.attacks.splice(i,1);}
    return result;
  }
}
