import type { CpuCombat } from './combat-cpu.ts';
import { placementOffsets } from './building-rules.ts';
import { MOVEMENT } from '../data/movement.ts';
import { CHANGE_WORDS,CREATE,HEALTH,REMOVE,DESTINATION,TARGET,AMMO,FACING,STATUS,NEARBY,INITIAL_ORDER } from './lifecycle-state.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
import { FACTORY_POINT,FACTORY_EXITS } from './services-cpu.ts';
import { randomWord } from '../../engine/simulation/fixed.ts';
import { AIR_WORDS,ACONTACT,AGENERATION } from './aircraft-cpu.ts';

/** CPU reference for recorded construction commands, including stable-ID exit contention. */
export function applyLifecycle(battle:CpuCombat,commands:Int32Array,placementClear:ArrayLike<number>=battle.setup.passable??battle.setup.grid.edges,aircraft?:Int32Array){
  const {units:u,state:s,movement:m}=battle,width=battle.setup.grid.width;
  for(let id=0;id<battle.setup.units.length;id++){
    const p=id*CHANGE_WORDS,mask=commands[p],at=id*U.WORDS,c=id*C.CWORDS;
    if(mask&REMOVE){u[at+U.UHEALTH]=0;m.goals[id]=-1;s[c+C.CDEATH]=-1;}
    if(mask&CREATE){
      const type=MOVEMENT[commands[p+1]],domain=type.domain??0,ignore=commands[p+9];let cell=commands[p+3];
      let free=true,slot=-1;
      if(commands[p+12]<0){
        const parent=(-commands[p+12]-1)*U.WORDS,name=MOVEMENT[u[parent+U.UTYPE]].name;
        if(name==='PYLE'||name==='HAND')free=FACTORY_EXITS[name].some(([x,y])=>{
          const exit=u[parent+U.UORIGIN]+y*width+x;
          return exit>=0&&exit<battle.setup.grid.edges.length&&!!battle.setup.passable?.[exit]&&m.occupancy.subarray(exit*5,exit*5+5).some(owner=>owner===0);
        });
      }
      if(mask&NEARBY){
        const unoccupied=(target:number)=>target>=0&&target<battle.setup.grid.edges.length&&m.occupancy.subarray(target*5,target*5+5).every(owner=>owner===0||owner===id+1);
        if(!unoccupied(cell)){
          const center=u[ignore*U.WORDS+U.UCELL];let found=-1;
          const visit=(x:number,y:number)=>{const xx=center%width+x,yy=Math.trunc(center/width)+y,target=center+x+y*width;if(xx>=0&&xx<width&&yy>=0&&yy<battle.setup.grid.height&&placementClear[target]&&unoccupied(target))found=target;};
          for(let r=0;r<32&&found<0;r++){for(let x=-r;x<=r;x++){visit(x,-r);visit(x,r);}for(let y=1-r;y<r;y++){visit(-r,y);visit(r,y);}}
          if(found<0)free=false;else cell=found;
        }
      }
      if(domain!==1&&!commands[p+11])for(const [dx,dy] of domain===2?placementOffsets(type.name):[[0,0]]){
        const x=cell%width+dx,y=Math.trunc(cell/width)+dy,target=y*width+x;
        if(x<0||x>=width||y<0||y>=battle.setup.grid.height){free=false;continue;}
        let spots=0;
        for(let j=0;j<5;j++){const owner=m.occupancy[target*5+j]-1;if(owner<0||owner===ignore||owner===id){spots++;if(slot<0)slot=j;}}
        if(!type.infantry&&spots<5||!spots)free=false;
      }
      if(free){
        const generation=u[at+U.UGENERATION]+1;
        const one={...battle.setup,units:[{type:commands[p+1],cell,owner:commands[p+2],health:commands[p+4],facing:commands[p+5],altitude:commands[p+6],slot:type.infantry&&slot>=0?slot:0,attached:commands[p+11],enter:commands[p+12]}]};
        u.set(U.initialUnits(one),at);s.set(C.initialCombat(one),c);u[at+U.UGENERATION]=generation;
        if(domain===1&&commands[p+12]>0){const parent=(commands[p+12]-1)*U.WORDS,origin=u[parent+U.UORIGIN];if(MOVEMENT[u[parent+U.UTYPE]].name==='HPAD'){u[at]=origin%width*256+256;u[at+1]=Math.trunc(origin/width)*256+192;u[at+U.UCELL]=origin+1;}}
        if(commands[p+12]<0){const parent=(-commands[p+12]-1)*U.WORDS,origin=u[parent+U.UORIGIN],point=FACTORY_POINT[MOVEMENT[u[parent+U.UTYPE]].name];if(point){u[at]=origin%width*256+point[0];u[at+1]=Math.trunc(origin/width)*256+point[1];u[at+U.UCELL]=origin+Math.trunc(point[1]/256)*width+Math.trunc(point[0]/256);}}
        s[c+C.CSEEN]=1;s[c+C.CMISSION]=commands[p+8];s[c+C.CARM]=mask&STATUS?0:commands[p+10];
        m.goals[id]=m.pathGoals[id]=-1;
        if(mask&INITIAL_ORDER){m.goals[id]=commands[p+13];s[c+C.CTARGET]=commands[p+14];}
        if(domain===1&&commands[p+12]>0){
          const parent=(commands[p+12]-1)*U.WORDS,origin=u[parent+U.UORIGIN];
          if(MOVEMENT[u[parent+U.UTYPE]].name==='HPAD'&&battle.setup.units.some((_,other)=>other!==id&&u[other*U.WORDS+U.UDOMAIN]===1&&u[other*U.WORDS+U.UHEALTH]>0&&
            (u[other*U.WORDS+U.UCELL]===origin+1||aircraft&&aircraft[other*AIR_WORDS+AGENERATION]===u[other*U.WORDS+U.UGENERATION]&&aircraft[other*AIR_WORDS+ACONTACT]===commands[p+12]-1))){
            const bounds=battle.setup.bounds??{x:1,y:0,width:width-2,height:battle.setup.grid.height};
            const edge=origin%width-bounds.x<Math.trunc(bounds.width/2)?bounds.x-1:bounds.x+bounds.width;
            const y=bounds.y+randomWord(battle.setup.seed,battle.frame,id,197)%bounds.height;
            u[at]=edge*256+128;u[at+1]=y*256+128;u[at+U.UCELL]=y*width+edge;u[at+U.UALTITUDE]=24;u[at+U.UENTER]=0;
            u[at+U.UFACE]=u[at+U.UDESIRED]=s[c+C.CTURRET]=0;
            const center=u[parent+U.UCELL];let found=-1;
            const visit=(x:number,y:number)=>{const xx=center%width+x,yy=Math.trunc(center/width)+y,cell=yy*width+xx;if(xx>=bounds.x&&xx<bounds.x+bounds.width&&yy>=bounds.y&&yy<bounds.y+bounds.height&&placementClear[cell]&&m.occupancy.subarray(cell*5,cell*5+5).every(owner=>owner===0))found=cell;};
            for(let r=0;r<32&&found<0;r++){for(let x=-r;x<=r;x++){visit(x,-r);visit(x,r);}for(let y=1-r;y<r;y++){visit(-r,y);visit(r,y);}}
            m.goals[id]=found;s[c+C.CMISSION]=C.MOVE;
          }
        }
        if(domain!==1&&!commands[p+11])for(let j=0;j<5;j++)if(!type.infantry||j===slot)m.occupancy[cell*5+j]=id+1;
      }
    }
    if(mask&HEALTH)u[at+U.UHEALTH]=commands[p+4];
    if(mask&FACING)u[at+U.UDESIRED]=commands[p+5];
    if(mask&STATUS){s[c+C.CPOWER]=commands[p+10]&65535;s[c+C.CACTIVE]=commands[p+10]>>16;}
    if(mask&AMMO)s[c+C.CAMMO]=commands[p+7];
    if(mask&DESTINATION){m.goals[id]=commands[p+7];m.pathGoals[id]=-1;s[c+C.CMISSION]=C.MOVE;}
    if(mask&TARGET){s[c+C.CTARGET]=commands[p+7];s[c+C.CMISSION]=C.ATTACK;s[c+C.CSCAN]=0;}
  }
  m.occupy();
}
