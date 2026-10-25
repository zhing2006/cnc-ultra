// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { movementType } from '../data/movement.ts';
import { combatTypes } from '../data/combat.ts';
import { INTERRUPTIBLE_INFANTRY_ACTIONS } from '../data/abilities.ts';
import type { CpuCombat } from './combat-cpu.ts';
import * as C from './combat-state.ts';
import { distance } from '../coord.ts';
import { harvestBail } from './tiberium-cpu.ts';
import { BUILDING_WORDS } from './economy-runtime.ts';
import * as U from './units-state.ts';

export const HWORDS=10,HBASE=3,HMODE=0,HTIMER=1,HLOAD=2,HREF=3,HGOAL=4,HGEN=5,HARCHIVE=6,HSTAGE=7,HCREDIT=8,HCLIENT=9;
export function initialHarvest(count:number){return new Int32Array(HBASE+count*HWORDS);}
export interface HarvestContext {
  battle:CpuCombat;ore:Int32Array;state:Int32Array;
  buildings:Int32Array;playable:Int32Array;passable:Uint8Array;
  buildable?:ArrayLike<number>;bibs?:ArrayLike<number>;
}
/** UNIT.CPP Mission_Harvest/Goto_Tiberium/Harvesting; BUILDING.CPP Mission_Harvest. */
export function stepHarvest(v:HarvestContext){
  const {battle,ore,state:h,buildings,playable,passable}=v;
  const u=battle.units,{goals,pathGoals:paths,occupancy}=battle.movement,{width}=battle.setup.grid,count=goals.length;
  const clearance=new Set<number>();
  h[2]++;
  const seek=(id:number)=>{
    const cell=u[id*U.WORDS+U.UCELL];
    if(ore[cell]>=0)return cell;
    for(let r=1;r<32;r++)for(let x=-r;x<=r;x++)for(const [dx,dy] of [[x,-r],[x,r],[-r,x],[r,x]]){
      const xx=cell%width+dx,yy=Math.trunc(cell/width)+dy,c=yy*width+xx;
      if(xx<0||xx>=width||yy<0||c>=ore.length||!playable[c]||ore[c]<0)continue;
      let free=true;for(let s=0;s<5;s++)if(occupancy[c*5+s]&&occupancy[c*5+s]!==id+1)free=false;
      if(free)return c;
    }
    return -1;
  };
  for(let id=0;id<count;id++){
    const at=id*U.WORDS,p=HBASE+id*HWORDS;
    if(u[at+U.UTYPE]!==movementType('HARV')||u[at+U.UHEALTH]<=0||u[at+U.UENTER]<0)continue;
    if(h[p+HGEN]!==u[at+U.UGENERATION]){h.fill(0,p,p+HWORDS);h[p+HGEN]=u[at+U.UGENERATION];h[p+HREF]=h[p+HGOAL]=h[p+HARCHIVE]=-1;}
    if(goals[id]>=0&&goals[id]!==h[p+HGOAL]&&!u[at+U.UATTACHED]){h[p+HMODE]=0;h[p+HTIMER]=0;h[p+HREF]=-1;h[p+HGOAL]=goals[id];}
    const ordered=u[at+U.UENTER]-1;
    if(ordered>=0&&!u[at+U.UATTACHED]){
      u[at+U.UENTER]=0;
      if(u[ordered*U.WORDS+U.UTYPE]===movementType('PROC')&&u[ordered*U.WORDS+U.UHEALTH]>0&&u[ordered*U.WORDS+U.UOWNER]===u[at+U.UOWNER]&&buildings[ordered*BUILDING_WORDS+3]){
        h[p+HREF]=ordered;h[p+HMODE]=3;h[p+HTIMER]=0;
        goals[id]=h[p+HGOAL]=u[ordered*U.WORDS+U.UCELL]+width-1;paths[id]=-1;
      }
    }
    const ref=h[p+HREF];
    if(ref>=0&&(u[ref*U.WORDS+U.UHEALTH]<=0||!buildings[ref*BUILDING_WORDS+3])){
      if(u[at+U.UATTACHED]){u[at+U.UHEALTH]=0;u[at+U.UATTACHED]=0;continue;}
      h[p+HREF]=-1;h[p+HMODE]=2;h[p+HTIMER]=0;goals[id]=-1;h[p+HGOAL]=-1;
    }
    h[p+HSTAGE]++;
    if(h[p+HTIMER]>0&&--h[p+HTIMER]>0)continue;
    h[p+HTIMER]=15;
    const setGoal=(cell:number)=>{goals[id]=cell;paths[id]=-1;h[p+HGOAL]=cell;};
    const mode=h[p+HMODE],cell=u[at+U.UCELL];
    if(mode===0){
      if(goals[id]>=0)continue;
      const found=seek(id);
      if(found===cell){h[p+HMODE]=1;h[p+HTIMER]=1;}
      else if(found>=0)setGoal(found);
      else{h[p+HMODE]=7;h[p+HTIMER]=225;}
    }else if(mode===1){
      if(goals[id]>=0)continue;
      if(h[p+HLOAD]<28&&ore[cell]>=0){
        const bail=harvestBail(ore[cell],h[p+HLOAD]);h[p+HLOAD]+=bail.taken;ore[cell]=bail.amount;h[p+HSTAGE]=0;
      }else{
        if(h[p+HLOAD]===28){h[p+HMODE]=2;h[p+HARCHIVE]=cell;}
        else{const found=seek(id);if(found<0){h[p+HMODE]=2;h[p+HARCHIVE]=-1;}else if(found!==cell)setGoal(found);}
        h[p+HTIMER]=1;
      }
    }else if(mode===2){
      if(goals[id]>=0)continue;
      let best=-1,bestDistance=0x7fffffff,nearest=-1,nearestDistance=0x7fffffff;
      for(let other=0;other<count;other++){
        const b=other*U.WORDS;
        if(u[b+U.UTYPE]!==movementType('PROC')||u[b+U.UOWNER]!==u[at+U.UOWNER]||u[b+U.UHEALTH]<=0||!buildings[other*BUILDING_WORDS+3])continue;
        let busy=false;for(let j=0;j<count;j++)if(j!==id&&u[j*U.WORDS+U.UHEALTH]>0&&h[HBASE+j*HWORDS+HREF]===other&&h[HBASE+j*HWORDS+HMODE]>=3)busy=true;
        const d=distance(u[at],u[at+1],u[b],u[b+1]);if(d<nearestDistance){nearest=other;nearestDistance=d;}if(!busy&&d<bestDistance){best=other;bestDistance=d;}
      }
      if(best>=0){h[p+HREF]=best;h[p+HMODE]=3;setGoal(u[best*U.WORDS+U.UCELL]+width-1);h[p+HTIMER]=1;}
      else if(nearest>=0){
        // UNIT.CPP FINDHOME retries CAN_LOAD with ScenarioInit, then approaches Nearby_Location.
        const center=u[nearest*U.WORDS+U.UCELL];let found=-1;
        const visit=(dx:number,dy:number)=>{
          const x=center%width+dx,y=Math.trunc(center/width)+dy,c=y*width+x;
          if(x>=0&&x<width&&y>=0&&c<ore.length&&playable[c]&&passable[c]&&ore[c]<0&&(v.buildable?.[c]??1)&&!v.bibs?.[c]&&Array.from(occupancy.subarray(c*5,c*5+5)).every(owner=>owner===0))found=c;
        };
        for(let r=0;r<Math.ceil(width/2)&&found<0;r++){for(let x=-r;x<=r;x++){visit(x,-r);visit(x,r);}for(let y=1-r;y<r;y++){visit(-r,y);visit(r,y);}}
        if(found>=0)setGoal(found);
      }
    }else if(mode===3){
      h[p+HTIMER]=1;
      let busy=false;for(let other=0;other<count;other++)if(other!==id&&u[other*U.WORDS+U.UHEALTH]>0&&h[HBASE+other*HWORDS+HREF]===ref&&(h[HBASE+other*HWORDS+HMODE]>=4||other<id&&h[HBASE+other*HWORDS+HMODE]===3))busy=true;
      if(busy)continue;
      if(goals[id]<0&&u[at+U.UDEST]<0){
        const dock=u[ref*U.WORDS+U.UCELL]+width-1;
        // BUILDING.CPP Receive_Message(RADIO_DOCKING): repeat MOVE_HERE after interrupted navigation.
        if(cell!==dock)setGoal(dock);
        else{
          u[at+U.UDESIRED]=160;
          if(u[at+U.UFACE]===160){forceHarvestTrack(u,at,64,cell-width,width);h[p+HMODE]=8;}
        }
      }
    }else if(mode===4){h[p+HMODE]=5;h[p+HTIMER]=20;h[p+HSTAGE]=0;
    }else if(mode===5){
      // BUILDING.CPP Mission_Harvest(MIDDLE): Incoming(0,true) clears the bib before each bail.
      const exit=u[ref*U.WORDS+U.UCELL]+width-1;
      for(let slot=0;slot<5;slot++){const other=occupancy[exit*5+slot]-1;if(other>=0)clearance.add(other);}
      if(h[p+HLOAD]>0){h[p+HLOAD]--;h[u[at+U.UOWNER]]+=25;}
      h[p+HTIMER]=20;h[p+HSTAGE]=0;
      if(!h[p+HLOAD]){h[p+HMODE]=6;h[p+HTIMER]=24;}
    }else if(mode===6){
      const exit=u[ref*U.WORDS+U.UCELL]+width-1;
      if(passable[exit]&&Array.from(occupancy.subarray(exit*5,exit*5+5)).every(v=>v===0||v===id+1)){
        u[at+U.UATTACHED]=0;h[p+HMODE]=9;h[p+HTIMER]=1;setGoal(-1);
        forceHarvestTrack(u,at,65,u[ref*U.WORDS+U.UCELL]+width-1,width);
      }else h[p+HTIMER]=1;
    }else if(mode===8){
      h[p+HTIMER]=1;if(u[at+U.UDEST]<0){u[at+U.UATTACHED]=ref+1;h[p+HMODE]=4;h[p+HTIMER]=28;h[p+HSTAGE]=0;}
    }else if(mode===9){
      h[p+HTIMER]=1;if(u[at+U.UDEST]<0){h[p+HMODE]=0;h[p+HREF]=-1;}
    }else{h[p+HMODE]=0;h[p+HTIMER]=15;}
  }
  for(let id=0;id<count;id++)h[HBASE+id*HWORDS+HCLIENT]=0;
  for(let id=0;id<count;id++){
    const p=HBASE+id*HWORDS,ref=h[p+HREF];
    if(u[id*U.WORDS+U.UHEALTH]>0&&u[id*U.WORDS+U.UTYPE]===movementType('HARV')&&ref>=0&&h[p+HMODE]>=3&&h[p+HMODE]<=6)h[HBASE+ref*HWORDS+HCLIENT]=id+1;
  }
  for(const id of clearance)clearRefineryExit(battle,id);
}

/** CELL.CPP Incoming with IsScatter enabled; UNIT.CPP / INFANTRY.CPP Scatter. */
function clearRefineryExit(battle:CpuCombat,id:number){
  const u=battle.units,s=battle.state,at=id*U.WORDS,c=id*C.CWORDS;
  if(u[at+U.UHEALTH]<=0||u[at+U.UATTACHED]||u[at+U.UDOMAIN]!==0)return;
  const type=combatTypes[u[at+U.UTYPE]];
  if(type.name==='BOAT'||type.name==='LST')return;
  if(u[at+U.UKIND]){
    if(!type.fraidy&&(u[at+U.UDEST]>=0||battle.movement.goals[id]>=0))return;
    if(s[c+C.CACTION]>=0&&!INTERRUPTIBLE_INFANTRY_ACTIONS.has(s[c+C.CACTION]))return;
  }
  if(battle.movement.scatter(id)>=0&&u[at+U.UKIND]){
    s[c+C.CMISSION]=C.MOVE;s[c+C.CFIRE]=-1;s[c+C.CACTION]=0;s[c+C.CSTAGE]=0;
    s[c+C.CLOCAL_ROUTE]=s[c+C.CROUTE_LENGTH]=0;s[c+C.CLOCAL_DEST]=-1;
  }
}

/** DRIVE.CPP Force_Track/Start_Driver, with the original refinery tracks. */
function forceHarvestTrack(u:Int32Array,at:number,track:number,cell:number,width:number){
  u[at+U.UDEST]=cell;u[at+U.UTRACK]=track;u[at+U.UTRACK_STEP]=0;u[at+U.UACCUM]=0;u[at+U.USPEED]=128;
  u[at+U.UHEAD_X]=cell%width*256+128;u[at+U.UHEAD_Y]=Math.trunc(cell/width)*256+128;
}
