// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { MOVEMENT,GROUND_SPEED,movementType } from '../data/movement.ts';
import { distance,desiredFacing256,movePoint } from '../coord.ts';
import { randomWord } from '../../engine/simulation/fixed.ts';
import { rotateFacing } from './units-cpu.ts';
import { AIR_WORDS,AACCUM,AFACING,ADESIRED,ASPEED,AGENERATION,ARETREAT,AGOAL,initialAircraft } from './aircraft-cpu.ts';
import type { CpuCombat } from './combat-cpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
import { CIVILIAN_INFANTRY } from '../data/abilities.ts';

export const TBASE=6,TWORDS=16,TMODE=0,TTIMER=1,TLAST=2,TGEN=3,TORDER=4,TRESERVED=5,TCONTACT=6,TLOCKED=7;
/** TEAM.CPP Coordinate_Unload carries a destination; the player's unload command does not. */
export const SCRIPT_UNLOAD=9;
export const APC_LOAD_FACING=[128,160,224,224,32,32,32,96];
export const LOAD_DIRECTIONS=[4,4,5,3,6,2,7,1];
export const UNLOAD_DIRECTIONS=[4,5,3,7,1,0,6,2];
export const TRANSPORT_DIRECTIONS=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]] as const;
export const AIRSTRIP_EXITS=[[-1,-1],[-1,0],[-1,1],[-1,2],[0,-1],[0,2],[1,-1],[1,2],[2,-1],[2,2],[3,-1],[3,2],[4,-1],[4,0],[4,1],[4,2]] as const;
export function initialTransport(count:number){return new Int32Array(TBASE+count*TWORDS);}

/** AIRCRAFT.CPP Receive_Message/Desired_Load_Dir/Exit_Object/Mission_Unload, CARGO.CPP Attach. */
export function stepTransport(battle:CpuCombat,air:Int32Array,t:Int32Array,pending:Int32Array,playable:ArrayLike<number>){
  const u=battle.units,c=battle.state,m=battle.movement,width=battle.setup.grid.width,height=battle.setup.grid.height,count=m.goals.length;
  const bounds=battle.setup.bounds??{x:0,y:0,width,height};
  t[4]=battle.frame+1;
  const clear=(cell:number,id=-1,infantry=false)=>cell>=0&&cell<playable.length&&playable[cell]&&battle.setup.passable?.[cell]&&
    (infantry?Array.from(m.occupancy.subarray(cell*5,cell*5+5)).some(v=>v===0||v===id+1):Array.from(m.occupancy.subarray(cell*5,cell*5+5)).every(v=>v===0||v===id+1));
  const adjacent=(cell:number,dir:number)=>{const [x,y]=TRANSPORT_DIRECTIONS[dir],xx=cell%width+x,yy=Math.trunc(cell/width)+y;return xx<0||xx>=width||yy<0||yy>=height?-1:yy*width+xx;};
  const cargo=(id:number)=>Array.from({length:count},(_,i)=>i).filter(i=>u[i*U.WORDS+U.UHEALTH]>0&&u[i*U.WORDS+U.UATTACHED]===id+1);
  // Ported from UNIT.CPP, Desired_Load_Dir and APC_Open_Door/APC_Close_Door.
  const apcClear=(cell:number,id:number)=>clear(cell,id,true)&&GROUND_SPEED[battle.setup.land[cell]][0]!==0&&
    Array.from(m.occupancy.subarray(cell*5,cell*5+5)).every(v=>!v||u[(v-1)*U.WORDS+U.UOWNER]===u[id*U.WORDS+U.UOWNER]);
  const apcDirection=(id:number,passenger=-1)=>{
    const at=id*U.WORDS,faceto=passenger<0?(u[at+U.UFACE]+128)&255:desiredFacing256(u[at],u[at+1],u[passenger*U.WORDS],u[passenger*U.WORDS+1]);
    let best=-1,direction=-1;
    for(let d=0;d<8;d++){
      const cell=adjacent(u[at+U.UCELL],d),allowed=passenger>=0&&cell===u[passenger*U.WORDS+U.UCELL]||apcClear(cell,passenger<0?id:passenger);
      const value=(allowed?128:-128)-Math.abs(((d*32-faceto+128)&255)-128)+(d===4?-100:d===3||d===5?64:0);
      if(best===-1||value>best){best=value;direction=d;}
    }
    return best>0?direction:-1;
  };
  const apcDoor=(id:number,open:boolean)=>{
    const at=id*U.WORDS,p=TBASE+id*TWORDS,door=u[at+U.UDOOR];
    if(open&&(door===0||door===5)){u[at+U.UDOOR]=1;t[p+TRESERVED]=0;}
    else if(!open&&(door===1||door===4)){u[at+U.UDOOR]=5;t[p+TRESERVED]=0;}
  };
  for(let id=0;id<count;id++){
    const at=id*U.WORDS,p=TBASE+id*TWORDS;
    if(t[p+TGEN]!==u[at+U.UGENERATION]){t.fill(0,p,p+TWORDS);t[p+TGEN]=u[at+U.UGENERATION];t[p+TLAST]=-1;}
    const contact=t[p+TCONTACT]-1;
    if(contact>=0&&(u[contact*U.WORDS+U.UHEALTH]<=0||u[contact*U.WORDS+U.UENTER]!==id+1||pending[contact*2]===0||pending[contact*2]===1))t[p+TCONTACT]=0;
  }
  for(let id=0;id<count;id++){
    const at=id*U.WORDS,p=TBASE+id*TWORDS;
    const parent=u[at+U.UATTACHED]-1;
    if(parent>=0&&u[parent*U.WORDS+U.UHEALTH]<=0){u[at+U.UHEALTH]=0;u[at+U.UATTACHED]=0;}
    if(u[at+U.UHEALTH]<=0)continue;
    const command=pending[id*2];
    if(command===0||command===1){u[at+U.UENTER]=0;if(t[p+TMODE]===5||u[at+U.UTYPE]===movementType('APC'))t[p+TMODE]=0;}
    if(command===5){if(u[at+U.UKIND])t[p+TLAST]=-1;u[at+U.UENTER]=pending[id*2+1]+1;pending[id*2]=-1;c[id*C.CWORDS+C.CTARGET]=-1;c[id*C.CWORDS+C.CMISSION]=C.MOVE;}
    if((command===6||command===SCRIPT_UNLOAD)&&(u[at+U.UTYPE]===movementType('TRAN')||u[at+U.UTYPE]===movementType('APC'))){
      t[p+TMODE]=1;t[p+TTIMER]=0;pending[id*2]=-1;
      if(u[at+U.UTYPE]===movementType('APC')){m.goals[id]=m.pathGoals[id]=-1;c[id*C.CWORDS+C.CTARGET]=-1;c[id*C.CWORDS+C.CMISSION]=C.GUARD;}
      else if(command===SCRIPT_UNLOAD&&pending[id*2+1]>=0){m.goals[id]=pending[id*2+1];c[id*C.CWORDS+C.CMISSION]=C.MOVE;}
      else if(u[at+U.UALTITUDE]>0)m.goals[id]=u[at+U.UCELL];
    }
    const target=u[at+U.UENTER]-1;
    if(target>=0&&u[at+U.UKIND]&&!u[at+U.UATTACHED]){
      const b=target*U.WORDS;
      const contact=TBASE+target*TWORDS+TCONTACT;
      if(u[b+U.UHEALTH]<=0||(u[b+U.UTYPE]!==movementType('TRAN')&&u[b+U.UTYPE]!==movementType('APC'))||u[b+U.UOWNER]!==u[at+U.UOWNER]||cargo(target).length>=5){u[at+U.UENTER]=0;t[p+TMODE]=0;continue;}
      // INFANTRY.CPP Assign_Destination: an occupied radio contact does not stop approach.
      if(t[p+TMODE]!==5&&t[p+TLAST]!==u[b+U.UCELL]){m.goals[id]=u[b+U.UCELL];m.pathGoals[id]=-1;t[p+TLAST]=u[b+U.UCELL];}
      if(t[contact]&&t[contact]!==id+1)continue;
      t[contact]=id+1;
      if(u[b+U.UALTITUDE]||m.goals[target]>=0)continue;
      if(t[p+TMODE]===5){
        if(u[at+U.UDEST]<0&&u[at+U.UCELL]===u[b+U.UCELL]){
          u[at+U.UATTACHED]=target+1;u[at+U.UENTER]=0;m.goals[id]=m.pathGoals[id]=-1;t[p+TORDER]=++t[3];t[p+TMODE]=0;t[contact]=0;if(u[b+U.UTYPE]===movementType('APC')&&cargo(target).length===5)apcDoor(target,false);
          if(u[b+U.UTYPE]===movementType('TRAN')&&CIVILIAN_INFANTRY.has(MOVEMENT[u[at+U.UTYPE]].name)&&!(u[at+U.UFLAGS]&U.TECHNICIAN))t[TBASE+target*TWORDS+TMODE]=4;
        }
        continue;
      }
      const center=u[b+U.UCELL];
      let destination:number|undefined;
      if(u[b+U.UTYPE]===movementType('APC')){
        if(u[b+U.UDEST]>=0||u[b+U.UFACE]!==u[b+U.UDESIRED]||t[TBASE+target*TWORDS+TMODE]!==0)continue;
        const direction=apcDirection(target,id);if(direction<0){u[at+U.UENTER]=0;t[contact]=0;continue;}
        destination=adjacent(center,direction);u[b+U.UDESIRED]=APC_LOAD_FACING[direction];
        apcDoor(target,u[b+U.UFACE]===u[b+U.UDESIRED]);
      }else destination=LOAD_DIRECTIONS.map(d=>adjacent(center,d)).find(cell=>cell===u[at+U.UCELL]||clear(cell,id));
      if(destination===undefined)continue;
      if(destination!==u[at+U.UCELL]){m.goals[id]=destination;m.pathGoals[id]=-1;}
      else if(u[at+U.UDEST]<0&&u[b+U.UDOOR]===4){
        // RADIO_TETHER permits this last step into the transport's occupied cell.
        u[at+U.UDEST]=center;u[at+U.UHEAD_X]=u[b];u[at+U.UHEAD_Y]=u[b+1];u[at+U.UDSLOT]=0;
        u[at+U.UFACE]=u[at+U.UDESIRED]=desiredFacing256(u[at],u[at+1],u[b],u[b+1]);u[at+U.USPEED]=255;
        m.goals[id]=center;m.pathGoals[id]=U.DIRECT_STEP;t[p+TMODE]=5;
      }
    }
    if(u[at+U.UTYPE]===movementType('APC')){
      const passengers=cargo(id),door=u[at+U.UDOOR];
      if(door===1||door===5){
        const rate=door===5||u[at+U.UFACE]===32||u[at+U.UFACE]===224?10:1;
        if(++t[p+TRESERVED]>=rate){u[at+U.UDOOR]=door===1?4:0;t[p+TRESERVED]=0;}
      }
      if(t[p+TMODE]===0){if(!t[p+TCONTACT]||m.goals[id]>=0||u[at+U.UFACE]!==u[at+U.UDESIRED]||passengers.length===5)apcDoor(id,false);continue;}
      // UNIT.CPP Mission_Unload: 15-tick mission polling, one-tick successful transitions.
      if(t[p+TTIMER]>0){t[p+TTIMER]--;continue;}
      t[p+TTIMER]=14;
      switch(t[p+TMODE]){
        case 1:{
          if(u[at+U.UDEST]>=0)break;
          const direction=apcDirection(id);
          if(!passengers.length||direction<0){t[p+TMODE]=0;break;}
          u[at+U.UDESIRED]=APC_LOAD_FACING[direction];apcDoor(id,false);t[p+TMODE]=2;t[p+TTIMER]=0;break;
        }
        case 2:
          if(u[at+U.UFACE]===u[at+U.UDESIRED]&&u[at+U.UDEST]<0){apcDoor(id,true);t[p+TMODE]=3;t[p+TTIMER]=0;}break;
        case 3:
          if(u[at+U.UDOOR]===4){t[p+TMODE]=4;t[p+TTIMER]=0;}break;
        case 4:{
          if(!passengers.length){t[p+TMODE]=6;break;}
          const passenger=passengers.sort((a,b)=>t[TBASE+b*TWORDS+TORDER]-t[TBASE+a*TWORDS+TORDER]||b-a)[0],pp=passenger*U.WORDS;
          let direction=-1,destination=-1;
          // Original DirType addition uses eight successive angles, not eight compass facings.
          for(let d=0;d<8;d++){const face=(u[at+U.UFACE]+128+d)&255,cell=adjacent(u[at+U.UCELL],((face+16)&255)>>5);if(apcClear(cell,passenger)){direction=face;destination=cell;break;}}
          if(direction<0){t[p+TMODE]=6;break;}
          const [x,y]=movePoint(u[at],u[at+1],direction,128);
          u[pp+U.UATTACHED]=0;u[pp]=x;u[pp+1]=y;u[pp+U.UCELL]=Math.trunc(y/256)*width+Math.trunc(x/256);
          u[pp+U.UFACE]=u[pp+U.UDESIRED]=direction;u[pp+U.UDEST]=u[pp+U.UTRACK]=-1;u[pp+U.UENTER]=0;u[pp+U.USLOT]=0;
          m.goals[passenger]=destination;m.pathGoals[passenger]=-1;c[passenger*C.CWORDS+C.CMISSION]=C.MOVE;break;
        }
        case 6:
          apcDoor(id,false);if(u[at+U.UDOOR]===0)t[p+TMODE]=0;break;
      }
      continue;
    }
    if(u[at+U.UTYPE]!==movementType('TRAN'))continue;
    const passengers=cargo(id),boarding=Array.from({length:count},(_,j)=>j).some(j=>u[j*U.WORDS+U.UHEALTH]>0&&u[j*U.WORDS+U.UENTER]===id+1);
    if(u[at+U.UOWNER]!==0&&!u[at+U.UALTITUDE]&&passengers.length&&t[p+TMODE]===0){t[p+TMODE]=1;t[p+TTIMER]=0;}
    const open=!u[at+U.UALTITUDE]&&m.goals[id]<0&&boarding;
    // DOOR.CPP: 0 closed, 1..3 opening, 4 open, 5..7 closing. Each stage lasts five ticks.
    if(open){
      if(u[at+U.UDOOR]===0||u[at+U.UDOOR]>=5){u[at+U.UDOOR]=1;t[p+TRESERVED]=0;}
      else if(u[at+U.UDOOR]<4&&++t[p+TRESERVED]%5===0)u[at+U.UDOOR]++;
    }else if(u[at+U.UDOOR]>0){
      if(u[at+U.UDOOR]<5){u[at+U.UDOOR]=5;t[p+TRESERVED]=0;}
      else if(++t[p+TRESERVED]%5===0)u[at+U.UDOOR]=u[at+U.UDOOR]===7?0:u[at+U.UDOOR]+1;
    }
    if(t[p+TMODE]===1&&!u[at+U.UALTITUDE]&&m.goals[id]<0){t[p+TMODE]=2;t[p+TTIMER]=0;}
    if(t[p+TMODE]===2){
      const last=t[p+TLAST];if(last>=0&&u[last*U.WORDS+U.UHEALTH]>0&&u[last*U.WORDS+U.UCELL]===u[at+U.UCELL])continue;
      if(t[p+TTIMER]<10){t[p+TTIMER]++;continue;}
      if(!passengers.length){t[p+TMODE]=3;t[p+TTIMER]=0;continue;}
      const passenger=passengers.sort((a,b)=>t[TBASE+b*TWORDS+TORDER]-t[TBASE+a*TWORDS+TORDER]||b-a)[0],pp=passenger*U.WORDS;
      const direction=UNLOAD_DIRECTIONS.find(d=>clear(adjacent(u[at+U.UCELL],d),passenger,!!u[pp+U.UKIND]));if(direction===undefined)continue;
      const destination=adjacent(u[at+U.UCELL],direction);
      u[pp+U.UATTACHED]=0;u[pp]=u[at];u[pp+1]=u[at+1];u[pp+U.UCELL]=u[at+U.UCELL];u[pp+U.UFACE]=u[pp+U.UDESIRED]=direction*32;
      u[pp+U.UDEST]=u[pp+U.UTRACK]=-1;u[pp+U.UENTER]=0;m.goals[passenger]=destination;m.pathGoals[passenger]=-1;
      c[passenger*C.CWORDS+C.CMISSION]=u[pp+U.UOWNER]===0?C.MOVE:C.HUNT;t[p+TLAST]=passenger;t[p+TTIMER]=0;
    }else if(t[p+TMODE]===3&&u[at+U.UDOOR]===0){
      t[p+TMODE]=u[at+U.UOWNER]===0&&!(u[at+U.UFLAGS]&U.LOANER)?0:4;
    }
    if(t[p+TMODE]===4){air[id*AIR_WORDS+ARETREAT]=(battle.setup.houseEdges?.[u[at+U.UOWNER]]??64)+1;air[id*AIR_WORDS+AGOAL]=-1;m.goals[id]=-1;}
  }
  // Fixed-wing cargo uses the same integer FLY physics, but never helicopters' stop-and-land mission.
  for(let id=0;id<count;id++){
    const at=id*U.WORDS,p=TBASE+id*TWORDS,a=id*AIR_WORDS;
    if(u[at+U.UHEALTH]<=0||u[at+U.UTYPE]!==movementType('C17'))continue;
    if(air[a+AGENERATION]!==u[at+U.UGENERATION]){air.set(initialAircraft({...battle.setup,units:[{type:u[at+U.UTYPE],cell:u[at+U.UCELL],facing:u[at+U.UFACE]}]}),a);air[a+AGENERATION]=u[at+U.UGENERATION];}
    let factory=u[at+U.UENTER]-1;
    if(t[p+TMODE]===0&&(factory<0||u[factory*U.WORDS+U.UHEALTH]<=0||!c[factory*C.CWORDS+C.CACTIVE])){
      factory=Array.from({length:count},(_,j)=>j).find(j=>u[j*U.WORDS+U.UTYPE]===movementType('AFLD')&&u[j*U.WORDS+U.UOWNER]===u[at+U.UOWNER]&&u[j*U.WORDS+U.UHEALTH]>0&&c[j*C.CWORDS+C.CACTIVE])??-1;
      u[at+U.UENTER]=factory+1;if(factory<0)t[p+TMODE]=1;
    }
    if(t[p+TMODE]===0){
      const origin=u[factory*U.WORDS+U.UORIGIN],x=origin%width*256+192,y=Math.trunc(origin/width)*256+320,d=distance(u[at],u[at+1],x,y);
      if(air[a+AFACING]===air[a+ADESIRED])air[a+ADESIRED]=desiredFacing256(u[at],u[at+1],x,y);
      u[at+U.UALTITUDE]=d>=1536?24:(24*Math.trunc(d*256/1536)+128)>>8;
      if(d<128){
        const passenger=cargo(id)[0];
        if(passenger!==undefined){
          const destination=AIRSTRIP_EXITS.map(([x,y])=>origin+y*width+x).find(cell=>clear(cell,passenger));
          if(destination!==undefined){
            const pp=passenger*U.WORDS;u[pp+U.UATTACHED]=0;u[pp+U.UCELL]=destination;u[pp]=destination%width*256+128;u[pp+1]=Math.trunc(destination/width)*256+128;
            let goal=destination;const start=randomWord(battle.setup.seed,battle.frame+1,passenger,1)%8;
            for(let step=0;step<8;step++){const cell=adjacent(destination,(start+step)&7);if(clear(cell,passenger))goal=cell;}
            m.goals[passenger]=goal;m.pathGoals[passenger]=-1;c[passenger*C.CWORDS+C.CMISSION]=C.MOVE;t[u[at+U.UOWNER]===0?2:5]++;
          }
        }
        t[p+TMODE]=1;t[p+TTIMER]=0;u[at+U.UENTER]=0;
      }
    }else{air[a+ADESIRED]=192;if(u[at+U.UALTITUDE]<24&&t[p+TTIMER]++%3===0)u[at+U.UALTITUDE]++;}
    air[a+AFACING]=rotateFacing(air[a+AFACING],air[a+ADESIRED],5);u[at+U.UFACE]=u[at+U.UDESIRED]=air[a+AFACING];
    air[a+ASPEED]=255;
    const total=air[a+AACCUM]+40,length=total-total%10;air[a+AACCUM]=total%10;
    const [x,y]=movePoint(u[at],u[at+1],air[a+AFACING],length);
    const inMap=x>=bounds.x*256&&y>=bounds.y*256&&x<(bounds.x+bounds.width)*256&&y<(bounds.y+bounds.height)*256;
    if(inMap)t[p+TLOCKED]=1;
    if(x<0||y<0||x>=width*256||y>=height*256||t[p+TLOCKED]&&!inMap){
      for(const passenger of cargo(id)){const pp=passenger*U.WORDS;t[u[at+U.UOWNER]]+=MOVEMENT[u[pp+U.UTYPE]].cost;u[pp+U.UHEALTH]=0;u[pp+U.UATTACHED]=0;}
      u[at+U.UHEALTH]=0;
    }else{u[at]=x;u[at+1]=y;u[at+U.UCELL]=Math.trunc(y/256)*width+Math.trunc(x/256);}
  }
  m.occupy();
}
