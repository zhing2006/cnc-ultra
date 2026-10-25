// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { randomWord } from '../../engine/simulation/fixed.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { SCANNER_BUILDINGS } from '../data/abilities.ts';
import type { CpuCombat } from './combat-cpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';

/** TECHNO.CPP Do_Uncloak, also called by DRIVE.CPP Overrun_Square. */
export function uncloakUnit(units:Int32Array,id:number,frame:number){
  const at=id*U.WORDS;
  if(units[at+U.UCLOAK]!==1&&units[at+U.UCLOAK]!==2)return;
  units[at+U.UCLOAK]=3;units[at+U.UCLOAK_STAGE]=0;units[at+U.UCLOAK_WAIT]=0;
  units[at+U.UCLOAK_EVENT]=(Math.trunc(units[at+U.UCLOAK_EVENT]/8)===frame?units[at+U.UCLOAK_EVENT]:frame*8)|6;
}

/** Ported from TECHNO.CPP, AI / Do_Cloak / Do_Uncloak / Visual_Character. */
export function advanceCloak(battle:CpuCombat){
  const u=battle.units,c=battle.state;
  for(let id=0;id<battle.setup.units.length;id++){
    const at=id*U.WORDS;
    if(u[at+U.UTYPE]!==movementType('STNK')||u[at+U.UHEALTH]<=0||u[at+U.UATTACHED])continue;
    const mode=u[at+U.UCLOAK],health=Math.trunc(u[at+U.UHEALTH]*256/MOVEMENT[u[at+U.UTYPE]].strength);
    if(mode===0){
      if(u[at+U.UCLOAK_WAIT]>0&&--u[at+U.UCLOAK_WAIT]===0)u[at+U.UCLOAK_STAGE]++;
      if(!c[id*C.CWORDS+C.CARM]&&u[at+U.UCLOAK_STAGE]&&(health>64||randomWord(battle.setup.seed,battle.frame+1,id,460)%26===1)){
        u[at+U.UCLOAK]=1;u[at+U.UCLOAK_STAGE]=0;u[at+U.UCLOAK_EVENT]=(battle.frame+1)*8+3;
      }
    }else if(mode===1||mode===3){
      const stage=++u[at+U.UCLOAK_STAGE];
      if(mode===3&&stage>=38){u[at+U.UCLOAK]=0;u[at+U.UCLOAK_STAGE]=0;u[at+U.UCLOAK_WAIT]=15;}
      if(mode===1){
        const visual=Math.trunc(stage*256/38);
        if(visual>=64&&visual<128&&health<64&&randomWord(battle.setup.seed,battle.frame+1,id,461)%3===0)u[at+U.UCLOAK]=3;
        else if(stage>=38){u[at+U.UCLOAK]=2;u[at+U.UCLOAK_EVENT]=(battle.frame+1)*8+1;if(u[at+U.UOWNER]!==battle.humanOwner)battle.movement.scatter(id);}
      }
    }
  }
}

/** FOOT.CPP Per_Cell_Process and the FIRE_CLOAKED branch of UNIT.CPP AI. */
export function cloakContacts(battle:CpuCombat,inRange:(id:number,target:number)=>boolean){
  const u=battle.units,c=battle.state,w=battle.setup.grid.width,h=battle.setup.grid.height;
  for(let id=0;id<battle.setup.units.length;id++){
    const at=id*U.WORDS;
    if(u[at+U.UTYPE]!==movementType('STNK')||u[at+U.UHEALTH]<=0||u[at+U.UATTACHED])continue;
    if(u[at+U.UCLOAK]===2&&u[at+U.UOVERRUN_CELL]>=0){
      const cell=u[at+U.UOVERRUN_CELL];
      for(const [dx,dy] of [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]]){
        const x=cell%w+dx,y=Math.trunc(cell/w)+dy;if(x<0||x>=w||y<0||y>=h)continue;
        for(let slot=0;slot<5;slot++){
          const other=battle.movement.occupancy[(y*w+x)*5+slot]-1,b=other*U.WORDS;
          if(other>=0&&u[b+U.UHEALTH]>0&&u[b+U.UOWNER]!==u[at+U.UOWNER]&&(u[b+U.UKIND]||SCANNER_BUILDINGS.has(MOVEMENT[u[b+U.UTYPE]].name))){u[at+U.UCLOAK]=1;u[at+U.UCLOAK_STAGE]=19;}
        }
      }
    }
    const target=c[id*C.CWORDS+C.CTARGET];
    if((u[at+U.UCLOAK]===1||u[at+U.UCLOAK]===2)&&target!==-1&&c[id*C.CWORDS+C.CARM]===0&&c[id*C.CWORDS+C.CAMMO]!==0&&inRange(id,target)){
      uncloakUnit(u,id,battle.frame);
    }
  }
}
