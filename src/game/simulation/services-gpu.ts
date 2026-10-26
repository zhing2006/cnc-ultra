// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute,type ComputeNode,type Node } from 'three/webgpu';
import { Fn,If,Break,Continue,int,uint,storage,select,abs,ivec2,instanceIndex,atomicStore,atomicMin,atomicLoad } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { intMin,intMax } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { computeFunction } from '../../engine/simulation/compute-function.ts';
import { GpuTaskMask } from '../../engine/simulation/task-mask.ts';
import { movementType } from '../data/movement.ts';
import { movePoint } from '../coord.ts';
import { unitDistance,unitDirection } from './units-nodes.ts';
import { SERVICE_BASE,SERVICE_WORDS,SFACILITY,SMODE,STIMER,SGENERATION,SACTIVE,SEXIT,SERVICE_TYPES,FACTORY_EXITS,REPAIR_EXITS,initialServices } from './services-cpu.ts';
import type { GpuCombat } from './combat-gpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
type I=Node<'int'>;

/** CPU-produced budgets are consumed in stable unit order; accumulated spending is the readback. */
export class GpuServices {
  readonly state:StorageBufferAttribute;
  readonly kernels:ComputeNode[];
  private readonly claims:StorageBufferAttribute;
  private readonly payments:GpuTaskMask;
  private readonly config:StorageBufferAttribute;
  private readonly ownsState:boolean;
  constructor(readonly battle:GpuCombat,state?:StorageBufferAttribute){
    const count=battle.setup.units.length,width=battle.setup.grid.width,cells=battle.setup.grid.edges.length;
    this.claims=new StorageBufferAttribute(new Uint32Array(count*3),1);
    this.payments=new GpuTaskMask(battle.renderer,count);
    this.ownsState=!state;this.state=state??new StorageBufferAttribute(initialServices(count),1);
    const values=[0,0,...SERVICE_TYPES.flat()],open=values.length;values.push(...battle.setup.passable!);
    const starts:number[]=[];for(const name of ['PYLE','HAND','WEAP']){starts.push(values.length);values.push(FACTORY_EXITS[name].length,...FACTORY_EXITS[name].flat());}
    const repairExits=values.length;values.push(...REPAIR_EXITS.flat());
    const neighbors=values.length;values.push(0,-1,1,-1,1,0,1,1,0,1,-1,1,-1,0,-1,-1);
    const entryOffsets=values.length;values.push(...Array.from({length:256},(_,direction)=>movePoint(0,0,direction,124)).flat());
    this.config=new StorageBufferAttribute(Int32Array.from(values),1);
    battle.movement.mapObservers.add((_edges,passable)=>{(this.config.array as Int32Array).set(passable,open);this.config.addUpdateRange(open,cells);this.config.needsUpdate=true;});
    const data=storage(this.config,'int',values.length),u=storage(battle.units,'int',battle.units.count),c=storage(battle.state,'int',battle.state.count);
    const s=storage(this.state,'int',this.state.count),goals=storage(battle.movement.goals,'int',count),paths=storage(battle.movement.pathGoals,'int',count);
    const occupancy=storage(battle.movement.occupancy,'uint',cells*5).toReadOnly();
    const unit=(id:I,field:number)=>u.element(id.mul(U.WORDS).add(field)),stateAt=(id:I,field:number)=>s.element(id.mul(SERVICE_WORDS).add(SERVICE_BASE+field));
    const clearCell=computeFunction(([cell,id,infantry]:[I,I,I])=>{
      const yes=int(0).toVar();If(cell.greaterThanEqual(int(0)).and(cell.lessThan(int(cells))),()=>{
        If(data.element(cell.add(open)).notEqual(0),()=>{
          const free=int(0).toVar();Loop(5,({i})=>{const owner=occupancy.element(cell.mul(5).add(i));If(owner.equal(uint(0)).or(owner.equal(uint(id.add(1)))),()=>{free.addAssign(1);});});
          yes.assign(int(select(infantry.notEqual(0),free.greaterThan(0),free.equal(5))));
        });
      });return yes.notEqual(0);
    },{name:'serviceCellClear',type:'bool',inputs:[{name:'cell',type:'int'},{name:'id',type:'int'},{name:'infantry',type:'int'}]});
    const clear=(cell:I,id:I,infantry=false)=>clearCell(cell,id,int(Number(infantry)));
    const point=(cell:I)=>ivec2(cell.mod(width).mul(256).add(128),cell.div(width).mul(256).add(128));
    const infantryStep=computeFunction(([cell,id]:[I,I])=>{
      const allowed=int(0).toVar();
      If(clear(cell,id,true),()=>{
        const source=ivec2(unit(id,U.UX),unit(id,U.UY)).toVar(),goal=point(cell).toVar();
        const approach=ivec2(cell.mod(width).mul(256).add(source.x.bitAnd(255)),cell.div(width).mul(256).add(source.y.bitAnd(255))).toVar();
        const direction=unitDirection(source,approach).add(128).bitAnd(255).mul(2).add(entryOffsets).toVar();
        const head=approach.add(ivec2(data.element(direction),data.element(direction.add(1)))).toVar();
        If(head.x.greaterThanEqual(0).and(head.y.greaterThanEqual(0)).and(head.x.lessThan(width*256)).and(head.y.lessThan(battle.setup.grid.height*256)),()=>{
          const physical=head.y.div(256).mul(width).add(head.x.div(256)).toVar();
          Loop(5,({i:slot})=>{
            const owner=occupancy.element(physical.mul(5).add(slot)),queried=occupancy.element(cell.mul(5).add(slot));
            const x=select(slot.equal(0),int(128),slot.sub(1).mod(2).mul(128).add(64)),y=select(slot.equal(0),int(128),slot.sub(1).div(2).mul(128).add(64));
            const spot=ivec2(physical.mod(width).mul(256).add(x),physical.div(width).mul(256).add(y));
            If(owner.equal(uint(0)).or(owner.equal(uint(id.add(1)))).and(queried.equal(uint(0)).or(queried.equal(uint(id.add(1))))).and(unitDistance(spot,goal).lessThan(unitDistance(source,goal))),()=>{allowed.assign(1);});
          });
        });
      });return allowed.notEqual(0);
    },{name:'factoryInfantryStep',type:'bool',inputs:[{name:'cell',type:'int'},{name:'actor_id',type:'int'}]});
    const force=(id:I,track:I,cell:I)=>{
      const goal=goals.element(id).toVar(),ordered=unit(id,U.UFLAGS).bitAnd(U.PLAYER_ORDER).notEqual(0).and(stateAt(id,SMODE).greaterThanEqual(10));
      unit(id,U.UDEST).assign(cell);unit(id,U.UTRACK).assign(track);unit(id,U.UTRACK_STEP).assign(0);unit(id,U.UACCUM).assign(0);unit(id,U.USPEED).assign(select(unit(id,U.UKIND).notEqual(0),int(255),int(128)));
      // DRIVE.CPP Force_Track preserves a separately assigned NavCom.
      unit(id,U.UHEAD_X).assign(cell.mod(width).mul(256).add(128));unit(id,U.UHEAD_Y).assign(cell.div(width).mul(256).add(128));goals.element(id).assign(select(ordered,goal,int(-1)));paths.element(id).assign(-1);
    };
    const toward=(id:I,target:I)=>{
      const cell=unit(id,U.UCELL),dx=int(select(target.mod(width).equal(cell.mod(width)),int(0),select(target.mod(width).greaterThan(cell.mod(width)),int(1),int(-1)))).toVar();
      const dy=int(select(target.div(width).equal(cell.div(width)),int(0),select(target.div(width).greaterThan(cell.div(width)),int(1),int(-1)))).toVar();
      const dir=select(dy.lessThan(0),select(dx.lessThan(0),int(7),select(dx.greaterThan(0),int(1),int(0))),select(dy.greaterThan(0),select(dx.lessThan(0),int(5),select(dx.greaterThan(0),int(3),int(4))),select(dx.lessThan(0),int(6),int(2))));
      const goal=goals.element(id).toVar();force(id,dir.mul(9),cell.add(dy.mul(width)).add(dx));goals.element(id).assign(goal);
    };
    const claims=storage(this.claims,'uint',this.claims.count).toAtomic(),claimed=storage(this.claims,'uint',this.claims.count);
    const clearClaims=Fn(()=>{atomicStore(claims.element(instanceIndex),uint(0xffffffff));})().compute(count*3);
    const initialize=Fn(()=>{
      const id=int(instanceIndex);
      If(unit(id,U.UHEALTH).greaterThan(0),()=>{
        If(stateAt(id,SGENERATION).notEqual(unit(id,U.UGENERATION)),()=>{Loop(SERVICE_WORDS,({i})=>{s.element(id.mul(SERVICE_WORDS).add(SERVICE_BASE).add(i)).assign(0);});stateAt(id,SGENERATION).assign(unit(id,U.UGENERATION));});
        const enter=unit(id,U.UENTER);
        If(enter.lessThan(0).and(stateAt(id,SMODE).equal(0)),()=>{stateAt(id,SFACILITY).assign(enter.negate());stateAt(id,SMODE).assign(10);stateAt(id,STIMER).assign(0);});
        const parent=stateAt(id,SFACILITY).sub(1);
        If(parent.greaterThanEqual(0),()=>{atomicMin(claims.element(parent),uint(id));If(stateAt(id,SMODE).equal(12),()=>{atomicMin(claims.element(parent.add(count*2)),uint(id));});});
      });
    })().compute(count);
    const requests=Fn(()=>{
      const id=int(instanceIndex),target=unit(id,U.UENTER).sub(1);claimed.element(id.add(count)).assign(select(stateAt(id,SMODE).equal(12),uint(4),uint(0)));
      If(unit(id,U.UHEALTH).greaterThan(0).and(target.greaterThanEqual(0)).and(stateAt(id,SFACILITY).notEqual(target.add(1))),()=>{
        If(unit(target,U.UTYPE).equal(movementType('FIX')),()=>{
          claimed.element(id.add(count)).assign(select(unit(target,U.UHEALTH).greaterThan(0).and(c.element(target.mul(C.CWORDS).add(C.CACTIVE)).notEqual(0)),uint(1),uint(2)));this.payments.add(id);
        });
      });
    })().compute(count);
    const closeDoors=Fn(()=>{
      const id=int(instanceIndex),parent=stateAt(id,SFACILITY).sub(1).toVar();
      If(claimed.element(id.add(count)).equal(uint(4)).and(parent.greaterThanEqual(0)).and(unit(id,U.UHEALTH).greaterThan(0)),()=>{
        If(unit(parent,U.UHEALTH).lessThanEqual(0).or(c.element(parent.mul(C.CWORDS).add(C.CACTIVE)).equal(0)),()=>{stateAt(id,SFACILITY).assign(0);stateAt(id,SMODE).assign(0);unit(id,U.UENTER).assign(0);}).Else(()=>{
          stateAt(id,STIMER).addAssign(1);If(stateAt(id,STIMER).mod(2).equal(0),()=>{unit(parent,U.UDOOR).assign(intMax(int(0),unit(parent,U.UDOOR).sub(1)));});
          If(unit(parent,U.UDOOR).equal(0),()=>{stateAt(id,SFACILITY).assign(0);stateAt(id,SMODE).assign(0);});
        });
      });
    })().compute(count);
    const advance=(admitted:boolean)=>Fn(()=>{
      const id=int(instanceIndex);
      Loop(1,()=>{
        If(unit(id,U.UHEALTH).lessThanEqual(0).or(admitted?claimed.element(id.add(count)).notEqual(1):claimed.element(id.add(count)).notEqual(0)),()=>{Continue();});
        const parent=stateAt(id,SFACILITY).sub(1).toVar();If(parent.lessThan(0),()=>{Continue();});
        const name=unit(parent,U.UTYPE).toVar();
        If(unit(parent,U.UHEALTH).lessThanEqual(0).or(c.element(parent.mul(C.CWORDS).add(C.CACTIVE)).equal(0)),()=>{stateAt(id,SFACILITY).assign(0);stateAt(id,SMODE).assign(0);unit(id,U.UENTER).assign(0);Continue();});
        const mode=stateAt(id,SMODE).toVar();
        If(mode.equal(10),()=>{
          If(name.equal(movementType('WEAP')),()=>{
            const closing=int(claimed.element(parent.add(count*2))).toVar();
            If(closing.greaterThanEqual(0),()=>{If(closing.greaterThan(id).or(stateAt(closing,SMODE).equal(12)),()=>{Continue();});});
          });
          stateAt(id,STIMER).addAssign(1);
          If(name.equal(movementType('WEAP')),()=>{
            unit(parent,U.UDOOR).assign(intMin(int(10),stateAt(id,STIMER).div(2)));
            If(stateAt(id,STIMER).greaterThanEqual(28),()=>{
              const exit=unit(parent,U.UCELL).add(width-1).toVar(),available=int(1).toVar();
              Loop(5,({i})=>{const owner=occupancy.element(exit.mul(5).add(i));If(owner.notEqual(uint(0)).and(owner.notEqual(uint(id.add(1)))).and(owner.notEqual(uint(parent.add(1)))),()=>{available.assign(0);});});
              If(available.notEqual(0),()=>{force(id,int(66),exit);If(unit(id,U.UFLAGS).bitAnd(U.PLAYER_ORDER).equal(0),()=>{c.element(id.mul(C.CWORDS).add(C.CMISSION)).assign(C.MOVE);});stateAt(id,SMODE).assign(11);});
            });
          }).ElseIf(name.equal(movementType('PROC')),()=>{force(id,int(65),unit(parent,U.UCELL).add(width-1));stateAt(id,SMODE).assign(11);})
            .Else(()=>{
              const base=select(name.equal(movementType('PYLE')),int(starts[0]),int(starts[1])),exit=int(-1).toVar();
              Loop({start:0,end:data.element(base),type:'int'},({i})=>{const at=base.add(1).add(i.mul(2)),cell=unit(parent,U.UORIGIN).add(data.element(at)).add(data.element(at.add(1)).mul(width));If(clear(cell,id,true),()=>{exit.assign(cell);Break();});});
              If(exit.greaterThanEqual(0),()=>{
                const first=select(infantryStep(exit,id),exit,int(-1)).toVar(),best=int(0x7fffffff).toVar();
                If(first.lessThan(0),()=>{
                  for(const [dx,dy] of [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]]){
                    const x=unit(id,U.UCELL).mod(width).add(dx),y=unit(id,U.UCELL).div(width).add(dy),cell=y.mul(width).add(x).toVar();
                    If(x.greaterThanEqual(0).and(x.lessThan(width)).and(y.greaterThanEqual(0)).and(y.lessThan(battle.setup.grid.height)),()=>{
                      If(infantryStep(cell,id),()=>{const score=unitDistance(point(cell),point(exit));If(score.lessThan(best),()=>{first.assign(cell);best.assign(score);});});
                    });
                  }
                });
                If(first.greaterThanEqual(0),()=>{goals.element(id).assign(first);paths.element(id).assign(U.DIRECT_STEP);c.element(id.mul(C.CWORDS).add(C.CMISSION)).assign(C.MOVE);stateAt(id,SEXIT).assign(exit);stateAt(id,SMODE).assign(11);});
              });
            });
        }).ElseIf(mode.equal(11).and(unit(id,U.UDEST).lessThan(0)).and(name.equal(movementType('WEAP')).or(name.equal(movementType('PROC'))).or(goals.element(id).lessThan(0)).or(unit(id,U.UFLAGS).bitAnd(U.PLAYER_ORDER).notEqual(0))),()=>{
          If(name.equal(movementType('WEAP')).and(data.element(unit(id,U.UCELL).add(open)).equal(0)),()=>{
            const exit=int(-1).toVar();Loop(FACTORY_EXITS.WEAP.length,({i})=>{
              const at=i.mul(2).add(starts[2]+1),cell=unit(parent,U.UORIGIN).add(data.element(at)).add(data.element(at.add(1)).mul(width));
              If(clear(cell,id).and(abs(cell.mod(width).sub(unit(id,U.UCELL).mod(width))).lessThanEqual(1)).and(abs(cell.div(width).sub(unit(id,U.UCELL).div(width))).lessThanEqual(1)),()=>{exit.assign(cell);Break();});
            });
            If(exit.greaterThanEqual(0),()=>{
              const dx=exit.mod(width).sub(unit(id,U.UCELL).mod(width)),dy=exit.div(width).sub(unit(id,U.UCELL).div(width));
              const dir=select(dy.lessThan(0),select(dx.lessThan(0),int(7),select(dx.greaterThan(0),int(1),int(0))),select(dy.greaterThan(0),select(dx.lessThan(0),int(5),select(dx.greaterThan(0),int(3),int(4))),select(dx.lessThan(0),int(6),int(2))));
              force(id,dir.mul(9),exit);
            });
          }).ElseIf(name.equal(movementType('PYLE')).or(name.equal(movementType('HAND'))).and(unit(id,U.UFLAGS).bitAnd(U.PLAYER_ORDER).equal(0)).and(unit(id,U.UCELL).notEqual(stateAt(id,SEXIT))),()=>{goals.element(id).assign(stateAt(id,SEXIT));paths.element(id).assign(-1);})
            .Else(()=>{
              If(name.equal(movementType('WEAP')).and(goals.element(id).lessThan(0)).and(unit(id,U.UFLAGS).bitAnd(U.PLAYER_ORDER).equal(0)),()=>{
                const cell=unit(id,U.UCELL).toVar(),facing=unit(id,U.UFACE).add(16).bitAnd(255).shiftRight(5),goal=int(-1).toVar();
                const bounds=battle.setup.bounds??{x:0,y:0,width,height:battle.setup.grid.height};
                Loop(8,({i})=>{
                  const direction=facing.add(i).bitAnd(7).mul(2).add(neighbors),x=cell.mod(width).add(data.element(direction)),y=cell.div(width).add(data.element(direction.add(1))),next=y.mul(width).add(x).toVar();
                  If(x.greaterThanEqual(bounds.x).and(x.lessThan(bounds.x+bounds.width)).and(y.greaterThanEqual(bounds.y)).and(y.lessThan(bounds.y+bounds.height)),()=>{If(clear(next,id),()=>{goal.assign(next);});});
                });
                If(goal.greaterThanEqual(0),()=>{goals.element(id).assign(goal);paths.element(id).assign(-1);});
              });
              unit(id,U.UENTER).assign(0);stateAt(id,SMODE).assign(select(name.equal(movementType('WEAP')),int(12),int(0)));stateAt(id,STIMER).assign(0);If(name.notEqual(movementType('WEAP')),()=>{stateAt(id,SFACILITY).assign(0);});});
        }).ElseIf(mode.equal(1),()=>{
          If(unit(id,U.UDOMAIN).equal(1),()=>{If(unit(id,U.UALTITUDE).equal(0).and(goals.element(id).lessThan(0)).and(unit(id,U.UCELL).equal(unit(parent,U.UCELL))),()=>{stateAt(id,SMODE).assign(3);stateAt(id,STIMER).assign(3);});})
            .ElseIf(goals.element(id).lessThan(0).and(unit(id,U.UDEST).lessThan(0)).and(unit(id,U.UCELL).equal(stateAt(id,SEXIT))),()=>{toward(id,unit(parent,U.UCELL));stateAt(id,SMODE).assign(2);});
        }).ElseIf(mode.equal(2).and(unit(id,U.UDEST).lessThan(0)),()=>{
          If(unit(id,U.UCELL).notEqual(unit(parent,U.UCELL)),()=>{toward(id,unit(parent,U.UCELL));}).Else(()=>{stateAt(id,SMODE).assign(3);stateAt(id,STIMER).assign(3);});
        })
          .ElseIf(mode.equal(3),()=>{
            If(goals.element(id).greaterThanEqual(0),()=>{
              If(unit(id,U.UDOMAIN).equal(0),()=>{
                const center=unit(id,U.UCELL),facing=unit(id,U.UFACE).add(16).bitAnd(255).shiftRight(5),exit=int(-1).toVar();
                Loop(9,({i})=>{const index=select(i.equal(0),facing,i.sub(1)),at=index.mul(2).add(repairExits),cell=center.add(data.element(at)).add(data.element(at.add(1)).mul(width));If(clear(cell,id),()=>{exit.assign(cell);Break();});});
                If(exit.lessThan(0),()=>{Continue();});stateAt(id,SEXIT).assign(exit);stateAt(id,SMODE).assign(4);toward(id,exit);
              }).Else(()=>{stateAt(id,SFACILITY).assign(0);stateAt(id,SMODE).assign(0);unit(id,U.UENTER).assign(0);});
              unit(parent,U.UDOOR).assign(0);Continue();
            });
            stateAt(id,STIMER).subAssign(1);If(stateAt(id,STIMER).greaterThan(0),()=>{Continue();});stateAt(id,STIMER).assign(14);
            const max=data.element(unit(id,U.UTYPE).mul(3).add(4));
            If(unit(id,U.UHEALTH).lessThan(max),()=>{stateAt(id,SACTIVE).assign(-1);})
              .Else(()=>{unit(parent,U.UDOOR).assign(0);stateAt(id,SACTIVE).assign(0);});
          }).ElseIf(mode.equal(4).and(unit(id,U.UDEST).lessThan(0)),()=>{
            If(unit(id,U.UCELL).notEqual(stateAt(id,SEXIT)),()=>{toward(id,stateAt(id,SEXIT));}).Else(()=>{stateAt(id,SFACILITY).assign(0);stateAt(id,SMODE).assign(0);unit(id,U.UENTER).assign(0);});
          });
      });
    })().compute(count);
    const admit=Fn(()=>{this.payments.forEach(id=>{
        const enter=unit(id,U.UENTER).toVar();
        If(enter.greaterThan(0),()=>{If(unit(enter.sub(1),U.UTYPE).equal(movementType('FIX')).and(stateAt(id,SFACILITY).notEqual(enter)),()=>{
          const held=int(claimed.element(enter.sub(1))).toVar(),busy=int(held.greaterThanEqual(0).and(held.notEqual(id))).toVar();
          If(held.greaterThanEqual(0).and(held.lessThan(id)),()=>{If(stateAt(held,SFACILITY).notEqual(enter),()=>{busy.assign(0);});});
          If(busy.notEqual(0),()=>{unit(id,U.UENTER).assign(0);claimed.element(id.add(count)).assign(uint(0));Continue();});
          claimed.element(enter.sub(1)).assign(uint(id));
          stateAt(id,SFACILITY).assign(enter);stateAt(id,SMODE).assign(1);stateAt(id,STIMER).assign(0);
          If(unit(id,U.UDOMAIN).equal(0),()=>{
            const center=unit(enter.sub(1),U.UCELL),exit=center.add(width-1).toVar();
            Loop(8,({i})=>{const index=select(i.equal(0),int(5),select(i.lessThanEqual(5),i.sub(1),i)),at=index.mul(2).add(repairExits),cell=center.add(data.element(at)).add(data.element(at.add(1)).mul(width));If(clear(cell,id),()=>{exit.assign(cell);Break();});});
            stateAt(id,SEXIT).assign(exit);goals.element(id).assign(exit);paths.element(id).assign(-1);
          });
        });});
      If(claimed.element(id.add(count)).equal(uint(2)),()=>{stateAt(id,SFACILITY).assign(0);stateAt(id,SMODE).assign(0);unit(id,U.UENTER).assign(0);claimed.element(id.add(count)).assign(uint(0));});
    });})().compute(1);
    const collectPayments=Fn(()=>{const id=int(instanceIndex);If(stateAt(id,SACTIVE).equal(-1),()=>{this.payments.add(id);});})().compute(count);
    const pay=Fn(()=>{this.payments.forEach(id=>{
      const parent=stateAt(id,SFACILITY).sub(1),type=unit(id,U.UTYPE).mul(3).add(2),owner=unit(id,U.UOWNER),cost=data.element(type),step=data.element(type.add(1)),max=data.element(type.add(2));
      If(data.element(owner).greaterThanEqual(cost),()=>{
        data.element(owner).subAssign(cost);s.element(owner).addAssign(cost);unit(id,U.UHEALTH).assign(intMin(max,unit(id,U.UHEALTH).add(step)));unit(parent,U.UDOOR).assign(1);stateAt(id,SACTIVE).assign(1);
      }).Else(()=>{unit(parent,U.UDOOR).assign(0);stateAt(id,SACTIVE).assign(0);});
    });})().compute(1);
    this.kernels=[clearClaims,initialize,this.payments.clear,requests,closeDoors,advance(false),admit,advance(true),this.payments.clear,collectPayments,pay];
  }
  step(money:number,enemyMoney=0){const config=this.config.array as Int32Array;config[0]=money;config[1]=enemyMoney;this.config.addUpdateRange(0,2);this.config.needsUpdate=true;this.battle.renderer.compute(this.kernels);this.battle.movement.refreshOccupancy();}
  dispose(){for(const pass of this.kernels)if(pass!==this.payments.clear)pass.dispose();this.payments.dispose();releaseStorage(this.battle.renderer,[this.claims,this.config,...(this.ownsState?[this.state]:[])]);}
}
