// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { Fn, If, int, uint, instanceIndex, select, storage } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { randomNode } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { SCANNER_BUILDINGS } from '../data/abilities.ts';
import type { GpuCombat } from './combat-gpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
type I=Node<'int'>;

export class GpuCloak {
  readonly advance;
  readonly contacts;
  readonly uncloak:(id:I)=>void;
  private readonly data:StorageBufferAttribute;
  private readonly mapChanged:(edges:Uint32Array)=>void;
  constructor(private readonly battle:GpuCombat,inRange:(id:I,target:I)=>Node<'bool'>,unit:(id:I,field:number)=>I,state:(id:I,field:number)=>I){
    const m=battle.movement,count=battle.setup.units.length,w=battle.setup.grid.width,h=battle.setup.grid.height,edgeBase=MOVEMENT.length*2;
    const directions=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]],directionBase=edgeBase+w*h;
    this.data=new StorageBufferAttribute(Int32Array.from([...MOVEMENT.flatMap(t=>[t.strength,Number(!!t.infantry||SCANNER_BUILDINGS.has(t.name))]),...battle.setup.grid.edges,...directions.flat()]),1);
    this.mapChanged=edges=>{(this.data.array as Int32Array).set(edges,edgeBase);this.data.addUpdateRange(edgeBase,edges.length);this.data.needsUpdate=true;};m.mapObservers.add(this.mapChanged);
    const data=storage(this.data,'int',this.data.count).toReadOnly();
    const clock=storage(m.control,'int',m.control.count).toReadOnly(),occupied=storage(m.occupancy,'int',m.occupancy.count).toReadOnly();
    const goals=storage(m.goals,'int',m.goals.count),paths=storage(m.pathGoals,'int',m.pathGoals.count);
    const alive=(id:I)=>unit(id,U.UTYPE).equal(int(movementType('STNK'))).and(unit(id,U.UHEALTH).greaterThan(int(0))).and(unit(id,U.UATTACHED).equal(int(0)));
    const pick=(id:I,stream:number,n:number)=>int(randomNode(uint(battle.setup.seed),uint(clock.element(0).add(int(1))),uint(id),uint(stream)).mod(uint(n)));
    this.uncloak=id=>{
      If(unit(id,U.UCLOAK).equal(int(1)).or(unit(id,U.UCLOAK).equal(int(2))),()=>{
        unit(id,U.UCLOAK).assign(3);unit(id,U.UCLOAK_STAGE).assign(0);unit(id,U.UCLOAK_WAIT).assign(0);
        unit(id,U.UCLOAK_EVENT).assign(select(unit(id,U.UCLOAK_EVENT).div(int(8)).equal(clock.element(0)),unit(id,U.UCLOAK_EVENT),clock.element(0).mul(int(8))).bitOr(int(6)));
      });
    };
    this.advance=Fn(()=>{
      const id=int(instanceIndex);
      If(alive(id),()=>{
        const mode=unit(id,U.UCLOAK).toVar(),health=unit(id,U.UHEALTH).mul(int(256)).div(data.element(unit(id,U.UTYPE).mul(int(2)))).toVar();
        If(mode.equal(int(0)),()=>{
          If(unit(id,U.UCLOAK_WAIT).greaterThan(int(0)),()=>{unit(id,U.UCLOAK_WAIT).subAssign(1);If(unit(id,U.UCLOAK_WAIT).equal(int(0)),()=>{unit(id,U.UCLOAK_STAGE).addAssign(1);});});
          If(state(id,C.CARM).equal(int(0)).and(unit(id,U.UCLOAK_STAGE).greaterThan(int(0))).and(health.greaterThan(int(64)).or(pick(id,460,26).equal(int(1)))),()=>{unit(id,U.UCLOAK).assign(1);unit(id,U.UCLOAK_STAGE).assign(0);unit(id,U.UCLOAK_EVENT).assign(clock.element(0).add(int(1)).mul(int(8)).add(int(3)));});
        }).ElseIf(mode.equal(int(1)).or(mode.equal(int(3))),()=>{
          unit(id,U.UCLOAK_STAGE).addAssign(1);const stage=unit(id,U.UCLOAK_STAGE).toVar();
          If(mode.equal(int(3)).and(stage.greaterThanEqual(int(38))),()=>{unit(id,U.UCLOAK).assign(0);unit(id,U.UCLOAK_STAGE).assign(0);unit(id,U.UCLOAK_WAIT).assign(15);});
          If(mode.equal(int(1)),()=>{
            const visual=stage.mul(int(256)).div(int(38));
            If(visual.greaterThanEqual(int(64)).and(visual.lessThan(int(128))).and(health.lessThan(int(64))).and(pick(id,461,3).equal(int(0))),()=>{unit(id,U.UCLOAK).assign(3);}).ElseIf(stage.greaterThanEqual(int(38)),()=>{
              unit(id,U.UCLOAK).assign(2);unit(id,U.UCLOAK_EVENT).assign(clock.element(0).add(int(1)).mul(int(8)).add(int(1)));
              If(unit(id,U.UOWNER).notEqual(battle.humanOwner),()=>{
                const cell=unit(id,U.UCELL),first=unit(id,U.UFACE).add(int(16)).bitAnd(int(255)).div(int(32));
                Loop(8,({i})=>{
                  const dir=first.add(int(i)).bitAnd(int(7));
                  If(data.element(cell.add(edgeBase)).bitAnd(int(1).shiftLeft(dir)).notEqual(int(0)),()=>{
                    const next=cell.add(data.element(dir.mul(int(2)).add(directionBase))).add(data.element(dir.mul(int(2)).add(directionBase+1)).mul(int(w))),free=int(1).toVar();
                    for(let slot=0;slot<5;slot++){
                      const other=occupied.element(next.mul(int(5)).add(slot));
                      If(other.notEqual(int(0)).and(other.notEqual(id.add(int(1)))),()=>{
                        // UNIT.CPP Can_Enter_Cell permits crushing hostile infantry.
                        If(unit(other.sub(1),U.UKIND).equal(int(0)).or(unit(other.sub(1),U.UOWNER).equal(unit(id,U.UOWNER))),()=>{free.assign(0);});
                      });
                    }
                    If(free.notEqual(int(0)),()=>{goals.element(id).assign(next);unit(id,U.USCATTER_GOAL).assign(next.add(1));});
                  });
                });
                unit(id,U.UROUTE).assign(-1);unit(id,U.USTALLED).assign(0);paths.element(id).assign(-1);
              });
            });
          });
        });
      });
    })().compute(count);
    this.contacts=Fn(()=>{
      const id=int(instanceIndex);
      If(alive(id),()=>{
        If(unit(id,U.UCLOAK).equal(int(2)).and(unit(id,U.UOVERRUN_CELL).greaterThanEqual(int(0))),()=>{
          const cell=unit(id,U.UOVERRUN_CELL);
          for(const [dx,dy] of directions){
            const x=cell.mod(int(w)).add(dx),y=cell.div(int(w)).add(dy);
            If(x.greaterThanEqual(int(0)).and(x.lessThan(int(w))).and(y.greaterThanEqual(int(0))).and(y.lessThan(int(h))),()=>{
              for(let slot=0;slot<5;slot++){
                const other=occupied.element(y.mul(int(w)).add(x).mul(int(5)).add(slot)).sub(int(1));
                If(other.greaterThanEqual(int(0)),()=>{If(unit(other,U.UHEALTH).greaterThan(int(0)).and(unit(other,U.UOWNER).notEqual(unit(id,U.UOWNER))).and(data.element(unit(other,U.UTYPE).mul(int(2)).add(int(1))).notEqual(int(0))),()=>{unit(id,U.UCLOAK).assign(1);unit(id,U.UCLOAK_STAGE).assign(19);});});
              }
            });
          }
        });
        const target=state(id,C.CTARGET);
        If(unit(id,U.UCLOAK).equal(int(1)).or(unit(id,U.UCLOAK).equal(int(2))).and(target.notEqual(int(-1))).and(state(id,C.CARM).equal(int(0))).and(state(id,C.CAMMO).notEqual(int(0))),()=>{
          If(inRange(id,target),()=>{
            this.uncloak(id);
          });
        });
      });
    })().compute(count);
  }
  dispose(){this.battle.movement.mapObservers.delete(this.mapChanged);this.advance.dispose();this.contacts.dispose();releaseStorage(this.battle.renderer,[this.data]);}
}
