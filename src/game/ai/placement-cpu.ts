// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { distance } from '../coord.ts';
import { MOVEMENT } from '../data/movement.ts';
import { combatTypes,weapons } from '../data/combat.ts';
import { placementOffsets } from '../simulation/building-rules.ts';
import type { CpuCombat } from '../simulation/combat-cpu.ts';
import * as U from '../simulation/units-state.ts';
import * as C from '../simulation/combat-state.ts';
import { areAllied } from '../simulation/alliances.ts';

/** TECHNO.CPP Base_Is_Attacked / FOOT.CPP Rescue_Mission. CPU oracle may scan all actors. */
export function respondToBaseAttack(battle:CpuCombat,owner:number,enemy:number,cooldown:Int32Array){
  const m=battle.movement,u=battle.units,c=battle.state,at=enemy*U.WORDS,type=MOVEMENT[u[at+U.UTYPE]];
  if(enemy<0||areAllied(battle.setup,owner,u[at+U.UOWNER])||u[at+U.UHEALTH]<=0||u[at+U.UDOMAIN]!==0||type.name==='BOAT'||type.name==='LST'||cooldown[enemy]>battle.frame)return;
  if(battle.setup.multiplayer===false)c[enemy*C.CWORDS+C.CPANIC_FRAME]=battle.frame+1;
  let desired=combatTypes[u[at+U.UTYPE]].risk*2,total=0;
  const defenders:{id:number;score:number}[]=[];
  for(const infantry of [1,0])for(let id=0;id<battle.setup.units.length&&desired>0;id++){
    const p=id*U.WORDS,s=id*C.CWORDS,t=combatTypes[u[p+U.UTYPE]],moving=MOVEMENT[u[p+U.UTYPE]];
    if(u[p+U.UOWNER]!==owner||u[p+U.UHEALTH]<=0||u[p+U.UATTACHED]||u[p+U.UDOMAIN]!==0||u[p+U.UKIND]!==infantry||[C.STICKY,C.SLEEP].includes(c[s+C.CMISSION]))continue;
    const target=c[s+C.CTARGET];
    if(target===enemy){desired-=t.risk;continue;}
    if(target>=0&&combatTypes[u[target*U.WORDS+U.UTYPE]].primary>=0||!t.risk||moving.name==='HARV')continue;
    const d=distance(u[p],u[p+1],u[at],u[at+1])-(weapons[t.primary]?.range??0);
    const score=d>0?Math.max(1,Math.trunc(t.risk*256/Math.max(1,Math.trunc(d/Math.max(1,moving.speed))))):t.risk*256;
    // The original value[count] read is out of bounds. Keep the intended six highest scores deterministically.
    let index=defenders.findIndex(entry=>entry.score<score);if(index<0)index=defenders.length;
    if(index<6){defenders.splice(index,0,{id,score});defenders.length=Math.min(6,defenders.length);}
  }
  if(desired>0)for(const {id} of defenders){
    const s=id*C.CWORDS;c[s+C.CMISSION]=C.ATTACK;c[s+C.CTARGET]=enemy;c[s+C.CSCAN]=0;c[s+C.CLOCAL_ROUTE]=0;c[s+C.CROUTE_LENGTH]=0;
    c[s+C.CSUSPENDED_MISSION]=0;u[id*U.WORDS+U.UOBSTRUCTION]=0;
    m.goals[id]=m.pathGoals[id]=-1;total+=combatTypes[u[id*U.WORDS+U.UTYPE]].risk;if(total>desired)break;
  }
  if(total>desired)cooldown[enemy]=battle.frame+225;
}

/** BUILDING.CPP Flush_For_Placement. */
export function flushPlacement(battle:CpuCombat,owner:number,name:string,origin:number,cooldown:Int32Array){
  const m=battle.movement,u=battle.units,w=battle.setup.grid.width,h=battle.setup.grid.height;
  for(const [dx,dy] of placementOffsets(name)){
    const x=origin%w+dx,y=Math.trunc(origin/w)+dy;if(x<0||x>=w||y<0||y>=h)continue;
    const cell=y*w+x;let first=-1;
    for(let slot=0;slot<5;slot++){const id=m.occupancy[cell*5+slot]-1;if(id>=0){first=id;break;}}
    if(first<0)continue;
    if(u[first*U.WORDS+U.UOWNER]!==owner)respondToBaseAttack(battle,owner,first,cooldown);
    else{
      const seen=new Set<number>();
      for(let slot=0;slot<5;slot++){
        const id=m.occupancy[cell*5+slot]-1;if(id<0||seen.has(id))continue;seen.add(id);
        if(u[id*U.WORDS+U.UDOMAIN]===0&&u[id*U.WORDS+U.UATTACHED]===0)m.scatter(id);
      }
    }
  }
}
