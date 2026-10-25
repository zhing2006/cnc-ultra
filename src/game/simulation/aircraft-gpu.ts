// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, Break, int, uint, storage, instanceIndex, ivec2 } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { intMin, intMax, randomNode } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { movePoint } from '../coord.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { unitDistance, unitDirection, unitRotate } from './units-nodes.ts';
import { computeFunction } from '../../engine/simulation/compute-function.ts';
import { initialAircraft, AIR_WORDS, ASTAGE, ADELAY, ASPEED, AACCUM, AFACING, ADESIRED, AGOAL, ATAKEOFF, ALANDING,
  AGENERATION,AHOVER,ACONTACT,ATARGET,AFIRED,ARETREAT } from './aircraft-cpu.ts';
import type { GpuUnits } from './units-gpu.ts';
import * as U from './units-state.ts';
type I=Node<'int'>;

/** AIRCRAFT.CPP movement state machine and FLY.CPP integer flight physics. */
export class GpuAircraft {
  readonly state:StorageBufferAttribute;
  readonly kernels:ComputeNode[];
  private readonly attributes:StorageBufferAttribute[]=[];
  constructor(readonly movement:GpuUnits) {
    const {setup}=movement,count=setup.units.length,width=setup.grid.width,height=setup.grid.height;
    const keep=(array:Int32Array)=>{const b=new StorageBufferAttribute(array,1);this.attributes.push(b);return b;};
    this.state=keep(initialAircraft(setup));
    const u=storage(movement.units,'int',movement.units.count),goals=storage(movement.goals,'int',count);
    const states=storage(this.state,'int',this.state.count);
    const index=movement.actorIndex,locations=storage(index.buffer,'uint',index.buffer.count).toReadOnly();
    const occupancy=storage(movement.occupancy,'uint',movement.occupancy.count).toReadOnly();
    const clock=storage(movement.control,'int',2).toReadOnly();
    const values=[...MOVEMENT.flatMap(type=>[type.speed,type.rotation]),...Array.from({length:256},(_,dir)=>movePoint(0,0,dir,128)).flat(),...Array.from(setup.passable??setup.grid.edges)];
    const constants=keep(Int32Array.from(values));
    const data=storage(constants,'int',values.length).toReadOnly();
    const trig=MOVEMENT.length*2,open=trig+512;
    movement.mapObservers.add((_edges,passable)=>{(constants.array as Int32Array).set(passable,open);constants.needsUpdate=true;});
    const unit=(id:I,field:number)=>u.element(id.mul(U.WORDS).add(field));
    const state=(id:I,field:number)=>states.element(id.mul(AIR_WORDS).add(field));
    const point=(cell:I)=>ivec2(cell.mod(width).mul(256).add(128),cell.div(width).mul(256).add(128));
    const goalPoint=(id:I,cell:I)=>{
      const result=point(cell).toVar(),contact=state(id,ACONTACT).toVar();
      If(contact.greaterThanEqual(0),()=>{const origin=unit(contact,U.UORIGIN);result.assign(ivec2(origin.mod(width).mul(256).add(256),origin.div(width).mul(256).add(192)));
        If(unit(contact,U.UTYPE).equal(movementType('FIX')),()=>{result.assign(ivec2(unit(contact,U.UX),unit(contact,U.UY)));});});return result;
    };
    const position=(id:I)=>ivec2(unit(id,U.UX),unit(id,U.UY));
    const move=(pos:Node<'ivec2'>,dir:I,length:I)=>{
      const at=dir.bitAnd(255).mul(2).add(trig);
      return pos.add(ivec2(data.element(at).mul(length).shiftRight(7),data.element(at.add(1)).negate().mul(length).shiftRight(7).negate()));
    };
    const inside=(p:Node<'ivec2'>)=>p.x.greaterThanEqual(0).and(p.y.greaterThanEqual(0)).and(p.x.lessThan(width*256)).and(p.y.lessThan(height*256));
    const cellAt=(p:Node<'ivec2'>)=>p.y.div(256).mul(width).add(p.x.div(256));
    const clear=computeFunction(([id,cell]:[I,I])=>{
      const free=int(1).toVar();
      If(cell.lessThan(0).or(cell.greaterThanEqual(width*height)),()=>{free.assign(0);}).Else(()=>{
        If(data.element(cell.add(open)).equal(0).and(state(id,ACONTACT).lessThan(0)),()=>{free.assign(0);});
        Loop(5,({i})=>{const owner=occupancy.element(cell.mul(5).add(i));If(owner.notEqual(uint(0)).and(owner.notEqual(uint(id.add(1)))).and(owner.notEqual(uint(state(id,ACONTACT).add(1)))),()=>{free.assign(0);});});
        const occupants=locations.element(cell.add(index.airCount)),first=locations.element(cell.add(index.airMin)),goal=locations.element(cell.add(index.goalMin));
        If(occupants.greaterThan(1).or(occupants.equal(1).and(first.notEqual(uint(id)))).or(goal.lessThan(uint(id))),()=>{free.assign(0);});
      });
      return free.notEqual(0).or(state(id,AHOVER).notEqual(0));
    },{name:'aircraftClear',type:'bool',inputs:[{name:'actor_id',type:'int'},{name:'cell',type:'int'}]});
    const landingZone=computeFunction(([id,target]:[I,I])=>{
      const result=target.toVar(),found=int(0).toVar();
      If(clear(id,target).not(),()=>{
        Loop(16,({i:radius})=>{
          const offset=int(randomNode(uint(setup.seed),uint(clock.element(0).add(1)),uint(id.add(0)),uint(int(radius).add(150))).mod(uint(8))).toVar();
          Loop(8,({i:facing})=>{
            const pos=move(point(target),int(facing).add(offset).bitAnd(7).mul(32),int(radius).mul(256)).toVar();
            If(inside(pos),()=>{const cell=cellAt(pos).toVar();If(clear(id,cell),()=>{result.assign(cell);found.assign(1);Break();});});
          });
          If(found.notEqual(0),()=>{Break();});
        });
      });
      return result;
    },{name:'aircraftLandingZone',type:'int',inputs:[{name:'actor_id',type:'int'},{name:'target_cell',type:'int'}]});
    const advance=Fn(()=>{
      const id=int(instanceIndex);
      If(unit(id,U.UDOMAIN).equal(1).and(unit(id,U.UHEALTH).greaterThan(0)),()=>{
        If(state(id,AGENERATION).notEqual(unit(id,U.UGENERATION)),()=>{
          Loop(AIR_WORDS,({i})=>{states.element(id.mul(AIR_WORDS).add(i)).assign(0);});
          state(id,AGENERATION).assign(unit(id,U.UGENERATION));state(id,AGOAL).assign(-1);state(id,ACONTACT).assign(-1);state(id,ATARGET).assign(-1);state(id,AFIRED).assign(-1);
          state(id,AFACING).assign(unit(id,U.UFACE));state(id,ADESIRED).assign(unit(id,U.UFACE));
        });
        If(unit(id,U.UTYPE).notEqual(movementType('C17')),()=>{
        const goal=goals.element(id).toVar(),type=unit(id,U.UTYPE).mul(2).toVar(),altitude=unit(id,U.UALTITUDE).toVar();
        If(goal.lessThan(0).and(state(id,AGOAL).greaterThanEqual(0)).and(state(id,AHOVER).equal(0)).and(altitude.greaterThan(0)),()=>{
          goal.assign(landingZone(id,unit(id,U.UCELL)));goals.element(id).assign(goal);state(id,ACONTACT).assign(-1);state(id,ATAKEOFF).assign(0);state(id,ALANDING).assign(0);
        });
        If(goal.notEqual(state(id,AGOAL)),()=>{state(id,AGOAL).assign(goal);state(id,ASTAGE).assign(0);state(id,ADELAY).assign(0);});
        If(state(id,ADELAY).greaterThan(0),()=>{state(id,ADELAY).subAssign(1);});
        If(state(id,ARETREAT).notEqual(0),()=>{
          state(id,ALANDING).assign(0);state(id,ATAKEOFF).assign(int(altitude.lessThan(24)));state(id,ASPEED).assign(0);
          If(altitude.greaterThanEqual(24),()=>{state(id,ASPEED).assign(255);state(id,ADESIRED).assign(state(id,ARETREAT).sub(1));unit(id,U.UDESIRED).assign(state(id,ARETREAT).sub(1));})
            .ElseIf(altitude.greaterThanEqual(20),()=>{state(id,ASPEED).assign(64);}).ElseIf(altitude.greaterThanEqual(16),()=>{state(id,ASPEED).assign(32);});
        });
        If(goal.greaterThanEqual(0).and(state(id,ADELAY).equal(0)),()=>{
          state(id,ADELAY).assign(1);
          If(state(id,ASTAGE).equal(0),()=>{
            If(clear(id,goal),()=>{state(id,ASTAGE).assign(1);}).Else(()=>{goal.assign(landingZone(id,goal));goals.element(id).assign(goal);state(id,AGOAL).assign(goal);});
            state(id,ADELAY).assign(15);
          }).ElseIf(state(id,ASTAGE).equal(1),()=>{
            state(id,ALANDING).assign(0);state(id,ATAKEOFF).assign(1);
            If(altitude.equal(0),()=>{state(id,AFACING).assign(unit(id,U.UFACE));state(id,ADESIRED).assign(unit(id,U.UFACE));});
            If(altitude.equal(12),()=>{state(id,ADESIRED).assign(unitDirection(position(id),goalPoint(id,goal)));});
            If(altitude.equal(16),()=>{unit(id,U.UDESIRED).assign(state(id,ADESIRED));state(id,ASPEED).assign(32);});
            If(altitude.equal(20),()=>{state(id,ASPEED).assign(64);});
            If(altitude.equal(24),()=>{state(id,ASPEED).assign(255);state(id,ATAKEOFF).assign(0);state(id,ASTAGE).assign(2);});
          }).ElseIf(state(id,ASTAGE).equal(2),()=>{
            If(clear(id,goal).not(),()=>{goal.assign(landingZone(id,goal));goals.element(id).assign(goal);state(id,AGOAL).assign(goal);}).Else(()=>{
              const d=unitDistance(position(id),goalPoint(id,goal)).toVar();
              state(id,ADESIRED).assign(unitDirection(position(id),goalPoint(id,goal)));
              state(id,ASPEED).assign(intMax(int(32),intMin(int(255),intMin(d,int(768)).div(3))));
              If(d.lessThan(16),()=>{state(id,ASPEED).assign(0);If(state(id,AHOVER).notEqual(0),()=>{goals.element(id).assign(-1);state(id,AGOAL).assign(-1);}).Else(()=>{state(id,ASTAGE).assign(3);});});
              If(state(id,AHOVER).notEqual(0).and(state(id,ATARGET).greaterThanEqual(0)).and(d.lessThan(512)),()=>{unit(id,U.UDESIRED).assign(unitDirection(position(id),position(state(id,ATARGET))));})
                .ElseIf(d.lessThan(128),()=>{unit(id,U.UDESIRED).assign(32);If(unit(id,U.UTYPE).equal(movementType('TRAN')),()=>{unit(id,U.UDESIRED).assign(0);});}).Else(()=>{unit(id,U.UDESIRED).assign(state(id,ADESIRED));});
            });
          }).Else(()=>{
            state(id,ATAKEOFF).assign(0);state(id,ALANDING).assign(1);
            If(altitude.equal(12),()=>{state(id,ASPEED).assign(0);});
            If(altitude.equal(0),()=>{state(id,ALANDING).assign(0);goals.element(id).assign(-1);state(id,AGOAL).assign(-1);});
          });
        });
        state(id,AFACING).assign(unitRotate(state(id,AFACING),state(id,ADESIRED),data.element(type.add(1))));
        unit(id,U.UFACE).assign(unitRotate(unit(id,U.UFACE),unit(id,U.UDESIRED),data.element(type.add(1))));
        const add=data.element(type).mul(state(id,ASPEED)).add(128).shiftRight(8).toVar();
        If(add.notEqual(0),()=>{
          const total=add.add(state(id,AACCUM)).toVar(),length=total.sub(total.mod(10)).toVar();state(id,AACCUM).assign(total.mod(10));
          const p=move(position(id),state(id,AFACING),length).toVar();If(inside(p),()=>{unit(id,U.UX).assign(p.x);unit(id,U.UY).assign(p.y);});
          const bounds=setup.bounds??{x:0,y:0,width:setup.grid.width,height:setup.grid.height};
          If(state(id,ARETREAT).notEqual(0).and(p.x.lessThan(bounds.x*256).or(p.y.lessThan(bounds.y*256)).or(p.x.greaterThanEqual((bounds.x+bounds.width)*256)).or(p.y.greaterThanEqual((bounds.y+bounds.height)*256))),()=>{unit(id,U.UHEALTH).assign(0);});
        });
        const wasHigh=unit(id,U.UALTITUDE).greaterThanEqual(16).toVar();
        If(unit(id,U.UDOOR).equal(0),()=>{
          If(state(id,ALANDING).notEqual(0),()=>{unit(id,U.UALTITUDE).assign(intMax(int(0),unit(id,U.UALTITUDE).sub(1)));If(unit(id,U.UALTITUDE).equal(0),()=>{state(id,ALANDING).assign(0);state(id,ASPEED).assign(0);});});
          If(state(id,ATAKEOFF).notEqual(0),()=>{unit(id,U.UALTITUDE).assign(intMin(int(24),unit(id,U.UALTITUDE).add(1)));If(unit(id,U.UALTITUDE).equal(24),()=>{state(id,ATAKEOFF).assign(0);});});
        });
        unit(id,U.UCELL).assign(cellAt(position(id)));
        If(wasHigh.and(unit(id,U.UALTITUDE).lessThan(16)).and(clear(id,unit(id,U.UCELL)).not()),()=>{
          unit(id,U.UALTITUDE).addAssign(1);state(id,ALANDING).assign(0);state(id,ATAKEOFF).assign(1);state(id,ASTAGE).assign(1);
          const target=goal.toVar();If(target.lessThan(0),()=>{target.assign(unit(id,U.UCELL));});
          goals.element(id).assign(landingZone(id,target));state(id,AGOAL).assign(goals.element(id));
        });
        });
      });
    })().compute(count);
    this.kernels=[...index.kernels,advance];
  }
  step(){this.movement.renderer.compute(this.kernels);this.movement.refreshOccupancy();}
  dispose(){this.kernels.at(-1)!.dispose();releaseStorage(this.movement.renderer,this.attributes);}
}
