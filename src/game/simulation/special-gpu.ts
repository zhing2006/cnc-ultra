// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { alliedOwners } from './alliances.ts';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, int, instanceIndex, ivec2, storage } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { GpuTaskMask } from '../../engine/simulation/task-mask.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { canCaptureBuilding } from '../data/abilities.ts';
import { MOVEMENT,movementType } from '../data/movement.ts';
import { combatTypes, weapons } from '../data/combat.ts';
import type { GpuCombat } from './combat-gpu.ts';
import { unitDirection, unitDistance } from './units-nodes.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
type I=Node<'int'>;

export class GpuSpecialInfantry {
  readonly before:ComputeNode[];
  readonly after:ComputeNode[];
  private readonly constants:StorageBufferAttribute;
  private readonly completed:GpuTaskMask;
  private readonly mapChanged:(edges:Uint32Array)=>void;
  constructor(private readonly battle:GpuCombat){
    const m=battle.movement,count=battle.setup.units.length,w=battle.setup.grid.width,h=battle.setup.grid.height;
    const rows=MOVEMENT.flatMap((type,i)=>{const shape=BUILDINGS.get(type.name),row=new Array(36).fill(0);row[0]=Number(canCaptureBuilding(type.name,battle.setup.campaignLevel));row[1]=shape?.occupy.length??0;row[2]=weapons[combatTypes[i].primary]?.rof??0;shape?.occupy.forEach(([x,y],index)=>{row[4+index*2]=x;row[5+index*2]=y;});return row;});
    const edgeBase=rows.length;
    this.constants=new StorageBufferAttribute(Int32Array.from([...rows,...battle.setup.grid.edges]),1);
    this.mapChanged=edges=>{(this.constants.array as Int32Array).set(edges,edgeBase);this.constants.addUpdateRange(edgeBase,edges.length);this.constants.needsUpdate=true;};
    m.mapObservers.add(this.mapChanged);
    const data=storage(this.constants,'int',this.constants.count).toReadOnly(),u=storage(m.units,'int',m.units.count),c=storage(battle.state,'int',battle.state.count);
    const relations=storage(m.actorIndex.buffer,'uint',m.actorIndex.buffer.count).toReadOnly();
    const goals=storage(m.goals,'int',m.goals.count),paths=storage(m.pathGoals,'int',m.pathGoals.count),occupied=storage(m.occupancy,'int',m.occupancy.count).toReadOnly(),clock=storage(m.control,'int',m.control.count).toReadOnly();
    const unit=(id:I,field:number)=>u.element(id.mul(U.WORDS).add(field)),state=(id:I,field:number)=>c.element(id.mul(C.CWORDS).add(field));
    const direct=(id:I,cell:I)=>{
      const point=ivec2(cell.mod(w).mul(256).add(128),cell.div(w).mul(256).add(128)),face=unitDirection(ivec2(unit(id,U.UX),unit(id,U.UY)),point);
      unit(id,U.UDEST).assign(cell);unit(id,U.UHEAD_X).assign(point.x);unit(id,U.UHEAD_Y).assign(point.y);unit(id,U.UDSLOT).assign(0);
      unit(id,U.UFACE).assign(face);unit(id,U.UDESIRED).assign(face);unit(id,U.USPEED).assign(255);goals.element(id).assign(cell);paths.element(id).assign(U.DIRECT_STEP);
    };
    const approach=Fn(()=>{
      const id=int(instanceIndex),mode=unit(id,U.UABILITY_MODE).toVar(),target=unit(id,U.UABILITY_TARGET).sub(1).toVar();
      If(mode.greaterThan(0).and(unit(id,U.UHEALTH).greaterThan(0)).and(unit(id,U.UATTACHED).equal(0)),()=>{
        const valid=int(0).toVar(),transport=int(0).toVar();
        If(target.greaterThanEqual(0),()=>{
          transport.assign(int(unit(target,U.UTYPE).equal(movementType('TRAN')).and(unit(target,U.UALTITUDE).equal(0)).and(mode.mod(2).equal(1)).and(relations.element(target.add(m.actorIndex.cargoCount)).equal(0))));
          valid.assign(int(unit(target,U.UHEALTH).greaterThan(0).and(transport.notEqual(0).or(unit(target,U.UDOMAIN).equal(2).and(mode.mod(2).equal(0).or(data.element(unit(target,U.UTYPE).mul(36)).notEqual(0)))))));
        });
        If(valid.equal(0),()=>{unit(id,U.UABILITY_MODE).assign(0);unit(id,U.UABILITY_TARGET).assign(0);goals.element(id).assign(-1);paths.element(id).assign(-1);}).ElseIf(mode.lessThan(3),()=>{
          If(unit(id,U.UABILITY_ENTRY).equal(0).or(unit(id,U.UWAIT).greaterThan(30)).or(transport.notEqual(0).and(unit(id,U.UABILITY_ENTRY).notEqual(unit(target,U.UCELL).add(1)))),()=>{
            const score=int(0x7fffffff).toVar(),entry=int(-1).toVar(),origin=int(-1).toVar(),base=unit(target,U.UTYPE).mul(36);
            const cells=data.element(base.add(1)).toVar();If(transport.notEqual(0),()=>{cells.assign(1);});
            Loop({start:int(0),end:cells,type:'int',condition:'<'},({i})=>{
              const destination=unit(target,U.UORIGIN).add(data.element(base.add(i.mul(2)).add(4))).add(data.element(base.add(i.mul(2)).add(5)).mul(w)).toVar();
              If(transport.notEqual(0),()=>{destination.assign(unit(target,U.UCELL));});
              for(const [ox,oy] of [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]]){
                const x=destination.mod(w).add(ox),y=destination.div(w).add(oy),cell=y.mul(w).add(x);
                If(x.greaterThanEqual(0).and(x.lessThan(w)).and(y.greaterThanEqual(0)).and(y.lessThan(h)),()=>{
                  If(data.element(cell.add(edgeBase)).notEqual(0),()=>{
                    const free=int(0).toVar();for(let slot=0;slot<5;slot++){const occupant=occupied.element(cell.mul(5).add(slot));If(occupant.equal(0).or(occupant.equal(id.add(1))),()=>{free.assign(1);});}
                    const distance=unitDistance(ivec2(unit(id,U.UX),unit(id,U.UY)),ivec2(x.mul(256).add(128),y.mul(256).add(128)));
                    If(free.notEqual(0).and(distance.lessThan(score)),()=>{score.assign(distance);origin.assign(cell);entry.assign(destination);});
                  });
                });
              }
            });
            If(origin.greaterThanEqual(0),()=>{unit(id,U.UABILITY_ENTRY).assign(entry.add(1));unit(id,U.UABILITY_ORIGIN).assign(origin.add(1));goals.element(id).assign(origin);paths.element(id).assign(-1);});
          });
          If(unit(id,U.UABILITY_ENTRY).greaterThan(0).and(unit(id,U.UCELL).equal(unit(id,U.UABILITY_ORIGIN).sub(1))).and(unit(id,U.UDEST).lessThan(0)),()=>{direct(id,unit(id,U.UABILITY_ENTRY).sub(1));unit(id,U.UABILITY_MODE).addAssign(2);});
        });
      });
    })().compute(count);
    this.completed=new GpuTaskMask(battle.renderer,count);
    const collect=Fn(()=>{const id=int(instanceIndex);If(unit(id,U.UABILITY_MODE).greaterThanEqual(3).and(unit(id,U.UHEALTH).greaterThan(0)).and(unit(id,U.UDEST).lessThan(0)).and(unit(id,U.UCELL).equal(unit(id,U.UABILITY_ENTRY).sub(1))),()=>{this.completed.add(id);});})().compute(count);
    const finish=Fn(()=>{this.completed.forEach(id=>{
      const target=unit(id,U.UABILITY_TARGET).sub(1).toVar(),mode=unit(id,U.UABILITY_MODE).toVar();
      If(target.greaterThanEqual(0),()=>{If(unit(target,U.UHEALTH).greaterThan(0),()=>{
        If(mode.equal(3),()=>{
          If(alliedOwners(battle.setup,unit(id,U.UOWNER),unit(target,U.UOWNER)).not(),()=>{
            unit(target,U.UOWNER).assign(unit(id,U.UOWNER));unit(target,U.UCAPTURE_TICK).assign(clock.element(0));state(target,C.CTARGET).assign(-1);state(target,C.CMISSION).assign(C.GUARD);
          });
          unit(id,U.UHEALTH).assign(0);goals.element(id).assign(-1);paths.element(id).assign(-1);
        }).Else(()=>{
          unit(target,U.UBOMB_TICK).assign(clock.element(0).add(20));unit(target,U.UBOMB_SOURCE).assign(id.add(1));state(id,C.CARM).assign(data.element(unit(id,U.UTYPE).mul(36).add(2)));
          direct(id,unit(id,U.UABILITY_ORIGIN).sub(1));
        });
      });});
      unit(id,U.UABILITY_MODE).assign(0);unit(id,U.UABILITY_TARGET).assign(0);
    });})().compute(1);
    const attachments=Fn(()=>{
      const id=int(instanceIndex),parent=unit(id,U.UATTACHED).sub(1);
      If(parent.greaterThanEqual(0),()=>{If(unit(parent,U.UCAPTURE_TICK).equal(clock.element(0)),()=>{unit(id,U.UOWNER).assign(unit(parent,U.UOWNER));});});
      // TECHNO.CPP Captured / Detach: projectiles keep their targets, actors do not.
      const suspended=state(id,C.CSUSPENDED_TARGET).toVar();
      If(state(id,C.CSUSPENDED_MISSION).notEqual(0).and(suspended.greaterThanEqual(0)),()=>{
        If(unit(suspended,U.UCAPTURE_TICK).equal(clock.element(0)),()=>{state(id,C.CSUSPENDED_MISSION).assign(0);state(id,C.CSUSPENDED_TARGET).assign(-1);});
      });
      const target=state(id,C.CTARGET).toVar();
      If(target.greaterThanEqual(0),()=>{If(unit(target,U.UCAPTURE_TICK).equal(clock.element(0)),()=>{
        state(id,C.CTARGET).assign(-1);state(id,C.CFIRE).assign(-1);goals.element(id).assign(-1);paths.element(id).assign(-1);
        unit(id,U.UROUTE).assign(-1);unit(id,U.UWAIT).assign(0);unit(id,U.URETRIES).assign(10);unit(id,U.USTALLED).assign(0);
        state(id,C.CLOCAL_ROUTE).assign(0);state(id,C.CLOCAL_WAIT).assign(0);state(id,C.CROUTE_LENGTH).assign(0);
        state(id,C.CLOCAL_DEST).assign(-1);state(id,C.CAPPROACH_GOAL).assign(-1);state(id,C.CSCAN).assign(0);
        If(state(id,C.CSUSPENDED_MISSION).notEqual(0),()=>{
          state(id,C.CMISSION).assign(state(id,C.CSUSPENDED_MISSION).sub(1));state(id,C.CTARGET).assign(state(id,C.CSUSPENDED_TARGET));
          goals.element(id).assign(state(id,C.CSUSPENDED_GOAL));unit(id,U.UABILITY_MODE).assign(state(id,C.CSUSPENDED_ABILITY));state(id,C.CSUSPENDED_MISSION).assign(0);
        });
      });});
    })().compute(count);
    this.before=[approach];this.after=[this.completed.clear,collect,finish,attachments];
  }
  dispose(){this.battle.movement.mapObservers.delete(this.mapChanged);for(const pass of [...this.before,...this.after])if(pass!==this.completed.clear)pass.dispose();this.completed.dispose();releaseStorage(this.battle.renderer,[this.constants]);}
}
