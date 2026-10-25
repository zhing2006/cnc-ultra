// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute,Vector2,type ComputeNode,type Node } from 'three/webgpu';
import { Fn,If,Break,Continue,int,uint,storage,ivec2,instanceIndex,select,atomicMin,atomicAdd,uniform } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { intMin,randomNode } from '../../engine/simulation/integer-nodes.ts';
import { GpuTaskMask } from '../../engine/simulation/task-mask.ts';
import { computeFunction } from '../../engine/simulation/compute-function.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { movementType,MOVEMENT } from '../data/movement.ts';
import { combatTypes,weapons } from '../data/combat.ts';
import { movePoint } from '../coord.ts';
import { unitDirection,unitDistance } from './units-nodes.ts';
import type { GpuCombat } from './combat-gpu.ts';
import type { GpuAircraft } from './aircraft-gpu.ts';
import { AIR_WORDS,ASTAGE,ADELAY,ASPEED,AFACING,ADESIRED,AGOAL,ATAKEOFF,ALANDING,AGENERATION,AHOVER,ACONTACT,
  AMISSION,ASTATUS,ATIMER,ATARGET,ASERVICE,AFIRED,ARETREAT } from './aircraft-cpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
type I=Node<'int'>;

/** AIRCRAFT.CPP Mission_Attack/Enter_Idle_Mode/Good_Fire_Location; BUILDING.CPP Mission_Repair. */
export class GpuAirOperations {
  get saveBuffers() { return [this.constants, this.requests.buffer]; }
  readonly beforePass:ComputeNode[];
  private readonly requests:GpuTaskMask;
  readonly afterPass:ComputeNode;
  /** Tables and planning scratch share one binding to stay within eight storage buffers. */
  private readonly constants:StorageBufferAttribute;
  private readonly cash=uniform(new Vector2(0,0),'ivec2');
  constructor(readonly battle:GpuCombat,readonly aircraft:GpuAircraft,playable:ArrayLike<number>){
    const count=battle.setup.units.length,width=battle.setup.grid.width,height=battle.setup.grid.height;
    const index=battle.movement.actorIndex;this.requests=new GpuTaskMask(battle.renderer,count);
    const relations=storage(index.buffer,'uint',index.buffer.count),claims=storage(index.buffer,'uint',index.buffer.count).toAtomic();
    const AOP=19;
    const values=[...combatTypes.flatMap(t=>[t.primary<0?0:weapons[t.primary].range,t.ammo]),...Array.from({length:256},(_,d)=>movePoint(0,0,d,128)).flat(),...Array.from(playable)];
    const rings=Math.max(...MOVEMENT.map((type,id)=>type.domain===1&&combatTypes[id].primary>=0?Math.max(0,Math.ceil((weapons[combatTypes[id].primary].range-768)/256)):0));
    const ownerSlots=Math.max(2,...battle.setup.units.map(unit=>(unit.owner??0)+1));
    const strengthBase=values.length;values.push(...MOVEMENT.map(t=>t.strength));
    const stride=3+rings*32,control=values.length,planBase=control+1+ownerSlots;
    const packed=new Int32Array(planBase+count*stride);packed.set(values);
    this.constants=new StorageBufferAttribute(packed,1);
    const data=storage(this.constants,'int',packed.length),trig=combatTypes.length*2,map=trig+512;
    const plan=(id:I,field:number|I)=>data.element(id.mul(stride).add(planBase).add(field));
    const u=storage(battle.units,'int',battle.units.count),c=storage(battle.state,'int',battle.state.count),a=storage(aircraft.state,'int',aircraft.state.count);
    const visible=storage(battle.sight.shadow,'int',battle.sight.shadow.count).toReadOnly();
    const goals=storage(battle.movement.goals,'int',count),clock=storage(battle.movement.control,'int',2).toReadOnly();
    const unit=(id:I,field:number)=>u.element(id.mul(U.WORDS).add(field)),combat=(id:I,field:number)=>c.element(id.mul(C.CWORDS).add(field));
    const dormant=(id:I)=>int(battle.setup.campaignLevel??0).equal(7).and(unit(id,U.UOWNER).equal(battle.setup.goodOwner??-1)).and(unit(id,U.UOWNER).notEqual(battle.humanOwner))
      .and(combat(id,C.CMISSION).equal(C.GUARD)).and(unit(id,U.UALTITUDE).notEqual(24));
    const air=(id:I,field:number)=>a.element(id.mul(AIR_WORDS).add(field));
    const position=(id:I)=>ivec2(unit(id,U.UX),unit(id,U.UY));
    const point=(cell:I)=>ivec2(cell.mod(width).mul(256).add(128),cell.div(width).mul(256).add(128));
    const move=(p:Node<'ivec2'>,dir:I,length:I)=>{
      const at=dir.bitAnd(255).mul(2).add(trig);return p.add(ivec2(data.element(at).mul(length).shiftRight(7),data.element(at.add(1)).negate().mul(length).shiftRight(7).negate()));
    };
    const fireLocation=computeFunction(([id,target]:[I,I])=>{
      const best=int(-1).toVar(),previous=int(-1).toVar(),value=int(0x7fffffff).toVar();
      Loop(rings,({i:ring})=>{
        Loop(16,({i:direction})=>{
          const entry=ring.mul(32).add(direction.mul(2)),cell=plan(id,entry.add(3)).toVar(),d=plan(id,entry.add(4));
          If(cell.greaterThanEqual(0),()=>{
            const clear=int(1).toVar(),latest=int(relations.element(cell.add(index.goalMin))).toVar();
            If(latest.greaterThanEqual(0).and(latest.lessThan(id)),()=>{If(goals.element(latest).equal(cell),()=>{clear.assign(0);});});
            const candidate=int(relations.element(cell.add(index.goalHead))).toVar();
            Loop(()=>{
              If(candidate.lessThan(0).or(clear.equal(0)),()=>{Break();});
              If(candidate.greaterThanEqual(id).or(goals.element(candidate).equal(cell)),()=>{clear.assign(0);});
              candidate.assign(int(relations.element(candidate.add(index.goalNext))));
            });
            If(clear.notEqual(0).and(d.lessThan(value)),()=>{previous.assign(best);best.assign(cell);value.assign(d);});
          });
        });
        If(best.greaterThanEqual(0),()=>{Break();});
      });
      const pick=int(randomNode(uint(battle.setup.seed),uint(clock.element(0).add(1)),uint(id.add(0)),uint(180)).mod(uint(2)));
      return select(previous.lessThan(0).or(pick.equal(0)),best,previous);
    },{name:'airFireLocation',type:'int',inputs:[{name:'id',type:'int'},{name:'enemy',type:'int'}]});
    const initialize=Fn(()=>{
      const id=int(instanceIndex);
      If(id.equal(0),()=>{for(let i=0;i<=ownerSlots;i++)data.element(control+i).assign(0);});
      If(unit(id,U.UTYPE).equal(movementType('HPAD')),()=>{unit(id,U.UDOOR).assign(0);});
      Loop(1,()=>{
        const type=unit(id,U.UTYPE).toVar();
        If(unit(id,U.UDOMAIN).notEqual(1).or(unit(id,U.UHEALTH).lessThanEqual(0)).or(type.equal(movementType('C17'))).or(type.equal(movementType('A10'))),()=>{air(id,AOP).assign(0);Continue();});
        If(air(id,AGENERATION).notEqual(unit(id,U.UGENERATION)),()=>{
          Loop(AIR_WORDS,({i})=>{a.element(id.mul(AIR_WORDS).add(i)).assign(0);});
          air(id,AGENERATION).assign(unit(id,U.UGENERATION));air(id,AGOAL).assign(-1);air(id,ACONTACT).assign(-1);air(id,ATARGET).assign(-1);air(id,AFIRED).assign(-1);
          air(id,AFACING).assign(unit(id,U.UFACE));air(id,ADESIRED).assign(unit(id,U.UFACE));
        });
        air(id,AOP).assign(0);
      });
    })().compute(count);
    const contacts=Fn(()=>{
      const id=int(instanceIndex),contact=air(id,ACONTACT);
      If(unit(id,U.UHEALTH).greaterThan(0),()=>{
        If(unit(id,U.UDOMAIN).equal(1).and(contact.greaterThanEqual(0)),()=>{atomicMin(claims.element(contact.add(index.airOwner)),uint(id));});
        If(unit(id,U.UDOMAIN).equal(0).and(unit(id,U.UENTER).greaterThan(0)),()=>{atomicMin(claims.element(unit(id,U.UENTER).sub(1).add(index.airOwner)),uint(id));});
      });
    })().compute(count);
    const busy=(id:I,facility:I)=>{
      const owner=int(relations.element(facility.add(index.airOwner))).toVar(),occupied=int(owner.greaterThanEqual(0).and(owner.notEqual(id))).toVar();
      If(owner.greaterThanEqual(0).and(owner.lessThan(id)),()=>{
        If(air(owner,ACONTACT).notEqual(facility).and(unit(owner,U.UDOMAIN).notEqual(0).or(unit(owner,U.UENTER).notEqual(facility.add(1)))),()=>{occupied.assign(0);});
      });return occupied;
    };
    const pickPad=computeFunction(([id]:[I])=>{
      const best=int(-1).toVar(),value=int(0x7fffffff).toVar();
      const other=int(relations.element(movementType('HPAD'))).toVar();
      Loop(()=>{
        If(other.lessThan(0),()=>{Break();});
        Loop(1,()=>{
          If(unit(other,U.UOWNER).notEqual(unit(id,U.UOWNER)).or(combat(other,C.CACTIVE).equal(0)),()=>{Continue();});
          const d=unitDistance(position(id),position(other)).toVar();
          If(busy(id,other).equal(0).and(d.lessThan(value).or(d.equal(value).and(other.lessThan(best)))),()=>{best.assign(other);value.assign(d);});
        });
        other.assign(int(relations.element(other.add(index.typeNext))));
      });
      return best;
    },{name:'airNearestAvailablePad',type:'int',inputs:[{name:'id',type:'int'}]});
    const decide=Fn(()=>{
      const id=int(instanceIndex),contact=air(id,ACONTACT);
      If(unit(id,U.UDOMAIN).equal(1).and(unit(id,U.UHEALTH).greaterThan(0)).and(unit(id,U.UTYPE).notEqual(movementType('C17'))).and(unit(id,U.UTYPE).notEqual(movementType('A10'))).and(dormant(id).not()).and(air(id,ARETREAT).equal(0)),()=>{
        If(combat(id,C.CMISSION).equal(C.HUNT).and(combat(id,C.CTARGET).greaterThanEqual(0)).and(combat(id,C.CAMMO).notEqual(0)),()=>{combat(id,C.CMISSION).assign(C.ATTACK);});
        If(unit(id,U.UOWNER).notEqual(battle.humanOwner).and(combat(id,C.CMISSION).equal(C.GUARD)).and(unit(id,U.UALTITUDE).notEqual(24)),()=>{
          const repair=int(-1).toVar(),best=int(0x7fffffff).toVar(),atRepair=int(0).toVar();
          If(contact.greaterThanEqual(0),()=>{atRepair.assign(int(unit(contact,U.UTYPE).equal(movementType('FIX'))));});
          If(select(unit(id,U.UOWNER).equal(int(0)),this.cash.x,this.cash.y).greaterThanEqual(int(100)).and(unit(id,U.UHEALTH).mul(2).lessThanEqual(data.element(unit(id,U.UTYPE).add(strengthBase)))).and(atRepair.equal(0)),()=>{
            const other=int(relations.element(movementType('FIX'))).toVar();
            Loop(()=>{If(other.lessThan(0),()=>{Break();});
              If(unit(other,U.UOWNER).equal(unit(id,U.UOWNER)).and(combat(other,C.CACTIVE).notEqual(0)),()=>{
                const d=unitDistance(position(id),position(other));
                If(busy(id,other).equal(0).and(d.lessThan(best).or(d.equal(best).and(other.lessThan(repair)))),()=>{repair.assign(other);best.assign(d);});
              });other.assign(int(relations.element(other.add(index.typeNext))));
            });
          });
          If(repair.greaterThanEqual(0),()=>{unit(id,U.UENTER).assign(repair.add(1));combat(id,C.CTARGET).assign(-1);})
            .ElseIf(combat(id,C.CTARGET).greaterThanEqual(0).and(combat(id,C.CAMMO).notEqual(0)),()=>{combat(id,C.CMISSION).assign(C.ATTACK);});
          If(atRepair.notEqual(0).and(air(id,AMISSION).equal(3)).and(unit(id,U.UHEALTH).greaterThanEqual(data.element(unit(id,U.UTYPE).add(strengthBase)))),()=>{air(id,ACONTACT).assign(-1);air(id,AMISSION).assign(2);goals.element(id).assign(-1);air(id,AGOAL).assign(-1);});
        });
      });
    })().compute(count);
    const atomicData=storage(this.constants,'int',packed.length).toAtomic();
    const freePads=Fn(()=>{
      const id=int(instanceIndex);
      If(unit(id,U.UTYPE).equal(movementType('HPAD')).and(unit(id,U.UHEALTH).greaterThan(0)).and(combat(id,C.CACTIVE).notEqual(0)),()=>{
        const owner=int(relations.element(id.add(index.airOwner))).toVar(),free=owner.lessThan(0).toVar();
        If(owner.greaterThanEqual(0),()=>{free.assign(air(owner,ACONTACT).notEqual(id).and(unit(owner,U.UDOMAIN).notEqual(0).or(unit(owner,U.UENTER).notEqual(id.add(1)))));});
        If(free,()=>{atomicAdd(atomicData.element(unit(id,U.UOWNER).add(control+1)),int(1));});
      });
    })().compute(count);
    // Geometry and fallback locations do not depend on the order of radio claims.
    const candidates=Fn(()=>{
      const id=int(instanceIndex);
      If(air(id,AOP).notEqual(0),()=>{
        plan(id,2).assign(air(id,ACONTACT));
        const target=combat(id,C.CTARGET).toVar(),firing=int(0).toVar();
        If(target.greaterThanEqual(0),()=>{firing.assign(int(air(id,AMISSION).equal(1).and(air(id,ASTATUS).equal(1)).and(combat(id,C.CMISSION).equal(C.ATTACK)).and(combat(id,C.CAMMO).notEqual(0)).and(unit(target,U.UHEALTH).greaterThan(0))));});
        If(firing.equal(0),()=>{
          plan(id,0).assign(pickPad(id));plan(id,1).assign(unit(id,U.UCELL));
          const nearest=int(0x7fffffff).toVar(),nearestId=int(0x7fffffff).toVar(),building=int(relations.element(index.domainHead+2)).toVar();
          Loop(()=>{
            If(building.lessThan(0),()=>{Break();});
            If(unit(building,U.UOWNER).equal(unit(id,U.UOWNER)),()=>{
              const d=unitDistance(position(id),position(building)).div(select(unit(building,U.UTYPE).equal(movementType('HPAD')),int(4),int(1))).toVar();
              If(d.lessThan(nearest).or(d.equal(nearest).and(building.lessThan(nearestId))),()=>{nearest.assign(d);nearestId.assign(building);plan(id,1).assign(unit(building,U.UCELL));});
            });
            building.assign(int(relations.element(building.add(index.domainNext))));
          });
        });
        If(firing.notEqual(0),()=>{
          const origin=position(target).sub(ivec2(0,unit(target,U.UALTITUDE).mul(256).add(12).div(24))).toVar();
          Loop(rings,({i:ring})=>{const r=data.element(unit(id,U.UTYPE).mul(2)).sub(384).sub(ring.mul(256));
            Loop(16,({i:direction})=>{
              const entry=ring.mul(32).add(direction.mul(2));plan(id,entry.add(3)).assign(-1);
              If(r.greaterThan(384),()=>{
                const pos=move(origin,direction.mul(16),r).toVar(),cell=pos.y.div(256).mul(width).add(pos.x.div(256));
                If(pos.x.greaterThanEqual(0).and(pos.y.greaterThanEqual(0)).and(pos.x.lessThan(width*256)).and(pos.y.lessThan(height*256)),()=>{
                  const explored=battle.setup.multiplayer===false?visible.element(cell).notEqual(-2):int(1).equal(1);
                  If(explored.and(data.element(cell.add(map)).notEqual(0)).and(relations.element(cell.add(index.airCount)).equal(0)),()=>{
                    plan(id,entry.add(3)).assign(cell);plan(id,entry.add(4)).assign(unitDistance(position(id),pos));
                  });
                });
              });
            });
          });
        });
      });
    })().compute(count);
    const advance=(id:I)=>{
        const type=unit(id,U.UTYPE).toVar();
        combat(id,C.CACTIVE).assign(0);
        const enter=unit(id,U.UENTER).sub(1).toVar();
        If(enter.greaterThanEqual(0),()=>{
          If(unit(enter,U.UHEALTH).greaterThan(0).and(unit(enter,U.UOWNER).equal(unit(id,U.UOWNER))).and(combat(enter,C.CACTIVE).notEqual(0)).and(unit(enter,U.UTYPE).equal(movementType('HPAD')).or(unit(enter,U.UTYPE).equal(movementType('FIX')))),()=>{
            If(busy(id,enter).notEqual(0),()=>{unit(id,U.UENTER).assign(0);Continue();});
            relations.element(enter.add(index.airOwner)).assign(uint(id));
            air(id,ACONTACT).assign(enter);air(id,AHOVER).assign(0);air(id,AMISSION).assign(2);combat(id,C.CMISSION).assign(C.GUARD);combat(id,C.CTARGET).assign(-1);
            const cell=select(unit(enter,U.UTYPE).equal(movementType('FIX')),unit(enter,U.UCELL),unit(enter,U.UORIGIN).add(1)).toVar();
            goals.element(id).assign(cell);air(id,AGOAL).assign(cell);air(id,ASTAGE).assign(select(unit(id,U.UALTITUDE).equal(24),int(2),int(1)));air(id,ADELAY).assign(0);unit(id,U.UENTER).assign(0);
            const origin=unit(enter,U.UORIGIN),target=ivec2(origin.mod(width).mul(256).add(256),origin.div(width).mul(256).add(192)).toVar();
            If(unit(enter,U.UTYPE).equal(movementType('FIX')),()=>{target.assign(position(enter));});
            If(unit(id,U.UALTITUDE).equal(0).and(unitDistance(position(id),target).lessThan(16)),()=>{goals.element(id).assign(-1);air(id,AGOAL).assign(-1);air(id,AMISSION).assign(3);air(id,ASERVICE).assign(28);});
          });
        });
        const target=combat(id,C.CTARGET).toVar();
        If(combat(id,C.CMISSION).equal(C.MOVE).and(goals.element(id).greaterThanEqual(0)),()=>{air(id,AMISSION).assign(0);air(id,AHOVER).assign(0);air(id,ACONTACT).assign(-1);Continue();});
        If(combat(id,C.CMISSION).equal(C.ATTACK).and(target.greaterThanEqual(0)).and(data.element(type.mul(2)).greaterThan(0))
          .and(air(id,AMISSION).notEqual(1).or(air(id,ATARGET).notEqual(target))),()=>{
          air(id,AMISSION).assign(1);air(id,ASTATUS).assign(0);air(id,ATIMER).assign(0);air(id,AHOVER).assign(1);air(id,ACONTACT).assign(-1);air(id,ATARGET).assign(target);
        });
        const invalid=int(target.lessThan(0)).toVar();If(target.greaterThanEqual(0),()=>{If(unit(target,U.UHEALTH).lessThanEqual(0),()=>{invalid.assign(1);});});
        If(air(id,AMISSION).equal(1).and(combat(id,C.CMISSION).notEqual(C.ATTACK).or(invalid.notEqual(0)).or(combat(id,C.CAMMO).equal(0))),()=>{air(id,ASTATUS).assign(6);air(id,ATIMER).assign(0);});
        If(air(id,AMISSION).equal(0).and(unit(id,U.UALTITUDE).equal(24)).and(goals.element(id).lessThan(0)),()=>{air(id,AMISSION).assign(2);});
        If(air(id,AMISSION).equal(1),()=>{
          If(air(id,ATIMER).greaterThan(0),()=>{air(id,ATIMER).subAssign(1);If(air(id,ATIMER).greaterThan(0),()=>{Continue();});});
          air(id,ATIMER).assign(7);const stage=air(id,ASTATUS).toVar();
          If(stage.equal(0),()=>{air(id,ASTATUS).assign(1);})
            .ElseIf(stage.equal(1),()=>{
              const cell=fireLocation(id,target).toVar();
              If(cell.lessThan(0),()=>{air(id,ASTATUS).assign(6);}).Else(()=>{goals.element(id).assign(cell);air(id,AGOAL).assign(cell);air(id,ASTAGE).assign(1);air(id,ADELAY).assign(7);air(id,ASTATUS).assign(2);});
            }).ElseIf(stage.equal(2),()=>{
              If(unit(id,U.UALTITUDE).equal(24),()=>{air(id,ASTATUS).assign(3);air(id,AFACING).assign(unitDirection(position(id),point(goals.element(id))));});air(id,ATIMER).assign(1);
            }).ElseIf(stage.equal(3),()=>{If(goals.element(id).lessThan(0),()=>{air(id,ASTATUS).assign(4);air(id,ASPEED).assign(0);});air(id,ATIMER).assign(1);})
              .ElseIf(stage.equal(4).or(stage.equal(5)),()=>{
                const dir=unitDirection(position(id),position(target));air(id,ADESIRED).assign(dir);unit(id,U.UDESIRED).assign(dir);combat(id,C.CACTIVE).assign(1);If(stage.equal(4),()=>{air(id,ATIMER).assign(1);});
              }).Else(()=>{
                air(id,AMISSION).assign(2);air(id,AHOVER).assign(0);goals.element(id).assign(-1);air(id,AGOAL).assign(-1);air(id,ATAKEOFF).assign(0);air(id,ALANDING).assign(0);combat(id,C.CMISSION).assign(C.GUARD);combat(id,C.CTARGET).assign(-1);
              });
        });
        If(air(id,AMISSION).equal(2),()=>{
          const contact=air(id,ACONTACT).toVar();
          If(contact.greaterThanEqual(0),()=>{If(unit(contact,U.UHEALTH).lessThanEqual(0).or(combat(contact,C.CACTIVE).equal(0)),()=>{contact.assign(-1);air(id,ACONTACT).assign(-1);goals.element(id).assign(-1);});});
          If(contact.lessThan(0),()=>{
            const best=plan(id,0).toVar(),retry=data.element(control).notEqual(0).toVar();
            If(best.greaterThanEqual(0),()=>{If(busy(id,best).notEqual(0),()=>{retry.assign(true);});});
            If(retry,()=>{
              // Once all pads are reserved, avoid rescanning them for every remaining plane.
              // A previous contact can be released inside this same mission step.
              If(data.element(unit(id,U.UOWNER).add(control+1)).greaterThan(0).or(plan(id,2).greaterThanEqual(0)),()=>{best.assign(pickPad(id));}).Else(()=>{best.assign(-1);});
            });
            contact.assign(best);air(id,ACONTACT).assign(best);air(id,AHOVER).assign(0);
            const destination=plan(id,1).toVar();
            If(best.greaterThanEqual(0),()=>{relations.element(best.add(index.airOwner)).assign(uint(id));destination.assign(unit(best,U.UORIGIN).add(1));});
            goals.element(id).assign(destination);air(id,AGOAL).assign(destination);air(id,ASTAGE).assign(select(unit(id,U.UALTITUDE).equal(24),int(2),int(1)));air(id,ADELAY).assign(0);
            If(best.lessThan(0),()=>{air(id,AMISSION).assign(0);});
          }).ElseIf(unit(id,U.UALTITUDE).equal(0).and(goals.element(id).lessThan(0)),()=>{air(id,AMISSION).assign(3);air(id,ASERVICE).assign(28);});
        }).ElseIf(air(id,AMISSION).equal(3),()=>{
          const contact=air(id,ACONTACT).toVar();
          If(contact.lessThan(0),()=>{air(id,AMISSION).assign(2);air(id,ACONTACT).assign(-1);Continue();});
          If(unit(contact,U.UHEALTH).lessThanEqual(0),()=>{air(id,AMISSION).assign(2);air(id,ACONTACT).assign(-1);Continue();});
          If(unit(contact,U.UTYPE).equal(movementType('HPAD')).and(combat(id,C.CAMMO).lessThan(data.element(type.mul(2).add(1)))),()=>{
            unit(contact,U.UDOOR).assign(1);
            air(id,ASERVICE).subAssign(1);If(air(id,ASERVICE).lessThanEqual(0),()=>{combat(id,C.CAMMO).addAssign(1);air(id,ASERVICE).assign(int(45).sub(intMin(int(15),combat(contact,C.CPOWER).mul(15).add(128).shiftRight(8))));});
          });
        });
        If(air(id,AMISSION).equal(0).and(unit(id,U.UOWNER).equal(battle.humanOwner)).and(combat(id,C.CMISSION).equal(C.GUARD)),()=>{combat(id,C.CTARGET).assign(-1);});
    };
    const ordinary=Fn(()=>{
      const id=int(instanceIndex),type=unit(id,U.UTYPE),mission=air(id,AMISSION),target=combat(id,C.CTARGET);
      Loop(1,()=>{
        If(unit(id,U.UDOMAIN).notEqual(1).or(unit(id,U.UHEALTH).lessThanEqual(0)).or(type.equal(movementType('C17'))).or(type.equal(movementType('A10'))),()=>{Continue();});
        If(dormant(id).or(air(id,ARETREAT).notEqual(0)),()=>{combat(id,C.CACTIVE).assign(0);Continue();});
        const invalid=int(target.lessThan(0)).toVar();If(target.greaterThanEqual(0),()=>{If(unit(target,U.UHEALTH).lessThanEqual(0),()=>{invalid.assign(1);});});
        const contact=air(id,ACONTACT),returning=int(contact.lessThan(0)).toVar();
        If(contact.greaterThanEqual(0),()=>{If(unit(contact,U.UHEALTH).lessThanEqual(0).or(combat(contact,C.CACTIVE).equal(0)),()=>{returning.assign(1);});});
        // Only new radio contacts and fire-position choices need the original ID ordering.
        const coordinate=unit(id,U.UENTER).greaterThan(0)
          .or(mission.equal(2).and(returning.notEqual(0)))
          .or(mission.equal(0).and(unit(id,U.UALTITUDE).equal(24)).and(goals.element(id).lessThan(0)))
          .or(mission.equal(1).and(air(id,ATIMER).lessThanEqual(1).and(air(id,ASTATUS).equal(1).or(air(id,ASTATUS).equal(6)))
            .or(combat(id,C.CMISSION).notEqual(C.ATTACK)).or(invalid.notEqual(0)).or(combat(id,C.CAMMO).equal(0))));
        If(coordinate,()=>{air(id,AOP).assign(1);}).Else(()=>{advance(id);});
      });
    })().compute(count);
    const collect=Fn(()=>{const id=int(instanceIndex);If(air(id,AOP).notEqual(0),()=>{this.requests.add(id);});})().compute(count);
    const coordinate=Fn(()=>{this.requests.forEach(id=>{
      const previous=air(id,ACONTACT).toVar();
      air(id,AOP).assign(0);Loop(1,()=>{advance(id);});
      // A lower-ID aircraft can release a nearer pad after speculation.
      const current=air(id,ACONTACT).toVar();
      If(current.notEqual(previous),()=>{
        If(previous.greaterThanEqual(0),()=>{data.element(control).assign(1);If(unit(previous,U.UTYPE).equal(movementType('HPAD')).and(unit(previous,U.UHEALTH).greaterThan(0)).and(combat(previous,C.CACTIVE).notEqual(0)),()=>{data.element(unit(previous,U.UOWNER).add(control+1)).addAssign(1);});});
        If(current.greaterThanEqual(0),()=>{If(unit(current,U.UTYPE).equal(movementType('HPAD')).and(combat(current,C.CACTIVE).notEqual(0)),()=>{data.element(unit(current,U.UOWNER).add(control+1)).subAssign(1);});});
      });
      const goal=goals.element(id);If(goal.greaterThanEqual(0),()=>{relations.element(goal.add(index.goalMin)).assign(uint(id));});
    });})().compute(1);
    this.beforePass=[...index.kernels,initialize,contacts,decide,ordinary,freePads,candidates,this.requests.clear,collect,coordinate];
    this.afterPass=Fn(()=>{
      const id=int(instanceIndex),contact=air(id,ACONTACT);
      If(contact.greaterThanEqual(0),()=>{
        If(unit(contact,U.UCAPTURE_TICK).equal(clock.element(0)).and(unit(id,U.UALTITUDE).equal(0)),()=>{
          const origin=unit(contact,U.UORIGIN),dock=ivec2(origin.mod(width).mul(256).add(256),origin.div(width).mul(256).add(192)).toVar();
          If(unit(contact,U.UTYPE).equal(movementType('FIX')),()=>{dock.assign(position(contact));});
          If(unitDistance(position(id),dock).lessThan(64),()=>{unit(id,U.UOWNER).assign(unit(contact,U.UOWNER));});
        });
      });
      If(air(id,AMISSION).equal(1).and(combat(id,C.CACTIVE).notEqual(0)),()=>{
        If(combat(id,C.CLAST_FIRE).equal(clock.element(0)),()=>{
          If(air(id,ASTATUS).equal(4),()=>{air(id,ASTATUS).assign(5);air(id,ATIMER).assign(1);})
            .Else(()=>{air(id,ASTATUS).assign(select(combat(id,C.CAMMO).notEqual(0),int(1),int(6)));air(id,ATIMER).assign(7);});
        }).ElseIf(air(id,ASTATUS).equal(4),()=>{air(id,ASTATUS).assign(5);air(id,ATIMER).assign(1);})
          .ElseIf(combat(id,C.CARM).equal(0),()=>{air(id,ASTATUS).assign(select(combat(id,C.CAMMO).notEqual(0),int(1),int(6)));air(id,ATIMER).assign(7);});
      });
    })().compute(count);
  }
  before(cash:readonly number[]=[0,0]){this.cash.value.set(cash[0]??0,cash[1]??0);this.battle.renderer.compute(this.beforePass);}
  after(){this.battle.renderer.compute(this.afterPass);}
  dispose(){for(const pass of this.beforePass)if(!this.battle.movement.actorIndex.kernels.includes(pass)&&pass!==this.requests.clear)pass.dispose();this.requests.dispose();this.afterPass.dispose();releaseStorage(this.battle.renderer,[this.constants]);}
}
