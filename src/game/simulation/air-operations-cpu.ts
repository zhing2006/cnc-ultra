// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { randomWord } from '../../engine/simulation/fixed.ts';
import { distance,desiredFacing256,movePoint } from '../coord.ts';
import { movementType,MOVEMENT } from '../data/movement.ts';
import { combatTypes,weapons } from '../data/combat.ts';
import type { CpuCombat } from './combat-cpu.ts';
import { CpuAircraft,initialAircraft,AIR_WORDS,ASTAGE,ADELAY,ASPEED,AFACING,ADESIRED,AGOAL,ATAKEOFF,ALANDING,
  AGENERATION,AHOVER,ACONTACT,AMISSION,ASTATUS,ATIMER,ATARGET,ASERVICE,ARETREAT } from './aircraft-cpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';

/** AIRCRAFT.CPP Good_Fire_Location: keep the previous best, rather than sorting all candidates. */
export function airFireLocation(battle:CpuCombat,id:number,target:number,playable:ArrayLike<number>){
  const u=battle.units,at=id*U.WORDS,width=battle.setup.grid.width,type=combatTypes[u[at+U.UTYPE]],t=target*U.WORDS;
  if(type.primary<0)return -1;
  const tx=u[t],ty=u[t+1]-Math.trunc((u[t+U.UALTITUDE]*256+12)/24);
  let best=-1,previous=-1,value=0x7fffffff;
  for(let r=weapons[type.primary].range-384;r>384;r-=256){
    for(let direction=0;direction<255;direction+=16){
      const [x,y]=movePoint(tx,ty,direction,r),cell=Math.trunc(y/256)*width+Math.trunc(x/256);
      if(x<0||y<0||x>=width*256||y>=battle.setup.grid.height*256||!playable[cell])continue;
      if(battle.setup.multiplayer===false&&battle.sight.shadow[cell]===-2)continue;
      let clear=true;
      for(let other=0;other<battle.setup.units.length;other++)if(u[other*U.WORDS+U.UDOMAIN]===1&&u[other*U.WORDS+U.UHEALTH]>0&&(u[other*U.WORDS+U.UCELL]===cell||battle.movement.goals[other]===cell))clear=false;
      const d=distance(u[at],u[at+1],x,y);
      if(clear&&d<value){previous=best;best=cell;value=d;}
    }
    if(best>=0)break;
  }
  return previous<0||randomWord(battle.setup.seed,battle.frame+1,id,180)%2===0?best:previous;
}

/** Aircraft mission scheduling surrounds the shared flight physics and combat tick. */
export class CpuAirOperations {
  constructor(readonly battle:CpuCombat,readonly aircraft:CpuAircraft,readonly playable:ArrayLike<number>){}
  before(cash:readonly number[]=[0,0]){
    const {battle,aircraft}=this,u=battle.units,c=battle.state,a=aircraft.state,goals=battle.movement.goals;
    for(let id=0;id<goals.length;id++)if(u[id*U.WORDS+U.UTYPE]===movementType('HPAD'))u[id*U.WORDS+U.UDOOR]=0;
    for(let id=0;id<goals.length;id++){
      const at=id*U.WORDS,p=id*AIR_WORDS,s=id*C.CWORDS,type=combatTypes[u[at+U.UTYPE]];
      if(u[at+U.UDOMAIN]!==1||u[at+U.UHEALTH]<=0||type.name==='C17'||type.name==='A10')continue;
      if(a[p+AGENERATION]!==u[at+U.UGENERATION]){a.set(initialAircraft({...battle.setup,units:[{type:u[at+U.UTYPE],cell:u[at+U.UCELL],facing:u[at+U.UFACE]}]}),p);a[p+AGENERATION]=u[at+U.UGENERATION];}
      if(a[p+ARETREAT]){c[s+C.CACTIVE]=0;continue;}
      if(battle.setup.campaignLevel===7&&u[at+U.UOWNER]===battle.setup.goodOwner&&u[at+U.UOWNER]!==battle.humanOwner&&c[s+C.CMISSION]===C.GUARD&&u[at+U.UALTITUDE]!==24){c[s+C.CACTIVE]=0;continue;}
      // AIRCRAFT.CPP Mission_Hunt / Mission_Guard: rotary-wing sorties and computer repair.
      if(c[s+C.CMISSION]===C.HUNT&&c[s+C.CTARGET]>=0&&c[s+C.CAMMO])c[s+C.CMISSION]=C.ATTACK;
      if(u[at+U.UOWNER]!==battle.humanOwner&&c[s+C.CMISSION]===C.GUARD&&u[at+U.UALTITUDE]!==24){
        let repair=-1,best=0x7fffffff;const contact=a[p+ACONTACT];
        if((cash[u[at+U.UOWNER]]??0)>=100&&u[at+U.UHEALTH]*2<=MOVEMENT[u[at+U.UTYPE]].strength&&(contact<0||u[contact*U.WORDS+U.UTYPE]!==movementType('FIX'))){
          for(let other=0;other<goals.length;other++){
            const b=other*U.WORDS;if(u[b+U.UTYPE]!==movementType('FIX')||u[b+U.UOWNER]!==u[at+U.UOWNER]||u[b+U.UHEALTH]<=0||!c[other*C.CWORDS+C.CACTIVE])continue;
            let busy=false;for(let j=0;j<goals.length;j++)if(j!==id&&u[j*U.WORDS+U.UHEALTH]>0&&(a[j*AIR_WORDS+ACONTACT]===other||u[j*U.WORDS+U.UDOMAIN]===0&&u[j*U.WORDS+U.UENTER]===other+1))busy=true;
            const d=distance(u[at],u[at+1],u[b],u[b+1]);if(!busy&&d<best){repair=other;best=d;}
          }
        }
        if(repair>=0){u[at+U.UENTER]=repair+1;c[s+C.CTARGET]=-1;}
        else if(c[s+C.CTARGET]>=0&&c[s+C.CAMMO])c[s+C.CMISSION]=C.ATTACK;
        if(contact>=0&&u[contact*U.WORDS+U.UTYPE]===movementType('FIX')&&a[p+AMISSION]===3&&u[at+U.UHEALTH]>=MOVEMENT[u[at+U.UTYPE]].strength){a[p+ACONTACT]=-1;a[p+AMISSION]=2;goals[id]=a[p+AGOAL]=-1;}
      }
      c[s+C.CACTIVE]=0;
      const enter=u[at+U.UENTER]-1;
      if(enter>=0&&u[enter*U.WORDS+U.UHEALTH]>0&&u[enter*U.WORDS+U.UOWNER]===u[at+U.UOWNER]&&c[enter*C.CWORDS+C.CACTIVE]&&['HPAD','FIX'].includes(MOVEMENT[u[enter*U.WORDS+U.UTYPE]].name)){
        let busy=false;for(let other=0;other<goals.length;other++)if(other!==id&&u[other*U.WORDS+U.UHEALTH]>0&&(a[other*AIR_WORDS+ACONTACT]===enter||u[other*U.WORDS+U.UDOMAIN]===0&&u[other*U.WORDS+U.UENTER]===enter+1))busy=true;
        if(busy){u[at+U.UENTER]=0;continue;}
        a[p+ACONTACT]=enter;a[p+AHOVER]=0;a[p+AMISSION]=2;c[s+C.CMISSION]=C.GUARD;c[s+C.CTARGET]=-1;
        const cell=u[enter*U.WORDS+U.UTYPE]===movementType('FIX')?u[enter*U.WORDS+U.UCELL]:u[enter*U.WORDS+U.UORIGIN]+1;
        goals[id]=a[p+AGOAL]=cell;a[p+ASTAGE]=u[at+U.UALTITUDE]===24?2:1;a[p+ADELAY]=0;u[at+U.UENTER]=0;
        if(!u[at+U.UALTITUDE]&&distance(u[at],u[at+1],...aircraft.point(id,cell))<16){goals[id]=a[p+AGOAL]=-1;a[p+AMISSION]=3;a[p+ASERVICE]=28;}
      }
      const target=c[s+C.CTARGET];
      if(c[s+C.CMISSION]===C.MOVE&&goals[id]>=0){a[p+AMISSION]=0;a[p+AHOVER]=0;a[p+ACONTACT]=-1;continue;}
      if(c[s+C.CMISSION]===C.ATTACK&&target>=0&&type.primary>=0&&(a[p+AMISSION]!==1||a[p+ATARGET]!==target)){
        a[p+AMISSION]=1;a[p+ASTATUS]=0;a[p+ATIMER]=0;a[p+AHOVER]=1;a[p+ACONTACT]=-1;a[p+ATARGET]=target;
      }
      if(a[p+AMISSION]===1&&(c[s+C.CMISSION]!==C.ATTACK||target<0||u[target*U.WORDS+U.UHEALTH]<=0||!c[s+C.CAMMO])){a[p+ASTATUS]=6;a[p+ATIMER]=0;}
      if(!a[p+AMISSION]&&u[at+U.UALTITUDE]===24&&goals[id]<0)a[p+AMISSION]=2;
      if(a[p+AMISSION]===1){
        if(a[p+ATIMER]>0&&--a[p+ATIMER]>0)continue;
        a[p+ATIMER]=7;
        const state=a[p+ASTATUS];
        if(state===0)a[p+ASTATUS]=1;
        else if(state===1){
          const cell=airFireLocation(battle,id,target,this.playable);
          if(cell<0)a[p+ASTATUS]=6;
          else{goals[id]=a[p+AGOAL]=cell;a[p+ASTAGE]=1;a[p+ADELAY]=7;a[p+ASTATUS]=2;}
        }else if(state===2){
          if(u[at+U.UALTITUDE]===24){a[p+ASTATUS]=3;a[p+AFACING]=desiredFacing256(u[at],u[at+1],...aircraft.point(id,goals[id]));}
          a[p+ATIMER]=1;
        }else if(state===3){
          if(goals[id]<0){a[p+ASTATUS]=4;a[p+ASPEED]=0;}
          a[p+ATIMER]=1;
        }else if(state===4||state===5){
          a[p+ADESIRED]=u[at+U.UDESIRED]=desiredFacing256(u[at],u[at+1],u[target*U.WORDS],u[target*U.WORDS+1]);
          c[s+C.CACTIVE]=1;
          if(state===4)a[p+ATIMER]=1;
        }else{a[p+AMISSION]=2;a[p+AHOVER]=0;goals[id]=a[p+AGOAL]=-1;a[p+ATAKEOFF]=a[p+ALANDING]=0;c[s+C.CMISSION]=C.GUARD;c[s+C.CTARGET]=-1;}
      }
      if(a[p+AMISSION]===2){
        let contact=a[p+ACONTACT];
        if(contact>=0&&(u[contact*U.WORDS+U.UHEALTH]<=0||!c[contact*C.CWORDS+C.CACTIVE])){contact=a[p+ACONTACT]=-1;goals[id]=-1;}
        if(contact<0){
          let best=-1,value=0x7fffffff;
          for(let other=0;other<goals.length;other++){
            const b=other*U.WORDS;
            if(u[b+U.UTYPE]!==movementType('HPAD')||u[b+U.UOWNER]!==u[at+U.UOWNER]||u[b+U.UHEALTH]<=0||!c[other*C.CWORDS+C.CACTIVE])continue;
            let busy=false;for(let j=0;j<goals.length;j++)if(j!==id&&u[j*U.WORDS+U.UHEALTH]>0&&a[j*AIR_WORDS+ACONTACT]===other)busy=true;
            const d=distance(u[at],u[at+1],u[b],u[b+1]);if(!busy&&d<value){best=other;value=d;}
          }
          contact=a[p+ACONTACT]=best;a[p+AHOVER]=0;
          let landing=u[at+U.UCELL],nearest=0x7fffffff;
          if(best<0)for(let other=0;other<goals.length;other++){
            const b=other*U.WORDS;if(u[b+U.UDOMAIN]!==2||u[b+U.UOWNER]!==u[at+U.UOWNER]||u[b+U.UHEALTH]<=0)continue;
            const d=Math.trunc(distance(u[at],u[at+1],u[b],u[b+1])/(u[b+U.UTYPE]===movementType('HPAD')?4:1));
            if(d<nearest){nearest=d;landing=u[b+U.UCELL];}
          }
          goals[id]=a[p+AGOAL]=best>=0?u[best*U.WORDS+U.UORIGIN]+1:landing;
          a[p+ASTAGE]=u[at+U.UALTITUDE]===24?2:1;a[p+ADELAY]=0;
          if(best<0)a[p+AMISSION]=0;
        }else if(!u[at+U.UALTITUDE]&&goals[id]<0){a[p+AMISSION]=3;a[p+ASERVICE]=28;}
      }else if(a[p+AMISSION]===3){
        const contact=a[p+ACONTACT];
        if(contact<0||u[contact*U.WORDS+U.UHEALTH]<=0){a[p+AMISSION]=2;a[p+ACONTACT]=-1;continue;}
        if(u[contact*U.WORDS+U.UTYPE]===movementType('HPAD')&&c[s+C.CAMMO]<type.ammo){
          u[contact*U.WORDS+U.UDOOR]=1;
          if(--a[p+ASERVICE]<=0){c[s+C.CAMMO]++;a[p+ASERVICE]=45-Math.min(15,(15*c[contact*C.CWORDS+C.CPOWER]+128)>>8);}
        }
      }
      if(!a[p+AMISSION]&&u[at+U.UOWNER]===battle.humanOwner&&c[s+C.CMISSION]===C.GUARD)c[s+C.CTARGET]=-1;
    }
  }
  after(){
    const c=this.battle.state,a=this.aircraft.state,u=this.battle.units;
    for(let id=0;id<this.battle.setup.units.length;id++){
      const p=id*AIR_WORDS,s=id*C.CWORDS,at=id*U.WORDS,contact=a[p+ACONTACT];
      if(contact>=0&&u[contact*U.WORDS+U.UCAPTURE_TICK]===this.battle.frame&&u[at+U.UALTITUDE]===0&&distance(u[at],u[at+1],...this.aircraft.point(id,u[at+U.UCELL]))<64)u[at+U.UOWNER]=u[contact*U.WORDS+U.UOWNER];
      if(a[p+AMISSION]!==1||!c[s+C.CACTIVE])continue;
      if(c[s+C.CLAST_FIRE]===this.battle.frame){
        if(a[p+ASTATUS]===4){a[p+ASTATUS]=5;a[p+ATIMER]=1;}
        else{a[p+ASTATUS]=c[s+C.CAMMO]?1:6;a[p+ATIMER]=7;}
      }else if(a[p+ASTATUS]===4){a[p+ASTATUS]=5;a[p+ATIMER]=1;}
      else if(!c[s+C.CARM]){a[p+ASTATUS]=c[s+C.CAMMO]?1:6;a[p+ATIMER]=7;}
    }
  }
}
