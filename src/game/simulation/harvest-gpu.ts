// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, Break, Continue, int, uint, storage, ivec2, select,uniform,instanceIndex,atomicMin,atomicLoad,atomicMax,atomicAdd,atomicStore } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { intMin } from '../../engine/simulation/integer-nodes.ts';
import { GpuTaskMask } from '../../engine/simulation/task-mask.ts';
import { computeFunction } from '../../engine/simulation/compute-function.ts';
import { movementType } from '../data/movement.ts';
import { combatTypes } from '../data/combat.ts';
import { INTERRUPTIBLE_INFANTRY_ACTIONS } from '../data/abilities.ts';
import * as C from './combat-state.ts';
import { unitDistance } from './units-nodes.ts';
import { HWORDS,HBASE,HMODE,HTIMER,HLOAD,HREF,HGOAL,HGEN,HARCHIVE,HSTAGE,HCREDIT,HCLIENT } from './harvest-cpu.ts';
import type { EconomyRuntime } from './economy-runtime.ts';
import { BUILDING_WORDS } from './economy-runtime.ts';
import type { GpuTiberium } from './tiberium-gpu.ts';
import * as U from './units-state.ts';
type I=Node<'int'>;

/** The same ordered state transition as stepHarvest; only the two credit totals are read back. */
export class GpuHarvest {
  readonly kernels:ComputeNode[];
  private readonly requests:GpuTaskMask;
  private readonly clearance:GpuTaskMask;
  constructor(readonly economy:Pick<EconomyRuntime,'battle'|'scene'|'visuals'|'miningState'>,ore:GpuTiberium){
    const {battle,scene}=economy,{width}=battle.setup.grid,count=battle.setup.units.length,cells=scene.playable.length;
    const index=battle.movement.actorIndex;index.setPlayable(scene.playable);
    const relations=storage(index.buffer,'uint',index.buffer.count),claims=storage(index.buffer,'uint',index.buffer.count).toAtomic();
    this.requests=new GpuTaskMask(battle.renderer,count);
    this.clearance=new GpuTaskMask(battle.renderer,count);
    const u=storage(battle.units,'int',battle.units.count),goals=storage(battle.movement.goals,'int',count),paths=storage(battle.movement.pathGoals,'int',count);
    const amount=storage(ore.amount,'int',cells),h=storage(economy.miningState,'int',economy.miningState.count);
    const occupancy=storage(battle.movement.occupancy,'uint',cells*5).toReadOnly(),buildings=storage(economy.visuals,'int',economy.visuals.count).toReadOnly();
    const unit=(id:I,field:number)=>u.element(id.mul(U.WORDS).add(field));
    const state=(id:I,field:number)=>h.element(id.mul(HWORDS).add(HBASE+field));
    const position=(id:I)=>ivec2(unit(id,U.UX),unit(id,U.UY));
    const free=(id:I,cell:I)=>{
      const yes=int(1).toVar();Loop(5,({i})=>{const value=occupancy.element(cell.mul(5).add(i));If(value.notEqual(uint(0)).and(value.notEqual(uint(id.add(1)))),()=>{yes.assign(0);});});return yes.notEqual(0);
    };
    const seek=computeFunction(([id]:[I])=>{
      const cell=unit(id,U.UCELL),found=int(-1).toVar();
      If(amount.element(cell).greaterThanEqual(0),()=>{found.assign(cell);}).Else(()=>{
        Loop({start:1,end:32,type:'int'},({i:r})=>{
          Loop({start:r.negate(),end:r,condition:'<=',type:'int'},({i:x})=>{
            for(let side=0;side<4;side++){
              const dx=side<2?x:side===2?r.negate():r,dy=side<2?(side===0?r.negate():r):x;
              const xx=cell.mod(width).add(dx),yy=cell.div(width).add(dy),target=yy.mul(width).add(xx);
              If(found.lessThan(0).and(xx.greaterThanEqual(0)).and(xx.lessThan(width)).and(yy.greaterThanEqual(0)).and(target.lessThan(cells)),()=>{
                If(relations.element(target.add(index.playable)).notEqual(0).and(amount.element(target).greaterThanEqual(0)).and(free(id,target)),()=>{found.assign(target);});
              });
            }
            If(found.greaterThanEqual(0),()=>{Break();});
          });
          If(found.greaterThanEqual(0),()=>{Break();});
        });
      });return found;
    },{name:'harvesterSeek',type:'int',inputs:[{name:'actor_id',type:'int'}]});
    const clock=Fn(()=>{h.element(2).addAssign(1);})().compute(1);
    const initialize=Fn(()=>{const id=int(instanceIndex);Loop(1,()=>{
      If(unit(id,U.UTYPE).notEqual(movementType('HARV')).or(unit(id,U.UHEALTH).lessThanEqual(0)).or(unit(id,U.UENTER).lessThan(0)),()=>{Continue();});
        If(state(id,HGEN).notEqual(unit(id,U.UGENERATION)),()=>{
          Loop(HWORDS,({i})=>{h.element(id.mul(HWORDS).add(HBASE).add(i)).assign(0);});
          state(id,HGEN).assign(unit(id,U.UGENERATION));state(id,HREF).assign(-1);state(id,HGOAL).assign(-1);state(id,HARCHIVE).assign(-1);
        });
        If(goals.element(id).greaterThanEqual(0).and(goals.element(id).notEqual(state(id,HGOAL))).and(unit(id,U.UATTACHED).equal(0)),()=>{
          state(id,HMODE).assign(0);state(id,HTIMER).assign(0);state(id,HREF).assign(-1);state(id,HGOAL).assign(goals.element(id));
        });
        const ordered=unit(id,U.UENTER).sub(1).toVar();
        If(ordered.greaterThanEqual(0).and(unit(id,U.UATTACHED).equal(0)),()=>{
          unit(id,U.UENTER).assign(0);
          If(unit(ordered,U.UTYPE).equal(movementType('PROC')).and(unit(ordered,U.UHEALTH).greaterThan(0)).and(unit(ordered,U.UOWNER).equal(unit(id,U.UOWNER))).and(buildings.element(ordered.mul(BUILDING_WORDS).add(3)).notEqual(0)),()=>{
            state(id,HREF).assign(ordered);state(id,HMODE).assign(3);state(id,HTIMER).assign(0);
            goals.element(id).assign(unit(ordered,U.UCELL).add(width-1));state(id,HGOAL).assign(goals.element(id));paths.element(id).assign(-1);
          });
        });
        const ref=state(id,HREF).toVar();
        If(ref.greaterThanEqual(0),()=>{
          If(unit(ref,U.UHEALTH).lessThanEqual(0).or(buildings.element(ref.mul(BUILDING_WORDS).add(3)).equal(0)),()=>{
            If(unit(id,U.UATTACHED).notEqual(0),()=>{unit(id,U.UHEALTH).assign(0);unit(id,U.UATTACHED).assign(0);Continue();});
            state(id,HREF).assign(-1);state(id,HMODE).assign(2);state(id,HTIMER).assign(0);goals.element(id).assign(-1);state(id,HGOAL).assign(-1);
          });
        });
    });})().compute(count);
    const contacts=Fn(()=>{
      const id=int(instanceIndex),ref=state(id,HREF),mode=state(id,HMODE);
      If(unit(id,U.UTYPE).equal(movementType('HARV')).and(unit(id,U.UHEALTH).greaterThan(0)).and(ref.greaterThanEqual(0)).and(mode.greaterThanEqual(3)),()=>{
        atomicMin(claims.element(ref.add(index.harvestOwner)),uint(id));
        If(mode.greaterThanEqual(4),()=>{atomicMin(claims.element(ref.add(index.harvestDock)),uint(id));})
          .Else(()=>{atomicMin(claims.element(ref.add(index.harvestApproach)),uint(id));});
      });
    })().compute(count);
    const advance=Fn(()=>{
      const id=int(instanceIndex);Loop(1,()=>{
        If(unit(id,U.UTYPE).notEqual(movementType('HARV')).or(unit(id,U.UHEALTH).lessThanEqual(0)).or(unit(id,U.UENTER).lessThan(0)),()=>{Continue();});
        const ref=state(id,HREF).toVar();
        state(id,HSTAGE).addAssign(1);
        If(state(id,HTIMER).greaterThan(0),()=>{state(id,HTIMER).subAssign(1);If(state(id,HTIMER).greaterThan(0),()=>{Continue();});});
        state(id,HTIMER).assign(15);
        const setGoal=(cell:I)=>{goals.element(id).assign(cell);paths.element(id).assign(-1);state(id,HGOAL).assign(cell);};
        const forceTrack=(track:number,cell:I)=>{
          unit(id,U.UDEST).assign(cell);unit(id,U.UTRACK).assign(track);unit(id,U.UTRACK_STEP).assign(0);unit(id,U.UACCUM).assign(0);unit(id,U.USPEED).assign(128);
          unit(id,U.UHEAD_X).assign(cell.mod(width).mul(256).add(128));unit(id,U.UHEAD_Y).assign(cell.div(width).mul(256).add(128));
        };
        const mode=state(id,HMODE).toVar(),cell=unit(id,U.UCELL).toVar();
        If(mode.equal(0),()=>{
          If(goals.element(id).greaterThanEqual(0),()=>{Continue();});
          const found=seek(id);
          If(found.equal(cell),()=>{state(id,HMODE).assign(1);state(id,HTIMER).assign(1);})
            .ElseIf(found.greaterThanEqual(0),()=>{setGoal(found);}).Else(()=>{state(id,HMODE).assign(7);state(id,HTIMER).assign(225);});
        }).ElseIf(mode.equal(1),()=>{
          If(goals.element(id).greaterThanEqual(0),()=>{Continue();});
          If(state(id,HLOAD).lessThan(28).and(amount.element(cell).greaterThanEqual(0)),()=>{
            const taken=intMin(amount.element(cell),intMin(amount.element(cell).mod(6).add(1),int(28).sub(state(id,HLOAD)))).toVar();
            state(id,HLOAD).addAssign(taken);amount.element(cell).assign(select(amount.element(cell).greaterThan(taken),amount.element(cell).sub(taken),int(-1)));state(id,HSTAGE).assign(0);
          }).Else(()=>{
            If(state(id,HLOAD).equal(28),()=>{state(id,HMODE).assign(2);state(id,HARCHIVE).assign(cell);})
              .Else(()=>{const found=seek(id);If(found.lessThan(0),()=>{state(id,HMODE).assign(2);state(id,HARCHIVE).assign(-1);}).ElseIf(found.notEqual(cell),()=>{setGoal(found);});});
            state(id,HTIMER).assign(1);
          });
        }).ElseIf(mode.equal(2),()=>{
          If(goals.element(id).greaterThanEqual(0),()=>{Continue();});
          state(id,HMODE).assign(-2);
        }).ElseIf(mode.equal(3),()=>{
          state(id,HTIMER).assign(1);
          const dock=int(relations.element(ref.add(index.harvestDock))),approach=int(relations.element(ref.add(index.harvestApproach)));
          const busy=int(dock.greaterThanEqual(0).and(dock.notEqual(id)).or(approach.greaterThanEqual(0).and(approach.lessThan(id))));
          If(busy.notEqual(0),()=>{Continue();});
          If(goals.element(id).lessThan(0).and(unit(id,U.UDEST).lessThan(0)),()=>{
            const destination=unit(ref,U.UCELL).add(width-1);
            // BUILDING.CPP Receive_Message(RADIO_DOCKING) repeats the lost approach order.
            If(cell.notEqual(destination),()=>{setGoal(destination);}).Else(()=>{
              unit(id,U.UDESIRED).assign(160);
              If(unit(id,U.UFACE).equal(160),()=>{forceTrack(64,cell.sub(width));state(id,HMODE).assign(8);});
            });
          });
        }).ElseIf(mode.equal(4),()=>{state(id,HMODE).assign(5);state(id,HTIMER).assign(20);state(id,HSTAGE).assign(0);})
          .ElseIf(mode.equal(5),()=>{
            const exit=unit(ref,U.UCELL).add(width-1);
            Loop(5,({i:slot})=>{
              const other=int(occupancy.element(exit.mul(5).add(slot))).sub(1);
              If(other.greaterThanEqual(0),()=>{this.clearance.add(other);});
            });
            If(state(id,HLOAD).greaterThan(0),()=>{state(id,HLOAD).subAssign(1);state(id,HCREDIT).assign(25);});
            state(id,HTIMER).assign(20);state(id,HSTAGE).assign(0);If(state(id,HLOAD).equal(0),()=>{state(id,HMODE).assign(6);state(id,HTIMER).assign(24);});
          }).ElseIf(mode.equal(6),()=>{
            const exit=unit(ref,U.UCELL).add(width-1);
            If(relations.element(exit.add(index.passable)).notEqual(0).and(free(id,exit)),()=>{
              unit(id,U.UATTACHED).assign(0);state(id,HMODE).assign(9);state(id,HTIMER).assign(1);setGoal(int(-1));forceTrack(65,exit);
            }).Else(()=>{state(id,HTIMER).assign(1);});
          }).ElseIf(mode.equal(8),()=>{
            state(id,HTIMER).assign(1);If(unit(id,U.UDEST).lessThan(0),()=>{unit(id,U.UATTACHED).assign(ref.add(1));state(id,HMODE).assign(4);state(id,HTIMER).assign(28);state(id,HSTAGE).assign(0);});
          }).ElseIf(mode.equal(9),()=>{
            state(id,HTIMER).assign(1);If(unit(id,U.UDEST).lessThan(0),()=>{state(id,HMODE).assign(0);state(id,HREF).assign(-1);});
          }).Else(()=>{state(id,HMODE).assign(0);state(id,HTIMER).assign(15);});
      });
    })().compute(count);
    const collect=Fn(()=>{const id=int(instanceIndex);If(state(id,HMODE).equal(-2).and(unit(id,U.UHEALTH).greaterThan(0)),()=>{this.requests.add(id);});})().compute(count);
    const radiusLimit=uniform(Math.ceil(width/2),'int');
    const nearby=computeFunction(([center]:[I])=>{
      const found=int(-1).toVar();
      const visit=(dx:I,dy:I)=>{
        const x=center.mod(width).add(dx),y=center.div(width).add(dy),cell=y.mul(width).add(x);
        If(x.greaterThanEqual(0).and(x.lessThan(width)).and(y.greaterThanEqual(0)).and(cell.lessThan(cells)),()=>{
          If(relations.element(cell.add(index.playable)).notEqual(0).and(relations.element(cell.add(index.buildable)).notEqual(0)).and(amount.element(cell).lessThan(0)).and(free(int(-1),cell)),()=>{found.assign(cell);});
        });
      };
      Loop(radiusLimit,({i:r})=>{Loop({start:r.negate(),end:r,condition:'<=',type:'int'},({i:x})=>{visit(x,r.negate());visit(x,r);});Loop({start:int(1).sub(r),end:r,type:'int'},({i:y})=>{visit(r.negate(),y);visit(r,y);});If(found.greaterThanEqual(0),()=>{Break();});});
      return found;
    },{name:'harvesterNearbyRefinery',type:'int',inputs:[{name:'center_cell',type:'int'}]});
    // Only new radio-contact requests need stable ordering; ordinary harvesters advance in parallel.
    const admit=Fn(()=>{this.requests.forEach(id=>{
      state(id,HMODE).assign(2);
      const best=int(-1).toVar(),distance=int(0x7fffffff).toVar(),nearest=int(-1).toVar(),nearestDistance=int(0x7fffffff).toVar();
      const other=int(relations.element(movementType('PROC'))).toVar();
      Loop(()=>{
        If(other.lessThan(0),()=>{Break();});
        If(unit(other,U.UOWNER).equal(unit(id,U.UOWNER)).and(unit(other,U.UHEALTH).greaterThan(0)).and(buildings.element(other.mul(BUILDING_WORDS).add(3)).notEqual(0)),()=>{
          const owner=int(relations.element(other.add(index.harvestOwner))).toVar(),busy=int(owner.greaterThanEqual(0).and(owner.notEqual(id))).toVar();
          If(owner.greaterThanEqual(0).and(owner.lessThan(id)),()=>{If(state(owner,HREF).notEqual(other).or(state(owner,HMODE).lessThan(3)),()=>{busy.assign(0);});});
          const d=unitDistance(position(id),position(other)).toVar();
          If(d.lessThan(nearestDistance).or(d.equal(nearestDistance).and(other.lessThan(nearest))),()=>{nearest.assign(other);nearestDistance.assign(d);});
          If(busy.equal(0).and(d.lessThan(distance).or(d.equal(distance).and(other.lessThan(best)))),()=>{best.assign(other);distance.assign(d);});
        });
        other.assign(int(relations.element(other.add(index.typeNext))));
      });
      const destination=int(-1).toVar();
      If(best.greaterThanEqual(0),()=>{
        state(id,HREF).assign(best);state(id,HMODE).assign(3);state(id,HTIMER).assign(1);destination.assign(unit(best,U.UCELL).add(width-1));relations.element(best.add(index.harvestOwner)).assign(uint(id));
      }).ElseIf(nearest.greaterThanEqual(0),()=>{state(id,HMODE).assign(-3);state(id,HCREDIT).assign(nearest.negate().sub(1));});
      If(destination.greaterThanEqual(0),()=>{goals.element(id).assign(destination);paths.element(id).assign(-1);state(id,HGOAL).assign(destination);});
    });})().compute(1);
    const waitNearby=Fn(()=>{
      const id=int(instanceIndex);
      If(state(id,HMODE).equal(-3),()=>{
        const refinery=state(id,HCREDIT).negate().sub(1),destination=nearby(unit(refinery,U.UCELL)).toVar();
        state(id,HMODE).assign(2);state(id,HCREDIT).assign(0);
        If(destination.greaterThanEqual(0),()=>{goals.element(id).assign(destination);paths.element(id).assign(-1);state(id,HGOAL).assign(destination);});
      });
    })().compute(count);
    const credits=storage(economy.miningState,'int',economy.miningState.count).toAtomic();
    const deposit=Fn(()=>{const id=int(instanceIndex),at=id.mul(HWORDS).add(HBASE+HCREDIT),value=atomicLoad(credits.element(at));If(value.greaterThan(0),()=>{atomicAdd(credits.element(unit(id,U.UOWNER)),value);atomicStore(credits.element(at),int(0));});})().compute(count);
    const clearClients=Fn(()=>{const id=int(instanceIndex);state(id,HCLIENT).assign(0);})().compute(count);
    const clients=Fn(()=>{
      const id=int(instanceIndex),p=id.mul(HWORDS).add(HBASE),ref=atomicLoad(credits.element(p.add(HREF))),mode=atomicLoad(credits.element(p.add(HMODE)));
      If(unit(id,U.UHEALTH).greaterThan(0).and(unit(id,U.UTYPE).equal(movementType('HARV'))).and(ref.greaterThanEqual(0)).and(mode.greaterThanEqual(3)).and(mode.lessThanEqual(6)),()=>{atomicMax(credits.element(ref.mul(HWORDS).add(HBASE+HCLIENT)),id.add(1));});
    })().compute(count);
    const clearance=storage(this.clearance.buffer,'uint',this.clearance.buffer.count).toReadOnly();
    const combat=storage(battle.state,'int',battle.state.count),scatter=battle.movement.scattering;
    // A separate pass shares movement's writable bindings and ranks no objects on the CPU.
    const clearApron=Fn(()=>{
      const id=int(instanceIndex),requested=clearance.element(id.div(32)).bitAnd(uint(1).shiftLeft(uint(id.mod(32))));
      If(requested.notEqual(uint(0)),()=>{
        const body=(field:number)=>scatter.unit(id,field),fight=(field:number)=>combat.element(id.mul(C.CWORDS).add(field));
        If(body(U.UHEALTH).greaterThan(0).and(body(U.UATTACHED).equal(0)).and(body(U.UDOMAIN).equal(0))
          .and(body(U.UTYPE).notEqual(movementType('BOAT'))).and(body(U.UTYPE).notEqual(movementType('LST'))),()=>{
          const allowed=int(1).toVar(),infantry=body(U.UKIND).notEqual(0).toVar();
          If(infantry,()=>{
            const fraidy=int(0).toVar(),interruptible=int(fight(C.CACTION).lessThan(0)).toVar();
            combatTypes.forEach((type,index)=>{if(type.fraidy)If(body(U.UTYPE).equal(index),()=>{fraidy.assign(1);});});
            for(const action of INTERRUPTIBLE_INFANTRY_ACTIONS)If(fight(C.CACTION).equal(action),()=>{interruptible.assign(1);});
            If(interruptible.equal(0).or(fraidy.equal(0).and(body(U.UDEST).greaterThanEqual(0).or(scatter.goal(id).greaterThanEqual(0)))),()=>{allowed.assign(0);});
          });
          If(allowed.notEqual(0),()=>{
            const destination=scatter.move(id);
            If(infantry.and(destination.greaterThanEqual(0)),()=>{
              fight(C.CMISSION).assign(C.MOVE);fight(C.CFIRE).assign(-1);fight(C.CACTION).assign(0);fight(C.CSTAGE).assign(0);
              fight(C.CLOCAL_ROUTE).assign(0);fight(C.CROUTE_LENGTH).assign(0);fight(C.CLOCAL_DEST).assign(-1);
            });
          });
        });
      });
    })().compute(count);
    this.kernels=[clock,...index.kernels,initialize,contacts,this.clearance.clear,advance,this.requests.clear,collect,admit,waitNearby,deposit,clearClients,clients,clearApron];
  }
  step(){this.economy.battle.renderer.compute(this.kernels);this.economy.battle.movement.refreshOccupancy();}
  dispose(){for(const pass of this.kernels)if(!this.economy.battle.movement.actorIndex.kernels.includes(pass)&&pass!==this.requests.clear&&pass!==this.clearance.clear)pass.dispose();this.requests.dispose();this.clearance.dispose();}
}
