import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { Fn, If, int, ivec2, instanceIndex, storage } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { desiredFacing256, distance, movePoint } from '../coord.ts';
import { movementType } from '../data/movement.ts';
import { combatTypes } from '../data/combat.ts';
import { areAllied, alliedOwners } from '../simulation/alliances.ts';
import { intMax } from '../../engine/simulation/integer-nodes.ts';
import type { CpuCombat } from '../simulation/combat-cpu.ts';
import type { GpuCombat } from '../simulation/combat-gpu.ts';
import { rotateFacing } from '../simulation/units-cpu.ts';
import { unitDirection, unitDistance, unitRotate } from '../simulation/units-nodes.ts';
import * as U from '../simulation/units-state.ts';
import * as C from '../simulation/combat-state.ts';

const STRIDE = 4;
/** AIRCRAFT.CPP Mission_Hunt/Mission_Retreat, including Fire_At after the last refill check. */
export function stepBombers(battle: CpuCombat, state: Int32Array) {
  const u=battle.units,c=battle.state,width=battle.setup.grid.width,bounds=battle.setup.bounds!,tick=battle.frame+1;
  for(let id=0;id<battle.setup.units.length;id++){
    const at=id*U.WORDS,p=id*STRIDE,s=id*C.CWORDS;
    if(u[at+U.UTYPE]!==movementType('A10')||u[at+U.UHEALTH]<=0)continue;
    if(state[p]!==u[at+U.UGENERATION])state.set([u[at+U.UGENERATION],0,3,0],p);
    c[s+C.CACTIVE]=0;u[at+U.UALTITUDE]=24;
    let target=c[s+C.CTARGET];
    if(target>=0&&u[target*U.WORDS+U.UHEALTH]<=0)target=-1;
    if(target===-1&&state[p+1]!==3){
      let score=-1;
      for(let other=0;other<battle.setup.units.length;other++){
        const a=other*U.WORDS,type=combatTypes[u[a+U.UTYPE]];
        if(u[a+U.UHEALTH]<=0||u[a+U.UATTACHED]||u[a+U.UCLOAK]===2||u[a+U.UDOMAIN]===1&&u[a+U.UALTITUDE]>0||!c[other*C.CWORDS+C.CSEEN]||!type.targetable||areAllied(battle.setup,u[at+U.UOWNER],u[a+U.UOWNER]))continue;
        const raw=type.risk+type.reward,value=Math.max(raw?2:0,Math.trunc((raw+c[other*C.CWORDS+C.CKILLS])/Math.max(1,distance(u[at],u[at+1],u[a],u[a+1]))));
        if(value>score){score=value;target=other;}
      }
      c[s+C.CTARGET]=target;
    }
    const cell=-target-2,tx=target>=0?u[target*U.WORDS]:cell%width*256+128,ty=target>=0?u[target*U.WORDS+1]:Math.trunc(cell/width)*256+128;
    if(tick>=state[p+3]){
      state[p+3]=tick+15;
      if(target===-1)state[p+1]=3;
      if(state[p+1]===0){state[p+1]=1;state[p+3]=tick+1;}
      else if(state[p+1]===1){
        if(u[at+U.UFACE]===u[at+U.UDESIRED])u[at+U.UDESIRED]=desiredFacing256(u[at],u[at+1],tx,ty);
        if(distance(u[at],u[at+1],tx,ty)<896){state[p+1]=2;state[p+3]=tick+1;}
      }else if(state[p+1]===2){
        if(c[s+C.CAMMO]===0){if(--state[p+2]===0)state[p+1]=3;else{c[s+C.CAMMO]=3;state[p+1]=0;}}
        c[s+C.CACTIVE]=1;state[p+3]=tick+5;
      }
    }
    u[at+U.UFACE]=rotateFacing(u[at+U.UFACE],u[at+U.UDESIRED],5);
    const [x,y]=movePoint(u[at],u[at+1],u[at+U.UFACE],40);
    // FLY.CPP Physics retains the old coordinate at the world's edge. A plane
    // arriving from the north must be allowed to turn back into the battlefield.
    if(state[p+1]===3&&(x<bounds.x*256||y<bounds.y*256||x>=(bounds.x+bounds.width)*256||y>=(bounds.y+bounds.height)*256)){u[at+U.UHEALTH]=0;continue;}
    if(x<0||y<0||x>=width*256||y>=battle.setup.grid.height*256)continue;
    u[at]=x;u[at+1]=y;u[at+U.UCELL]=Math.trunc(y/256)*width+Math.trunc(x/256);
  }
}

export class GpuBombers {
  readonly state: StorageBufferAttribute;
  private readonly trig: StorageBufferAttribute;
  private readonly pass;
  constructor(private readonly battle: GpuCombat) {
    this.state=new StorageBufferAttribute(new Int32Array(battle.setup.units.length*STRIDE),1);
    this.trig=new StorageBufferAttribute(Int32Array.from([...Array.from({length:256},(_,dir)=>movePoint(0,0,dir,128)).flat(),...combatTypes.flatMap(type=>[type.risk+type.reward,Number(type.targetable)])]),1);
    const u=storage(battle.units,'int',battle.units.count),c=storage(battle.state,'int',battle.state.count),s=storage(this.state,'int',this.state.count),trig=storage(this.trig,'int',this.trig.count).toReadOnly();
    const clock=storage(battle.movement.control,'int',2).toReadOnly(),width=battle.setup.grid.width,bounds=battle.setup.bounds!;
    this.pass=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(U.WORDS),p=id.mul(STRIDE),cs=id.mul(C.CWORDS),tick=clock.element(0).add(1);
      const unit=(f:number)=>u.element(at.add(f)),state=(f:number)=>s.element(p.add(f)),combat=(f:number)=>c.element(cs.add(f));
      If(unit(U.UTYPE).equal(movementType('A10')).and(unit(U.UHEALTH).greaterThan(0)),()=>{
        If(state(0).notEqual(unit(U.UGENERATION)),()=>{state(0).assign(unit(U.UGENERATION));state(1).assign(0);state(2).assign(3);state(3).assign(0);});
        combat(C.CACTIVE).assign(0);unit(U.UALTITUDE).assign(24);
        const target=combat(C.CTARGET).toVar();
        If(target.greaterThanEqual(0),()=>{If(u.element(target.mul(U.WORDS).add(U.UHEALTH)).lessThanEqual(0),()=>{target.assign(-1);});});
        If(target.equal(-1).and(state(1).notEqual(3)),()=>{
          const score=int(-1).toVar();
          Loop(battle.setup.units.length,({i:other})=>{
            const a=other.mul(U.WORDS),cs=other.mul(C.CWORDS),type=u.element(a.add(U.UTYPE)),raw=trig.element(type.mul(2).add(512));
            If(u.element(a.add(U.UHEALTH)).greaterThan(0).and(u.element(a.add(U.UATTACHED)).equal(0)).and(u.element(a.add(U.UCLOAK)).notEqual(2))
              .and(u.element(a.add(U.UDOMAIN)).notEqual(1).or(u.element(a.add(U.UALTITUDE)).equal(0))).and(c.element(cs.add(C.CSEEN)).notEqual(0))
              .and(trig.element(type.mul(2).add(513)).notEqual(0)).and(alliedOwners(battle.setup,unit(U.UOWNER),u.element(a.add(U.UOWNER))).not()),()=>{
              const floor=int(0).toVar();If(raw.notEqual(0),()=>{floor.assign(2);});
              const value=intMax(floor,raw.add(c.element(cs.add(C.CKILLS))).div(intMax(int(1),unitDistance(ivec2(unit(0),unit(1)),ivec2(u.element(a),u.element(a.add(1)))))));
              If(value.greaterThan(score),()=>{score.assign(value);target.assign(other);});
            });
          });combat(C.CTARGET).assign(target);
        });
        const cell=target.negate().sub(2),point=ivec2(cell.mod(width).mul(256).add(128),cell.div(width).mul(256).add(128)).toVar();
        If(target.greaterThanEqual(0),()=>{point.assign(ivec2(u.element(target.mul(U.WORDS)),u.element(target.mul(U.WORDS).add(1))));});
        const position=()=>ivec2(unit(0),unit(1));
        If(tick.greaterThanEqual(state(3)),()=>{
          state(3).assign(tick.add(15));If(target.equal(-1),()=>{state(1).assign(3);});
          If(state(1).equal(0),()=>{state(1).assign(1);state(3).assign(tick.add(1));})
          .ElseIf(state(1).equal(1),()=>{
            If(unit(U.UFACE).equal(unit(U.UDESIRED)),()=>{unit(U.UDESIRED).assign(int(unitDirection(position(),point)));});
            If(unitDistance(position(),point).lessThan(896),()=>{state(1).assign(2);state(3).assign(tick.add(1));});
          }).ElseIf(state(1).equal(2),()=>{
            If(combat(C.CAMMO).equal(0),()=>{state(2).subAssign(1);If(state(2).equal(0),()=>{state(1).assign(3);}).Else(()=>{combat(C.CAMMO).assign(3);state(1).assign(0);});});
            combat(C.CACTIVE).assign(1);state(3).assign(tick.add(5));
          });
        });
        unit(U.UFACE).assign(unitRotate(unit(U.UFACE),unit(U.UDESIRED),int(5)));
        const dir=unit(U.UFACE).mul(2),delta=(axis:number):Node<'int'>=>trig.element(dir.add(axis)).mul(40).shiftRight(7);
        const next=position().add(ivec2(delta(0),trig.element(dir.add(1)).negate().mul(40).shiftRight(7).negate())).toVar();
        If(state(1).equal(3).and(next.x.lessThan(bounds.x*256).or(next.y.lessThan(bounds.y*256)).or(next.x.greaterThanEqual((bounds.x+bounds.width)*256)).or(next.y.greaterThanEqual((bounds.y+bounds.height)*256))),()=>{unit(U.UHEALTH).assign(0);})
        .ElseIf(next.x.greaterThanEqual(0).and(next.y.greaterThanEqual(0)).and(next.x.lessThan(width*256)).and(next.y.lessThan(battle.setup.grid.height*256)),()=>{unit(0).assign(next.x);unit(1).assign(next.y);unit(U.UCELL).assign(next.y.div(256).mul(width).add(next.x.div(256)));});
      });
    })().compute(battle.setup.units.length);
  }
  step(){this.battle.renderer.compute(this.pass);}
  prepare(){return this.battle.renderer.compileComputeAsync(this.pass);}
  dispose(){this.pass.dispose();releaseStorage(this.battle.renderer,[this.state,this.trig]);}
}
