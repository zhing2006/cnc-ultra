// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { areAllied } from './alliances.ts';
import { desiredFacing256, distance } from '../coord.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { canCaptureBuilding } from '../data/abilities.ts';
import { MOVEMENT } from '../data/movement.ts';
import { combatTypes, weapons } from '../data/combat.ts';
import type { CpuCombat } from './combat-cpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
const neighbors = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];

function directStep(battle:CpuCombat,id:number,cell:number) {
  const m=battle.movement,u=m.units,at=id*U.WORDS,w=m.setup.grid.width,x=cell%w*256+128,y=Math.trunc(cell/w)*256+128;
  u[at+U.UDEST]=cell;u[at+U.UHEAD_X]=x;u[at+U.UHEAD_Y]=y;u[at+U.UDSLOT]=0;
  u[at+U.UFACE]=u[at+U.UDESIRED]=desiredFacing256(u[at],u[at+1],x,y);u[at+U.USPEED]=255;
  m.goals[id]=cell;m.pathGoals[id]=U.DIRECT_STEP;
}

/** INFANTRY.CPP Assign_Destination/Can_Enter_Cell: the target structure permits the final step. */
export function prepareSpecialInfantry(battle:CpuCombat) {
  const m=battle.movement,u=m.units,w=m.setup.grid.width,h=m.setup.grid.height;
  for(let id=0;id<m.goals.length;id++){
    const at=id*U.WORDS,mode=u[at+U.UABILITY_MODE],target=u[at+U.UABILITY_TARGET]-1,b=target*U.WORDS;
    if(!mode||u[at+U.UHEALTH]<=0||u[at+U.UATTACHED])continue;
    const name=target>=0?MOVEMENT[u[b+U.UTYPE]].name:'';
    const transport=name==='TRAN'&&u[b+U.UALTITUDE]===0&&mode%2===1&&!battle.setup.units.some((_,i)=>u[i*U.WORDS+U.UHEALTH]>0&&u[i*U.WORDS+U.UATTACHED]===target+1);
    if(target<0||u[b+U.UHEALTH]<=0||!transport&&(u[b+U.UDOMAIN]!==2||mode%2===1&&!canCaptureBuilding(name,battle.setup.campaignLevel))){
      u[at+U.UABILITY_MODE]=u[at+U.UABILITY_TARGET]=0;m.goals[id]=m.pathGoals[id]=-1;continue;
    }
    if(mode>=3)continue;
    if(!u[at+U.UABILITY_ENTRY]||u[at+U.UWAIT]>30||transport&&u[at+U.UABILITY_ENTRY]!==u[b+U.UCELL]+1){
      let score=0x7fffffff,approach=-1,entry=-1;
      for(const [dx,dy] of transport?[[0,0]]:BUILDINGS.get(name)!.occupy){
        const destination=u[b+(transport?U.UCELL:U.UORIGIN)]+dy*w+dx;
        for(const [ox,oy] of neighbors){
          const x=destination%w+ox,y=Math.trunc(destination/w)+oy,cell=y*w+x;
          if(x<0||x>=w||y<0||y>=h||!m.setup.grid.edges[cell])continue;
          if(!m.occupancy.subarray(cell*5,cell*5+5).some(value=>value===0||value===id+1))continue;
          const d=distance(u[at],u[at+1],x*256+128,y*256+128);
          if(d<score){score=d;approach=cell;entry=destination;}
        }
      }
      if(approach<0)continue;
      u[at+U.UABILITY_ENTRY]=entry+1;u[at+U.UABILITY_ORIGIN]=approach+1;
      m.goals[id]=approach;m.pathGoals[id]=-1;
    }
    if(u[at+U.UCELL]===u[at+U.UABILITY_ORIGIN]-1&&u[at+U.UDEST]<0){
      directStep(battle,id,u[at+U.UABILITY_ENTRY]-1);u[at+U.UABILITY_MODE]+=2;
    }
  }
}

/** INFANTRY.CPP Per_Cell_Process, with stable object-order ownership changes. */
export function finishSpecialInfantry(battle:CpuCombat) {
  const m=battle.movement,u=m.units,c=battle.state;
  for(let id=0;id<m.goals.length;id++){
    const at=id*U.WORDS,mode=u[at+U.UABILITY_MODE],target=u[at+U.UABILITY_TARGET]-1,b=target*U.WORDS;
    if(mode<3||u[at+U.UHEALTH]<=0||u[at+U.UDEST]>=0||u[at+U.UCELL]!==u[at+U.UABILITY_ENTRY]-1)continue;
    if(target>=0&&u[b+U.UHEALTH]>0){
      if(mode===3){
        // Captured may decline an allied building, but Per_Cell_Process still consumes the engineer.
        if(!areAllied(battle.setup,u[at+U.UOWNER],u[b+U.UOWNER])){
          u[b+U.UOWNER]=u[at+U.UOWNER];u[b+U.UCAPTURE_TICK]=battle.frame;
          c[target*C.CWORDS+C.CTARGET]=-1;c[target*C.CWORDS+C.CMISSION]=C.GUARD;
        }
        u[at+U.UHEALTH]=0;m.goals[id]=m.pathGoals[id]=-1;
      }else{
        u[b+U.UBOMB_TICK]=battle.frame+20;u[b+U.UBOMB_SOURCE]=id+1;
        c[id*C.CWORDS+C.CARM]=weapons[combatTypes[u[at+U.UTYPE]].primary].rof;
        directStep(battle,id,u[at+U.UABILITY_ORIGIN]-1);
      }
    }
    u[at+U.UABILITY_MODE]=u[at+U.UABILITY_TARGET]=0;
  }
  for(let id=0;id<m.goals.length;id++){
    const at=id*U.WORDS,parent=u[at+U.UATTACHED]-1;
    if(parent>=0&&u[parent*U.WORDS+U.UCAPTURE_TICK]===battle.frame)u[at+U.UOWNER]=u[parent*U.WORDS+U.UOWNER];
    // TECHNO.CPP Captured -> Detach_All(false) -> Detach, including suspended targets.
    const s=id*C.CWORDS,captured=(target:number)=>target>=0&&u[target*U.WORDS+U.UCAPTURE_TICK]===battle.frame;
    if(c[s+C.CSUSPENDED_MISSION]&&captured(c[s+C.CSUSPENDED_TARGET])){c[s+C.CSUSPENDED_MISSION]=0;c[s+C.CSUSPENDED_TARGET]=-1;}
    if(captured(c[s+C.CTARGET])){
      c[s+C.CTARGET]=-1;c[s+C.CFIRE]=-1;m.goals[id]=-1;m.pathGoals[id]=-1;
      u[at+U.UROUTE]=-1;u[at+U.UWAIT]=0;u[at+U.URETRIES]=10;u[at+U.USTALLED]=0;
      c[s+C.CLOCAL_ROUTE]=c[s+C.CLOCAL_WAIT]=c[s+C.CROUTE_LENGTH]=0;c[s+C.CLOCAL_DEST]=c[s+C.CAPPROACH_GOAL]=-1;c[s+C.CSCAN]=0;
      if(c[s+C.CSUSPENDED_MISSION]){
        c[s+C.CMISSION]=c[s+C.CSUSPENDED_MISSION]-1;c[s+C.CTARGET]=c[s+C.CSUSPENDED_TARGET];
        m.goals[id]=c[s+C.CSUSPENDED_GOAL];u[at+U.UABILITY_MODE]=c[s+C.CSUSPENDED_ABILITY];c[s+C.CSUSPENDED_MISSION]=0;
      }
    }
  }
}
