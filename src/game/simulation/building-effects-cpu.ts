// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { randomWord } from '../../engine/simulation/fixed.ts';
import { movePoint } from '../coord.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { MOVEMENT } from '../data/movement.ts';
import { WALLS } from '../data/overlays.ts';
import { ANIMATION_IDS as A,combatTypes,modifyDamage } from '../data/combat.ts';
import type { CpuCombat } from './combat-cpu.ts';
import * as E from './building-effects-state.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';

/** BUILDING.CPP Take_Damage/Drop_Debris and ANIM.CPP AI, including attached fire damage. */
export class CpuBuildingEffects {
  readonly layout;
  readonly definitions;
  readonly smudges:Int32Array;
  constructor(readonly battle:CpuCombat,frames:E.EffectFrames){
    this.layout=E.initialBuildingEffects(battle.setup);this.definitions=E.effectDefinitions(frames);
    this.smudges=new Int32Array(battle.setup.grid.edges.length);
  }
  step(){
    const {battle,layout,definitions}=this,{state:s,base,capacity}=layout,u=battle.units,c=battle.state,tick=battle.frame,width=battle.setup.grid.width;
    for(let slot=0;slot<capacity;slot++){
      const at=base+slot*E.EFFECT_WORDS;
      if(!s[at+E.ETYPE]||tick<=s[at+E.EBORN]+1)continue;
      if(s[at+E.EDELAY]>0){s[at+E.EDELAY]--;continue;}
      const type=definitions[s[at+E.ETYPE]-1];
      if(++s[at+E.ETIMER]<Math.max(1,type.rate))continue;
      s[at+E.ETIMER]=0;s[at+E.EFRAME]++;
      const parent=s[at+E.EPARENT]-1;
      if(parent>=0&&u[parent*U.WORDS+U.UGENERATION]===s[at+E.EGEN]&&u[parent*U.WORDS+U.UHEALTH]>0){
        s[at+E.EACCUM]+=type.damage;
        const raw=s[at+E.EACCUM]>>8;s[at+E.EACCUM]&=255;
        const p=parent*U.WORDS,damage=modifyDamage(raw,3,combatTypes[u[p+U.UTYPE]].armor);
        if(damage){u[p+U.UHEALTH]=Math.max(0,u[p+U.UHEALTH]-damage);c[parent*C.CWORDS+C.CWARHEAD]=3;}
        if(!u[p+U.UHEALTH]){c[parent*C.CWORDS+C.CDEATH]=tick;c[parent*C.CWORDS+C.CKILLER]=-1;c[parent*C.CWORDS+C.CTARGET]=-1;c[parent*C.CWORDS+C.CFIRE]=-1;s[at+E.ETYPE]=0;continue;}
      }else s[at+E.EPARENT]=0;
      if(s[at+E.EFRAME]>=(s[at+E.ELOOPS]>1?type.loopEnd-type.start:type.count)){
        if(s[at+E.ELOOPS]>0)s[at+E.ELOOPS]--;
        if(s[at+E.ELOOPS])s[at+E.EFRAME]=type.loopStart;
        else if(type.next>=0){s[at+E.ETYPE]=type.next+1;s[at+E.EFRAME]=definitions[type.next].start;}
        else s[at+E.ETYPE]=0;
      }
    }
    let cursor=0;
    for(let id=0;id<battle.setup.units.length;id++){
      const at=id*U.WORDS,p=id*C.CWORDS,hp=u[at+U.UHEALTH],old=s[id*2],type=MOVEMENT[u[at+U.UTYPE]],building=BUILDINGS.get(type.name);
      const same=s[id*2+1]===u[at+U.UGENERATION];s[id*2]=hp;s[id*2+1]=u[at+U.UGENERATION];
      if(!same||!building||WALLS[type.name])continue;
      const dead=old>0&&hp<=0&&c[p+C.CDEATH]>=0,burn=hp>0&&(old*2>=type.strength&&hp*2<type.strength||old>1&&hp===1),debris=hp<=0&&c[p+C.CDEATH]>=0&&c[p+C.CDEATH]===tick-8;
      if(!dead&&!burn&&!debris)continue;
      for(const [part,[dx,dy]] of building.occupy.entries()){
        const cell=u[at+U.UORIGIN]+dy*width+dx;
        const pick=(stream:number,n:number)=>randomWord(battle.setup.seed,tick,id,300+part*24+stream)%n;
        const spawn=(kind:number,radius:number,delay:number,loops:number,parent:number,stream:number)=>{
          while(cursor<capacity&&s[base+cursor*E.EFFECT_WORDS+E.ETYPE])cursor++;
          if(cursor>=capacity||!definitions[kind].count)return;
          const x=cell%width*256+128,y=Math.trunc(cell/width)*256+128;
          let [xx,yy]=movePoint(x,y,pick(stream,256),radius);if(xx<0||yy<0||xx>=width*256||yy>=battle.setup.grid.height*256){xx=x;yy=y;}
          s.set([kind+1,0,delay,Math.max(1,(Math.max(1,loops)*definitions[kind].loops)&255),0,parent,xx,yy,tick,u[at+U.UGENERATION],0],base+cursor++*E.EFFECT_WORDS);
        };
        if(dead){
          this.smudges[cell]=1+pick(0,6);
          if(pick(1,2)===0){spawn(A.ANIM_FIRE_SMALL,128,pick(2,8),1+pick(3,3),0,4);if(pick(5,2)===0)spawn(A.ANIM_FIRE_MED,64,pick(6,8),1+pick(7,3),0,8);}
          spawn(A.ANIM_FBALL1,64,pick(9,4),1,0,10);
        }
        if(burn){
          if(c[p+C.CWARHEAD]===3){const roll=pick(11,14);if(roll<9)spawn(roll<5?A.ANIM_ON_FIRE_SMALL:roll<8?A.ANIM_ON_FIRE_MED:A.ANIM_ON_FIRE_BIG,96,0,roll===8?1:1+pick(12,3),id+1,13);}
          else if(pick(11,2)===0)spawn(A.ANIM_FIRE_SMALL,96,pick(12,8),1+pick(13,3),id+1,14);
        }
        if(debris){
          if(pick(15,6)<3)spawn(A.ANIM_SMOKE_M,80,pick(16,6),1+pick(17,2),0,18);
          this.smudges[cell]=(pick(19,4)===0?7:1)+pick(20,6);
        }
      }
    }
    battle.movement.occupy();
  }
}
