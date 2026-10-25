// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { randomWord } from '../../engine/simulation/fixed.ts';
import { desiredFacing256, distance, movePoint } from '../coord.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { rotateFacing, type CpuUnits } from './units-cpu.ts';
import * as U from './units-state.ts';

export const AIR_WORDS=20;
export const ASTAGE=0,ADELAY=1,ASPEED=2,AACCUM=3,AFACING=4,ADESIRED=5,AGOAL=6,ATAKEOFF=7,ALANDING=8;
export const AGENERATION=9,AHOVER=10,ACONTACT=11,AMISSION=12,ASTATUS=13,ATIMER=14,ATARGET=15,ASERVICE=16,AFIRED=17;
/** Retreat heading plus one; zero leaves flight under the normal destination mission. */
export const ARETREAT=18;
export function initialAircraft(setup:U.UnitsSetup) {
  const state=new Int32Array(setup.units.length*AIR_WORDS);
  setup.units.forEach((unit,id)=>{
    const a=id*AIR_WORDS;state[a+AGOAL]=state[a+ACONTACT]=state[a+ATARGET]=state[a+AFIRED]=-1;
    state[a+AFACING]=state[a+ADESIRED]=unit.facing??0;state[a+AGENERATION]=(unit.health??MOVEMENT[unit.type].strength)>0?1:0;
  });
  return state;
}

/** AIRCRAFT.CPP, Mission_Move/Process_Take_Off/Process_Fly_To/Process_Landing/AI; FLY.CPP. */
export class CpuAircraft {
  readonly state:Int32Array;
  private readonly locations:Int32Array;
  private readonly targets:Int32Array;
  constructor(readonly movement:CpuUnits){this.state=initialAircraft(movement.setup);this.locations=new Int32Array(movement.setup.units.length);this.targets=this.locations.slice();}
  private clear(id:number,cell:number) {
    const {setup,units:u,occupancy}=this.movement;
    const contact=this.state[id*AIR_WORDS+ACONTACT];
    if(this.state[id*AIR_WORDS+AHOVER])return true;
    if(cell<0||cell>=setup.grid.width*setup.grid.height||(!(setup.passable??setup.grid.edges)[cell]&&contact<0))return false;
    // AIRCRAFT.CPP, Is_LZ_Clear and Cell_Seems_Ok. Simultaneous requests use stable IDs.
    for(let spot=0;spot<5;spot++)if(occupancy[cell*5+spot]&&occupancy[cell*5+spot]!==id+1&&occupancy[cell*5+spot]!==contact+1)return false;
    for(let other=0;other<setup.units.length;other++)if(other!==id&&u[other*U.WORDS+U.UDOMAIN]===1&&u[other*U.WORDS+U.UHEALTH]>0){
      if(this.locations[other]===cell||other<id&&this.targets[other]===cell)return false;
    }
    return true;
  }
  point(id:number,cell:number):[number,number]{
    const contact=this.state[id*AIR_WORDS+ACONTACT];
    if(contact>=0){const u=this.movement.units,at=contact*U.WORDS,origin=u[at+U.UORIGIN],width=this.movement.setup.grid.width;
      return u[at+U.UTYPE]===movementType('FIX')?[u[at],u[at+1]]:[origin%width*256+256,Math.trunc(origin/width)*256+192];}
    return this.movement.point(cell);
  }
  private landingZone(id:number,target:number) {
    if(this.clear(id,target))return target;
    const {setup,frame}=this.movement,[x,y]=this.movement.point(target);
    for(let radius=0;radius<16;radius++){
      const offset=randomWord(setup.seed,frame+1,id,150+radius)%8;
      for(let facing=0;facing<8;facing++){
        const [xx,yy]=movePoint(x,y,((facing+offset)&7)*32,radius*256);
        if(xx<0||yy<0||xx>=setup.grid.width*256||yy>=setup.grid.height*256)continue;
        const cell=Math.trunc(yy/256)*setup.grid.width+Math.trunc(xx/256);
        if(this.clear(id,cell))return cell;
      }
    }
    return target;
  }
  step() {
    const {units:u,goals,setup}=this.movement,s=this.state;
    for(let id=0;id<setup.units.length;id++){this.locations[id]=u[id*U.WORDS+U.UCELL];this.targets[id]=goals[id];}
    for(let id=0;id<setup.units.length;id++){
      const at=id*U.WORDS,a=id*AIR_WORDS;
      if(u[at+U.UDOMAIN]!==1||u[at+U.UHEALTH]<=0)continue;
      if(s[a+AGENERATION]!==u[at+U.UGENERATION]){
        s.fill(0,a,a+AIR_WORDS);s[a+AGENERATION]=u[at+U.UGENERATION];s[a+AGOAL]=s[a+ACONTACT]=s[a+ATARGET]=s[a+AFIRED]=-1;s[a+AFACING]=s[a+ADESIRED]=u[at+U.UFACE];
      }
      const type=MOVEMENT[u[at+U.UTYPE]];
      if(type.name==='C17')continue;
      let goal=goals[id];
      if(goal<0&&s[a+AGOAL]>=0&&!s[a+AHOVER]&&u[at+U.UALTITUDE]>0){goal=goals[id]=this.landingZone(id,u[at+U.UCELL]);s[a+ACONTACT]=-1;s[a+ATAKEOFF]=0;s[a+ALANDING]=0;}
      if(goal!==s[a+AGOAL]){s[a+AGOAL]=goal;s[a+ASTAGE]=0;s[a+ADELAY]=0;}
      if(s[a+ADELAY]>0)s[a+ADELAY]--;
      if(s[a+ARETREAT]){
        // AIRCRAFT.CPP Mission_Retreat: take off, face the house edge, keep flying.
        const altitude=u[at+U.UALTITUDE];s[a+ALANDING]=0;s[a+ATAKEOFF]=Number(altitude<24);
        s[a+ASPEED]=altitude>=24?255:altitude>=20?64:altitude>=16?32:0;
        if(altitude>=24)s[a+ADESIRED]=u[at+U.UDESIRED]=s[a+ARETREAT]-1;
      }
      if(goal>=0&&s[a+ADELAY]===0){
        s[a+ADELAY]=1;
        const altitude=u[at+U.UALTITUDE];
        if(s[a+ASTAGE]===0){
          if(this.clear(id,goal))s[a+ASTAGE]=1;
          else {goal=goals[id]=this.landingZone(id,goal);s[a+AGOAL]=goal;}
          s[a+ADELAY]=15;
        }else if(s[a+ASTAGE]===1){
          s[a+ALANDING]=0;s[a+ATAKEOFF]=1;
          if(altitude===0)s[a+AFACING]=s[a+ADESIRED]=u[at+U.UFACE];
          if(altitude===12)s[a+ADESIRED]=desiredFacing256(u[at],u[at+1],...this.point(id,goal));
          if(altitude===16){u[at+U.UDESIRED]=s[a+ADESIRED];s[a+ASPEED]=32;}
          if(altitude===20)s[a+ASPEED]=64;
          if(altitude===24){s[a+ASPEED]=255;s[a+ATAKEOFF]=0;s[a+ASTAGE]=2;}
        }else if(s[a+ASTAGE]===2){
          if(!this.clear(id,goal)){goal=goals[id]=this.landingZone(id,goal);s[a+AGOAL]=goal;}
          else {
            const [x,y]=this.point(id,goal),d=distance(u[at],u[at+1],x,y);
            s[a+ADESIRED]=desiredFacing256(u[at],u[at+1],x,y);
            s[a+ASPEED]=Math.max(32,Math.min(255,Math.trunc(Math.min(d,768)/3)));
            if(d<16){s[a+ASPEED]=0;if(s[a+AHOVER]){goals[id]=s[a+AGOAL]=-1;}else s[a+ASTAGE]=3;}
            if(s[a+AHOVER]&&s[a+ATARGET]>=0&&d<512){const target=s[a+ATARGET]*U.WORDS;u[at+U.UDESIRED]=desiredFacing256(u[at],u[at+1],u[target],u[target+1]);}
            else u[at+U.UDESIRED]=d<128?(u[at+U.UTYPE]===movementType('TRAN')?0:32):s[a+ADESIRED];
          }
        }else {
          s[a+ATAKEOFF]=0;s[a+ALANDING]=1;
          if(altitude===12)s[a+ASPEED]=0;
          if(altitude===0){s[a+ALANDING]=0;goals[id]=s[a+AGOAL]=-1;}
        }
      }
      s[a+AFACING]=rotateFacing(s[a+AFACING],s[a+ADESIRED],type.rotation);
      u[at+U.UFACE]=rotateFacing(u[at+U.UFACE],u[at+U.UDESIRED],type.rotation);
      const add=(type.speed*s[a+ASPEED]+128)>>8;
      if(add){
        const total=add+s[a+AACCUM],length=total-total%10;s[a+AACCUM]=total%10;
        const [x,y]=movePoint(u[at],u[at+1],s[a+AFACING],length);
        if(x>=0&&y>=0&&x<setup.grid.width*256&&y<setup.grid.height*256){u[at]=x;u[at+1]=y;}
        const bounds=setup.bounds??{x:0,y:0,width:setup.grid.width,height:setup.grid.height};
        if(s[a+ARETREAT]&&(x<bounds.x*256||y<bounds.y*256||x>=(bounds.x+bounds.width)*256||y>=(bounds.y+bounds.height)*256))u[at+U.UHEALTH]=0;
      }
      const wasHigh=u[at+U.UALTITUDE]>=16;
      if(!u[at+U.UDOOR]){
        if(s[a+ALANDING]){u[at+U.UALTITUDE]=Math.max(0,u[at+U.UALTITUDE]-1);if(!u[at+U.UALTITUDE]){s[a+ALANDING]=0;s[a+ASPEED]=0;}}
        if(s[a+ATAKEOFF]){u[at+U.UALTITUDE]=Math.min(24,u[at+U.UALTITUDE]+1);if(u[at+U.UALTITUDE]===24)s[a+ATAKEOFF]=0;}
      }
      u[at+U.UCELL]=Math.trunc(u[at+1]/256)*setup.grid.width+Math.trunc(u[at]/256);
      if(wasHigh&&u[at+U.UALTITUDE]<16&&!this.clear(id,u[at+U.UCELL])){
        u[at+U.UALTITUDE]++;s[a+ALANDING]=0;s[a+ATAKEOFF]=1;s[a+ASTAGE]=1;
        goals[id]=s[a+AGOAL]=this.landingZone(id,goal>=0?goal:u[at+U.UCELL]);
      }
    }
    this.movement.occupy();
  }
}
