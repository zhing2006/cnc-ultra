// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { MOVEMENT,movementType } from '../data/movement.ts';
import { PRODUCTION } from '../data/production.ts';
import { repairStep } from './economy.ts';
import { entryPoint } from './infantry-spots.ts';
import { distance } from '../coord.ts';
import type { CpuCombat } from './combat-cpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';

export const SERVICE_BASE=2,SERVICE_WORDS=6,SFACILITY=0,SMODE=1,STIMER=2,SGENERATION=3,SACTIVE=4,SEXIT=5;
/** UNIT.CPP Exit_Repair, in facing order. */
export const REPAIR_EXITS=[[0,-2],[1,-1],[2,0],[1,1],[0,2],[-1,1],[-2,0],[-1,-1]] as const;
export const FACTORY_EXITS:Record<string,readonly (readonly [number,number])[]>={
  PYLE:[[1,2],[2,2],[0,2],[-1,2],[-1,-1],[0,-1],[1,-1],[2,-1],[2,-1],[-1,0],[2,0],[2,1],[-1,1]],
  HAND:[[2,3],[1,3],[0,3],[2,2],[-1,3],[-1,2],[0,0],[1,0],[-1,0],[2,0],[2,1],[-1,1]],
  WEAP:[[-1,3],[0,3],[-1,2],[1,3],[-1,1],[3,1],[3,2],[3,3],[2,3]],
};
/** BDATA.CPP exit points, and BUILDING.CPP Exit_Object's refinery offset. */
export const FACTORY_POINT:Record<string,readonly[number,number]>={PYLE:[320,352],HAND:[384,672],WEAP:[234,416],PROC:[224,469]};
export function initialServices(count:number){return new Int32Array(SERVICE_BASE+count*SERVICE_WORDS);}
export const SERVICE_TYPES=MOVEMENT.map(t=>{const type=PRODUCTION.get(t.name),repair=type?repairStep(type):{cost:0,health:0};return [Math.max(1,repair.cost),repair.health,t.strength] as const;});

/** BUILDING.CPP Exit_Object/Mission_Unload/Mission_Repair and TECHNO.CPP RADIO_REPAIR. */
export function stepServices(battle:CpuCombat,state:Int32Array,money:Int32Array){
  const u=battle.units,c=battle.state,m=battle.movement,width=battle.setup.grid.width,count=m.goals.length;
  const clear=(cell:number,id:number,infantry=false)=>cell>=0&&cell<battle.setup.grid.edges.length&&battle.setup.passable?.[cell]&&
    (infantry?Array.from(m.occupancy.subarray(cell*5,cell*5+5)).some(v=>v===0||v===id+1):Array.from(m.occupancy.subarray(cell*5,cell*5+5)).every(v=>v===0||v===id+1));
  const force=(id:number,track:number,cell:number)=>{
    const ordered=(u[id*U.WORDS+U.UFLAGS]&U.PLAYER_ORDER)!==0&&state[SERVICE_BASE+id*SERVICE_WORDS+SMODE]>=10;
    const goal=m.goals[id];
    const at=id*U.WORDS;u[at+U.UDEST]=cell;u[at+U.UTRACK]=track;u[at+U.UTRACK_STEP]=0;u[at+U.UACCUM]=0;u[at+U.USPEED]=u[at+U.UKIND]?255:128;
    // DRIVE.CPP Force_Track changes HeadTo without replacing the player's NavCom.
    u[at+U.UHEAD_X]=cell%width*256+128;u[at+U.UHEAD_Y]=Math.trunc(cell/width)*256+128;m.goals[id]=ordered?goal:-1;m.pathGoals[id]=-1;
  };
  const toward=(id:number,target:number)=>{
    const cell=u[id*U.WORDS+U.UCELL],dx=Math.sign(target%width-cell%width),dy=Math.sign(Math.trunc(target/width)-Math.trunc(cell/width));
    const dir=dy<0?(dx<0?7:dx>0?1:0):dy>0?(dx<0?5:dx>0?3:4):dx<0?6:2;
    const goal=m.goals[id];force(id,dir*9,cell+dy*width+dx);m.goals[id]=goal;
  };
  const infantryStep=(cell:number,id:number)=>{
    if(!clear(cell,id,true))return false;
    const at=id*U.WORDS,goal=m.point(cell),head=entryPoint(u[at],u[at+1],...goal);
    if(head[0]<0||head[1]<0||head[0]>=width*256||head[1]>=battle.setup.grid.height*256)return false;
    const physical=Math.trunc(head[1]/256)*width+Math.trunc(head[0]/256);
    for(let slot=0;slot<5;slot++){
      const owner=m.occupancy[physical*5+slot],queried=m.occupancy[cell*5+slot];
      if((!owner||owner===id+1)&&(!queried||queried===id+1)&&distance(...m.point(physical,slot),...goal)<distance(u[at],u[at+1],...goal))return true;
    }
    return false;
  };
  const scatterFromExit=(id:number)=>{
    const at=id*U.WORDS,cell=u[at+U.UCELL],facing=((u[at+U.UFACE]+16)&255)>>5;
    const bounds=battle.setup.bounds??{x:0,y:0,width,height:battle.setup.grid.height},directions=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
    let goal=-1;
    for(let i=0;i<8;i++){
      const [dx,dy]=directions[(facing+i)&7],x=cell%width+dx,y=Math.trunc(cell/width)+dy,next=y*width+x;
      if(x>=bounds.x&&x<bounds.x+bounds.width&&y>=bounds.y&&y<bounds.y+bounds.height&&clear(next,id))goal=next;
    }
    if(goal>=0){m.goals[id]=goal;m.pathGoals[id]=-1;}
  };
  for(let id=0;id<count;id++){
    const at=id*U.WORDS,p=SERVICE_BASE+id*SERVICE_WORDS;
    if(u[at+U.UHEALTH]<=0)continue;
    if(state[p+SGENERATION]!==u[at+U.UGENERATION]){state.fill(0,p,p+SERVICE_WORDS);state[p+SGENERATION]=u[at+U.UGENERATION];}
    const enter=u[at+U.UENTER];
    if(enter<0&&state[p+SMODE]===0){state[p+SFACILITY]=-enter;state[p+SMODE]=10;state[p+STIMER]=0;}
    if(enter>0&&u[(enter-1)*U.WORDS+U.UTYPE]===movementType('FIX')&&state[p+SFACILITY]!==enter){
      let busy=false;for(let other=0;other<count;other++)if(other!==id&&u[other*U.WORDS+U.UHEALTH]>0&&state[SERVICE_BASE+other*SERVICE_WORDS+SFACILITY]===enter)busy=true;
      if(busy){u[at+U.UENTER]=0;continue;}
      state[p+SFACILITY]=enter;state[p+SMODE]=1;state[p+STIMER]=0;
      if(u[at+U.UDOMAIN]===0){
        const center=u[(enter-1)*U.WORDS+U.UCELL],exits=[5,0,1,2,3,4,6,7].map(i=>center+REPAIR_EXITS[i][1]*width+REPAIR_EXITS[i][0]);
        state[p+SEXIT]=exits.find(cell=>clear(cell,id))??center+width-1;
        m.goals[id]=state[p+SEXIT];m.pathGoals[id]=-1;
      }
    }
    const parent=state[p+SFACILITY]-1;if(parent<0)continue;
    const b=parent*U.WORDS,name=MOVEMENT[u[b+U.UTYPE]].name;
    if(u[b+U.UHEALTH]<=0||!c[parent*C.CWORDS+C.CACTIVE]){state[p+SFACILITY]=state[p+SMODE]=0;u[at+U.UENTER]=0;continue;}
    const mode=state[p+SMODE];
    if(mode===10){
      // MISSION.CPP Commence: a queued unload starts after the previous CLOSE mission.
      if(name==='WEAP'&&Array.from({length:count},(_,other)=>other).some(other=>other!==id&&u[other*U.WORDS+U.UHEALTH]>0&&state[SERVICE_BASE+other*SERVICE_WORDS+SFACILITY]===parent+1&&state[SERVICE_BASE+other*SERVICE_WORDS+SMODE]===12))continue;
      state[p+STIMER]++;
      if(name==='WEAP'){
        u[b+U.UDOOR]=Math.min(10,Math.trunc(state[p+STIMER]/2));
        const exit=u[b+U.UCELL]+width-1;
        if(state[p+STIMER]>=28&&Array.from(m.occupancy.subarray(exit*5,exit*5+5)).every(owner=>!owner||owner===id+1||owner===parent+1)){
          force(id,66,exit);if(!(u[at+U.UFLAGS]&U.PLAYER_ORDER))c[id*C.CWORDS+C.CMISSION]=C.MOVE;state[p+SMODE]=11;
        }
      }else if(name==='PROC'){force(id,65,u[b+U.UCELL]+width-1);state[p+SMODE]=11;}
      else{
        const exit=FACTORY_EXITS[name]?.map(([x,y])=>u[b+U.UORIGIN]+y*width+x).find(cell=>clear(cell,id,true));
        if(exit!==undefined){
          // BUILDING.CPP Exit_Object assigns a destination; Start_Driver reserves a free infantry spot.
          let first=infantryStep(exit,id)?exit:-1,best=0x7fffffff;
          if(first<0)for(const [dx,dy] of [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]]){
            const x=u[at+U.UCELL]%width+dx,y=Math.trunc(u[at+U.UCELL]/width)+dy,cell=y*width+x;
            if(x<0||x>=width||y<0||y>=battle.setup.grid.height||!infantryStep(cell,id))continue;
            const score=distance(...m.point(cell),...m.point(exit));if(score<best){first=cell;best=score;}
          }
          if(first>=0){m.goals[id]=first;m.pathGoals[id]=U.DIRECT_STEP;c[id*C.CWORDS+C.CMISSION]=C.MOVE;state[p+SEXIT]=exit;state[p+SMODE]=11;}
        }
      }
    }else if(mode===11&&u[at+U.UDEST]<0&&(name==='WEAP'||name==='PROC'||m.goals[id]<0||(u[at+U.UFLAGS]&U.PLAYER_ORDER))){
      if(name==='WEAP'&&!battle.setup.passable?.[u[at+U.UCELL]]){
        const exit=FACTORY_EXITS.WEAP.map(([x,y])=>u[b+U.UORIGIN]+y*width+x).find(cell=>clear(cell,id)&&Math.abs(cell%width-u[at+U.UCELL]%width)<=1&&Math.abs(Math.trunc(cell/width)-Math.trunc(u[at+U.UCELL]/width))<=1);
        if(exit!==undefined){const dx=exit%width-u[at+U.UCELL]%width,dy=Math.trunc(exit/width)-Math.trunc(u[at+U.UCELL]/width),dir=dy<0?(dx<0?7:dx>0?1:0):dy>0?(dx<0?5:dx>0?3:4):dx<0?6:2;force(id,dir*9,exit);}
      }else if((name==='PYLE'||name==='HAND')&&!(u[at+U.UFLAGS]&U.PLAYER_ORDER)&&u[at+U.UCELL]!==state[p+SEXIT]){m.goals[id]=state[p+SEXIT];m.pathGoals[id]=-1;
      }else{
        // EVENT.CPP MEGAMISSION replaces NavCom; Per_Cell_Process releases the
        // exit contact on arrival rather than restoring the old factory destination.
        if(name==='WEAP'&&m.goals[id]<0&&!(u[at+U.UFLAGS]&U.PLAYER_ORDER))scatterFromExit(id);
        u[at+U.UENTER]=0;state[p+SMODE]=name==='WEAP'?12:0;state[p+STIMER]=0;if(name!=='WEAP')state[p+SFACILITY]=0;
      }
    }else if(mode===12){if(++state[p+STIMER]%2===0)u[b+U.UDOOR]=Math.max(0,u[b+U.UDOOR]-1);if(!u[b+U.UDOOR])state[p+SFACILITY]=state[p+SMODE]=0;
    }else if(mode===1){
      if(u[at+U.UDOMAIN]===1){if(!u[at+U.UALTITUDE]&&m.goals[id]<0&&u[at+U.UCELL]===u[b+U.UCELL]){state[p+SMODE]=3;state[p+STIMER]=3;}}
      else if(m.goals[id]<0&&u[at+U.UDEST]<0&&u[at+U.UCELL]===state[p+SEXIT]){toward(id,u[b+U.UCELL]);state[p+SMODE]=2;}
    }else if(mode===2&&u[at+U.UDEST]<0){
      if(u[at+U.UCELL]!==u[b+U.UCELL])toward(id,u[b+U.UCELL]);else{state[p+SMODE]=3;state[p+STIMER]=3;}
    }else if(mode===3){
      if(m.goals[id]>=0){
        if(u[at+U.UDOMAIN]===0){
          const center=u[at+U.UCELL],facing=((u[at+U.UFACE]+16)&255)>>5,exits=[facing,0,1,2,3,4,5,6,7].map(i=>center+REPAIR_EXITS[i][1]*width+REPAIR_EXITS[i][0]);
          const exit=exits.find(cell=>clear(cell,id));if(exit===undefined)continue;
          state[p+SEXIT]=exit;state[p+SMODE]=4;toward(id,exit);
        }else{state[p+SFACILITY]=state[p+SMODE]=0;u[at+U.UENTER]=0;}
        u[b+U.UDOOR]=0;continue;
      }
      if(--state[p+STIMER]>0)continue;
      state[p+STIMER]=14;
      const [cost,step,max]=SERVICE_TYPES[u[at+U.UTYPE]],owner=u[at+U.UOWNER];
      if(u[at+U.UHEALTH]<max&&money[owner]>=cost){money[owner]-=cost;state[owner]+=cost;u[at+U.UHEALTH]=Math.min(max,u[at+U.UHEALTH]+step);u[b+U.UDOOR]=1;state[p+SACTIVE]=1;}
      else{u[b+U.UDOOR]=0;state[p+SACTIVE]=0;}
    }else if(mode===4&&u[at+U.UDEST]<0){
      if(u[at+U.UCELL]!==state[p+SEXIT])toward(id,state[p+SEXIT]);else{state[p+SFACILITY]=state[p+SMODE]=0;u[at+U.UENTER]=0;}
    }
  }
  m.occupy();
}
