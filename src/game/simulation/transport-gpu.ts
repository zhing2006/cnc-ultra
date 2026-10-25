// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute,type ComputeNode,type Node } from 'three/webgpu';
import { Fn,If,Break,Continue,int,uint,storage,ivec2,select,instanceIndex,atomicAdd,atomicLoad,atomicStore,abs } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { randomNode } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { computeFunction } from '../../engine/simulation/compute-function.ts';
import { GpuTaskMask } from '../../engine/simulation/task-mask.ts';
import { MOVEMENT,GROUND_SPEED,movementType } from '../data/movement.ts';
import { movePoint } from '../coord.ts';
import { unitDirection,unitDistance,unitRotate } from './units-nodes.ts';
import { AIR_WORDS,AACCUM,AFACING,ADESIRED,ASPEED,AGENERATION,AGOAL,ACONTACT,ATARGET,AFIRED,ARETREAT } from './aircraft-cpu.ts';
import { TBASE,TWORDS,TMODE,TTIMER,TLAST,TGEN,TORDER,TRESERVED,TCONTACT,TLOCKED,APC_LOAD_FACING,LOAD_DIRECTIONS,UNLOAD_DIRECTIONS,TRANSPORT_DIRECTIONS,AIRSTRIP_EXITS,initialTransport } from './transport-cpu.ts';
import type { GpuCombat } from './combat-gpu.ts';
import type { GpuAircraft } from './aircraft-gpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
type I=Node<'int'>;
const TOLDENTER=8,TADDED=9,TREMOVED=10,TINITIAL=11,TDROP=12,TFACTORY=13,TREFUND=14,TDELIVER=15;

/** Ordered boarding/unloading and the original C-17 delivery mission. */
export class GpuTransport {
  readonly state:StorageBufferAttribute;
  readonly kernels:ComputeNode[];
  private readonly constants:StorageBufferAttribute;
  private readonly ownsState:boolean;
  private readonly attachments:GpuTaskMask;
  constructor(readonly battle:GpuCombat,readonly aircraft:GpuAircraft|undefined,playable:ArrayLike<number>,state?:StorageBufferAttribute){
    const count=battle.setup.units.length,width=battle.setup.grid.width,height=battle.setup.grid.height,cells=playable.length;
    const bounds=battle.setup.bounds??{x:0,y:0,width,height};
    this.attachments=new GpuTaskMask(battle.renderer,count);
    const index=battle.movement.actorIndex;index.setPlayable(playable);
    const relations=storage(index.buffer,'uint',index.buffer.count),atomicRelations=storage(index.buffer,'uint',index.buffer.count).toAtomic();
    this.ownsState=!state;this.state=state??new StorageBufferAttribute(initialTransport(count),1);
    const open=MOVEMENT.length,area=open+cells,directions=area+cells,load=directions+16,unload=load+8,exits=unload+8,trig=exits+32,apcFaces=trig+512,foot=apcFaces+8;
    const values=[...MOVEMENT.map(t=>t.cost),...Array.from(battle.setup.passable??battle.setup.grid.edges),...Array.from(playable),
      ...TRANSPORT_DIRECTIONS.flat(),...LOAD_DIRECTIONS,...UNLOAD_DIRECTIONS,...AIRSTRIP_EXITS.flat(),...Array.from({length:256},(_,d)=>movePoint(0,0,d,128)).flat(),...APC_LOAD_FACING,...Array.from(battle.setup.land,land=>GROUND_SPEED[land][0])];
    this.constants=new StorageBufferAttribute(Int32Array.from(values),1);
    battle.movement.mapObservers.add((_edges,passable,land)=>{(this.constants.array as Int32Array).set(Array.from(land,v=>GROUND_SPEED[v][0]),foot);this.constants.addUpdateRange(foot,cells);(this.constants.array as Int32Array).set(passable,open);this.constants.addUpdateRange(open,cells);this.constants.needsUpdate=true;});
    const data=storage(this.constants,'int',values.length).toReadOnly();
    const u=storage(battle.units,'int',battle.units.count),c=storage(battle.state,'int',battle.state.count);
    const t=storage(this.state,'int',this.state.count),air=storage(aircraft?.state??this.state,'int',(aircraft?.state??this.state).count);
    const goals=storage(battle.movement.goals,'int',count),paths=storage(battle.movement.pathGoals,'int',count),pending=storage(battle.movement.pending,'int',count*2);
    const occupancy=storage(battle.movement.occupancy,'uint',cells*5).toReadOnly();
    const unit=(id:I,field:number)=>u.element(id.mul(U.WORDS).add(field)),combat=(id:I,field:number)=>c.element(id.mul(C.CWORDS).add(field));
    const stateAt=(id:I,field:number)=>t.element(id.mul(TWORDS).add(TBASE+field)),flight=(id:I,field:number)=>air.element(id.mul(AIR_WORDS).add(field));
    const position=(id:I)=>ivec2(unit(id,U.UX),unit(id,U.UY));
    const clearFn=computeFunction(([cell,id,infantry]:[I,I,Node<'bool'>])=>{
      const yes=int(0).toVar();
      If(cell.greaterThanEqual(int(0)).and(cell.lessThan(int(cells))),()=>{
        If(data.element(cell.add(open)).notEqual(0).and(data.element(cell.add(area)).notEqual(0)),()=>{
          const free=int(0).toVar();Loop(5,({i})=>{const owner=occupancy.element(cell.mul(5).add(i));If(owner.equal(uint(0)).or(owner.equal(uint(id.add(1)))),()=>{free.addAssign(1);});});
          yes.assign(int(free.equal(5).or(infantry.and(free.greaterThan(0)))));
        });
      });return yes.notEqual(0);
    },{name:'transportCellClear',type:'bool',inputs:[{name:'cell',type:'int'},{name:'actor',type:'int'},{name:'infantry',type:'bool'}]});
    const clear=(cell:I,id:I,infantry:Node<'bool'>=int(0).notEqual(0))=>clearFn(cell,id,infantry);
    const adjacent=(cell:I,dir:I)=>{
      const x=cell.mod(width).add(data.element(dir.mul(2).add(directions))),y=cell.div(width).add(data.element(dir.mul(2).add(directions+1)));
      return int(select(x.greaterThanEqual(int(0)).and(x.lessThan(int(width))).and(y.greaterThanEqual(int(0))).and(y.lessThan(int(height))),y.mul(width).add(x),int(-1)));
    };
    const isCarrier=(id:I)=>unit(id,U.UTYPE).equal(movementType('TRAN')).or(unit(id,U.UTYPE).equal(movementType('APC')));
    const apcClear=computeFunction(([cell,id]:[I,I])=>{
      const yes=int(clear(cell,id,int(1).equal(1))).toVar();
      If(yes.notEqual(0),()=>{
        If(data.element(cell.add(foot)).equal(0),()=>{yes.assign(0);});
        Loop(5,({i})=>{const owner=int(occupancy.element(cell.mul(5).add(i))).sub(1);If(owner.greaterThanEqual(0),()=>{If(unit(owner,U.UOWNER).notEqual(unit(id,U.UOWNER)),()=>{yes.assign(0);});});});
      });return yes.notEqual(0);
    },{name:'apcCellClear',type:'bool',inputs:[{name:'cell',type:'int'},{name:'actor',type:'int'}]});
    // Ported from UNIT.CPP, Desired_Load_Dir. Only eight neighboring cells are examined.
    const apcDirection=computeFunction(([id,passenger]:[I,I])=>{
      const faceto=unit(id,U.UFACE).add(128).bitAnd(255).toVar();
      If(passenger.greaterThanEqual(0),()=>{faceto.assign(unitDirection(position(id),position(passenger)));});
      const best=int(-1).toVar(),direction=int(-1).toVar();
      Loop(8,({i:d})=>{
        const cell=adjacent(unit(id,U.UCELL),d).toVar(),actor=int(select(passenger.lessThan(0),id,passenger));
        const allowed=apcClear(cell,actor).toVar();If(passenger.greaterThanEqual(0),()=>{If(cell.equal(unit(passenger,U.UCELL)),()=>{allowed.assign(true);});});
        const value=select(allowed,int(128),int(-128)).sub(abs(d.mul(32).sub(faceto).add(128).bitAnd(255).sub(128)))
          .add(select(d.equal(4),int(-100),select(d.equal(3).or(d.equal(5)),int(64),int(0))));
        If(best.equal(-1).or(value.greaterThan(best)),()=>{best.assign(value);direction.assign(d);});
      });return int(select(best.greaterThan(0),direction,int(-1)));
    },{name:'apcDesiredLoadDir',type:'int',inputs:[{name:'carrier',type:'int'},{name:'passenger',type:'int'}]});
    const apcDoorFn=computeFunction(([id,opening]:[I,Node<'bool'>])=>{
      const door=unit(id,U.UDOOR).toVar();
      If(opening.and(door.equal(0).or(door.equal(5))),()=>{unit(id,U.UDOOR).assign(1);stateAt(id,TRESERVED).assign(0);})
        .ElseIf(opening.not().and(door.equal(1).or(door.equal(4))),()=>{unit(id,U.UDOOR).assign(5);stateAt(id,TRESERVED).assign(0);});
      return int(0);
    },{name:'apcSetDoor',type:'int',inputs:[{name:'carrier',type:'int'},{name:'opening',type:'bool'}]});
    const apcDoor=(id:I,opening:Node<'bool'>)=>apcDoorFn(id,opening).toVar();
    const move=(pos:Node<'ivec2'>,dir:I,length:I)=>{const at=dir.bitAnd(255).mul(2).add(trig);return pos.add(ivec2(data.element(at).mul(length).shiftRight(7),data.element(at.add(1)).negate().mul(length).shiftRight(7).negate()));};
    const clock=storage(battle.movement.control,'int',2).toReadOnly();
    const initialize=Fn(()=>{
      const id=int(instanceIndex);
      If(id.equal(0),()=>{t.element(4).assign(clock.element(0).add(1));});
      If(stateAt(id,TGEN).notEqual(unit(id,U.UGENERATION)),()=>{Loop(TWORDS,({i})=>{t.element(id.mul(TWORDS).add(TBASE).add(i)).assign(0);});stateAt(id,TGEN).assign(unit(id,U.UGENERATION));stateAt(id,TLAST).assign(-1);});
      stateAt(id,TOLDENTER).assign(unit(id,U.UENTER));
      const contact=stateAt(id,TCONTACT).sub(1).toVar();
      If(contact.greaterThanEqual(0),()=>{If(unit(contact,U.UHEALTH).lessThanEqual(0).or(unit(contact,U.UENTER).notEqual(id.add(1))).or(pending.element(contact.mul(2)).equal(0)).or(pending.element(contact.mul(2)).equal(1)),()=>{stateAt(id,TCONTACT).assign(0);});});
    })().compute(count);
    const commands=Fn(()=>{const id=int(instanceIndex);Loop(1,()=>{
      const parent=unit(id,U.UATTACHED).sub(1).toVar();If(parent.greaterThanEqual(0),()=>{If(unit(parent,U.UHEALTH).lessThanEqual(0),()=>{unit(id,U.UHEALTH).assign(0);unit(id,U.UATTACHED).assign(0);});});
      If(unit(id,U.UHEALTH).lessThanEqual(0),()=>{Continue();});
      const command=pending.element(id.mul(2)).toVar();
      If(command.equal(0).or(command.equal(1)),()=>{unit(id,U.UENTER).assign(0);If(stateAt(id,TMODE).equal(5).or(unit(id,U.UTYPE).equal(movementType('APC'))),()=>{stateAt(id,TMODE).assign(0);});});
      If(command.equal(5),()=>{If(unit(id,U.UKIND).notEqual(0),()=>{stateAt(id,TLAST).assign(-1);});unit(id,U.UENTER).assign(pending.element(id.mul(2).add(1)).add(1));pending.element(id.mul(2)).assign(-1);combat(id,C.CTARGET).assign(-1);combat(id,C.CMISSION).assign(C.MOVE);});
      If(command.equal(6).and(isCarrier(id)),()=>{stateAt(id,TMODE).assign(1);stateAt(id,TTIMER).assign(0);pending.element(id.mul(2)).assign(-1);If(unit(id,U.UTYPE).equal(movementType('APC')),()=>{goals.element(id).assign(-1);paths.element(id).assign(-1);combat(id,C.CTARGET).assign(-1);combat(id,C.CMISSION).assign(C.GUARD);});If(unit(id,U.UALTITUDE).greaterThan(0),()=>{goals.element(id).assign(unit(id,U.UCELL));});});
    });})().compute(count);
    // INFANTRY.CPP Assign_Destination: approach continues without radio ownership.
    const approach=Fn(()=>{
      const id=int(instanceIndex),target=unit(id,U.UENTER).sub(1);
      If(unit(id,U.UKIND).notEqual(0).and(unit(id,U.UHEALTH).greaterThan(0)).and(unit(id,U.UATTACHED).equal(0)).and(target.greaterThanEqual(0)),()=>{
        If(isCarrier(target).and(unit(target,U.UHEALTH).greaterThan(0)).and(unit(target,U.UOWNER).equal(unit(id,U.UOWNER))),()=>{
          If(stateAt(id,TMODE).notEqual(5).and(stateAt(id,TLAST).notEqual(unit(target,U.UCELL))),()=>{
            goals.element(id).assign(unit(target,U.UCELL));paths.element(id).assign(-1);stateAt(id,TLAST).assign(unit(target,U.UCELL));
          });
        });
      });
    })().compute(count);
    const loading=Fn(()=>{
      const id=int(instanceIndex),old=stateAt(id,TOLDENTER).sub(1),current=unit(id,U.UENTER).sub(1);
      If(unit(id,U.UHEALTH).greaterThan(0),()=>{
        If(old.greaterThanEqual(0).and(id.greaterThan(old)),()=>{atomicAdd(atomicRelations.element(old.add(index.transportLoading)),uint(1));});
        If(current.greaterThanEqual(0).and(id.lessThan(current)),()=>{atomicAdd(atomicRelations.element(current.add(index.transportLoading)),uint(1));});
      });
    })().compute(count);
    const board=computeFunction(([id,target,passengers]:[I,I,I])=>{
      const result=int(0).toVar();Loop(1,()=>{
        If(unit(id,U.UHEALTH).lessThanEqual(0).or(unit(id,U.UKIND).equal(0)).or(unit(id,U.UATTACHED).notEqual(0)).or(unit(id,U.UENTER).notEqual(target.add(1))),()=>{Continue();});
          If(unit(target,U.UHEALTH).lessThanEqual(0).or(isCarrier(target).not()).or(unit(target,U.UOWNER).notEqual(unit(id,U.UOWNER))).or(passengers.greaterThanEqual(5)),()=>{unit(id,U.UENTER).assign(0);stateAt(id,TMODE).assign(0);result.assign(2);Continue();});
          If(stateAt(target,TCONTACT).notEqual(0).and(stateAt(target,TCONTACT).notEqual(id.add(1))),()=>{Continue();});
          stateAt(target,TCONTACT).assign(id.add(1));
          If(unit(target,U.UALTITUDE).greaterThan(0).or(goals.element(target).greaterThanEqual(0)),()=>{Continue();});
          If(stateAt(id,TMODE).equal(5),()=>{
            If(unit(id,U.UDEST).lessThan(0).and(unit(id,U.UCELL).equal(unit(target,U.UCELL))),()=>{
              unit(id,U.UATTACHED).assign(target.add(1));unit(id,U.UENTER).assign(0);goals.element(id).assign(-1);paths.element(id).assign(-1);
              stateAt(id,TORDER).assign(t.element(3).add(id).add(1));stateAt(id,TADDED).assign(1);result.assign(3);stateAt(id,TMODE).assign(0);stateAt(target,TCONTACT).assign(0);If(unit(target,U.UTYPE).equal(movementType('APC')).and(passengers.equal(4)),()=>{apcDoor(target,int(0).equal(1));});
            });Continue();
          });
          const destination=int(-1).toVar();
          If(unit(target,U.UTYPE).equal(movementType('APC')),()=>{
            If(unit(target,U.UDEST).greaterThanEqual(0).or(unit(target,U.UFACE).notEqual(unit(target,U.UDESIRED))).or(stateAt(target,TMODE).notEqual(0)),()=>{Continue();});
            const direction=apcDirection(target,id).toVar();If(direction.lessThan(0),()=>{unit(id,U.UENTER).assign(0);stateAt(target,TCONTACT).assign(0);Continue();});
            destination.assign(adjacent(unit(target,U.UCELL),direction));unit(target,U.UDESIRED).assign(data.element(direction.add(apcFaces)));
            apcDoor(target,unit(target,U.UFACE).equal(unit(target,U.UDESIRED)));
          }).Else(()=>{Loop(8,({i})=>{const cell=adjacent(unit(target,U.UCELL),data.element(i.add(load)));If(cell.equal(unit(id,U.UCELL)).or(clear(cell,id)),()=>{destination.assign(cell);Break();});});});
          If(destination.lessThan(0),()=>{Continue();});
          If(destination.notEqual(unit(id,U.UCELL)),()=>{goals.element(id).assign(destination);paths.element(id).assign(-1);})
            .ElseIf(unit(id,U.UDEST).lessThan(0).and(unit(target,U.UDOOR).equal(4)),()=>{
              unit(id,U.UDEST).assign(unit(target,U.UCELL));unit(id,U.UHEAD_X).assign(unit(target,U.UX));unit(id,U.UHEAD_Y).assign(unit(target,U.UY));unit(id,U.UDSLOT).assign(0);
              unit(id,U.UFACE).assign(unitDirection(position(id),position(target)));unit(id,U.UDESIRED).assign(unit(id,U.UFACE));unit(id,U.USPEED).assign(255);
              goals.element(id).assign(unit(target,U.UCELL));paths.element(id).assign(U.DIRECT_STEP);stateAt(id,TMODE).assign(5);
            });
      });return result;
    },{name:'transportBoardPassenger',type:'int',inputs:[{name:'passenger_id',type:'int'},{name:'carrier_id',type:'int'},{name:'cargo_count',type:'int'}]});
    // Each carrier owns its door, contact and cargo. At most one walking contact and five
    // waiting candidates can change; process them around the carrier's stable-ID turn.
    const carrierKernel=(kind:number,mission:(id:I,passengers:I,added:I,loading:I)=>void)=>Fn(()=>{const id=int(instanceIndex);If(unit(id,U.UTYPE).equal(kind).and(unit(id,U.UHEALTH).greaterThan(0)),()=>{
      const passengers=int(relations.element(id.add(index.cargoCount))).toVar(),loading=int(relations.element(id.add(index.transportLoading))).toVar(),added=int(-1).toVar(),originalContact=stateAt(id,TCONTACT).sub(1).toVar();
      stateAt(id,TINITIAL).assign(passengers);
      const process=(before:boolean)=>{
        const previous=int(-1).toVar();Loop(7,()=>{
          const candidate=int(0x7fffffff).toVar();
          Loop(6,({i})=>{const next=int(relations.element(id.mul(6).add(index.enteringFirst).add(i)));If(next.greaterThan(previous).and(next.lessThan(candidate)),()=>{candidate.assign(next);});});
          If(originalContact.greaterThan(previous).and(originalContact.lessThan(candidate)).and(unit(originalContact,U.UENTER).equal(id.add(1))),()=>{candidate.assign(originalContact);});
          If(candidate.equal(0x7fffffff),()=>{Break();});previous.assign(candidate);
          If(before?candidate.lessThan(id):candidate.greaterThan(id),()=>{
            const changed=board(candidate,id,passengers).toVar();
            If(changed.bitAnd(1).notEqual(0),()=>{passengers.addAssign(1);added.assign(candidate);});
            if(before)If(changed.bitAnd(2).notEqual(0),()=>{loading.subAssign(1);});
          });
        });
      };
      process(true);
      mission(id,passengers,added,loading);
      process(false);stateAt(id,TADDED).assign(added.add(1));relations.element(id.add(index.cargoCount)).assign(uint(passengers));
    });})().compute(count);
    const carriers=carrierKernel(movementType('TRAN'),(id,passengers,added,loading)=>{
      Loop(1,()=>{
        If(unit(id,U.UOWNER).notEqual(0).and(unit(id,U.UALTITUDE).equal(0)).and(passengers.greaterThan(0)).and(stateAt(id,TMODE).equal(0)),()=>{stateAt(id,TMODE).assign(1);stateAt(id,TTIMER).assign(0);});
        const opening=unit(id,U.UALTITUDE).equal(0).and(goals.element(id).lessThan(0)).and(loading.notEqual(0));
        If(opening,()=>{
          If(unit(id,U.UDOOR).equal(0).or(unit(id,U.UDOOR).greaterThanEqual(5)),()=>{unit(id,U.UDOOR).assign(1);stateAt(id,TRESERVED).assign(0);})
            .ElseIf(unit(id,U.UDOOR).lessThan(4),()=>{stateAt(id,TRESERVED).addAssign(1);If(stateAt(id,TRESERVED).mod(5).equal(0),()=>{unit(id,U.UDOOR).addAssign(1);});});
        }).ElseIf(unit(id,U.UDOOR).greaterThan(0),()=>{
          If(unit(id,U.UDOOR).lessThan(5),()=>{unit(id,U.UDOOR).assign(5);stateAt(id,TRESERVED).assign(0);})
            .Else(()=>{stateAt(id,TRESERVED).addAssign(1);If(stateAt(id,TRESERVED).mod(5).equal(0),()=>{unit(id,U.UDOOR).assign(select(unit(id,U.UDOOR).equal(7),int(0),unit(id,U.UDOOR).add(1)));});});
        });
        If(stateAt(id,TMODE).equal(1).and(unit(id,U.UALTITUDE).equal(0)).and(goals.element(id).lessThan(0)),()=>{stateAt(id,TMODE).assign(2);stateAt(id,TTIMER).assign(0);});
        If(stateAt(id,TMODE).equal(2),()=>{
          const last=stateAt(id,TLAST).toVar();If(last.greaterThanEqual(0),()=>{If(unit(last,U.UHEALTH).greaterThan(0).and(unit(last,U.UCELL).equal(unit(id,U.UCELL))),()=>{Continue();});});
          If(stateAt(id,TTIMER).lessThan(10),()=>{stateAt(id,TTIMER).addAssign(1);Continue();});
          If(passengers.equal(0),()=>{stateAt(id,TMODE).assign(3);stateAt(id,TTIMER).assign(0);Continue();});
          const passenger=int(-1).toVar(),order=int(-1).toVar();
          const choose=(candidate:I)=>{If(candidate.greaterThanEqual(0),()=>{If(unit(candidate,U.UHEALTH).greaterThan(0).and(unit(candidate,U.UATTACHED).equal(id.add(1))).and(stateAt(candidate,TORDER).greaterThan(order).or(stateAt(candidate,TORDER).equal(order).and(candidate.greaterThan(passenger)))),()=>{passenger.assign(candidate);order.assign(stateAt(candidate,TORDER));});});};
          const candidate=int(relations.element(id.add(index.cargoHead))).toVar();Loop(()=>{If(candidate.lessThan(0),()=>{Break();});choose(candidate);candidate.assign(int(relations.element(candidate.add(index.cargoNext))));});choose(added);

          const direction=int(-1).toVar();Loop(8,({i})=>{const d=data.element(i.add(unload)),cell=adjacent(unit(id,U.UCELL),d);If(clear(cell,passenger,unit(passenger,U.UKIND).notEqual(0)),()=>{direction.assign(d);Break();});});
          If(direction.lessThan(0),()=>{Continue();});
          unit(passenger,U.UATTACHED).assign(0);passengers.subAssign(1);stateAt(id,TREMOVED).assign(1);unit(passenger,U.UX).assign(unit(id,U.UX));unit(passenger,U.UY).assign(unit(id,U.UY));unit(passenger,U.UCELL).assign(unit(id,U.UCELL));
          unit(passenger,U.UFACE).assign(direction.mul(32));unit(passenger,U.UDESIRED).assign(direction.mul(32));unit(passenger,U.UDEST).assign(-1);unit(passenger,U.UTRACK).assign(-1);unit(passenger,U.UENTER).assign(0);
          goals.element(passenger).assign(adjacent(unit(id,U.UCELL),direction));paths.element(passenger).assign(-1);
          combat(passenger,C.CMISSION).assign(select(unit(passenger,U.UOWNER).equal(0),int(C.MOVE),int(C.HUNT)));stateAt(id,TLAST).assign(passenger);stateAt(id,TTIMER).assign(0);
        }).ElseIf(stateAt(id,TMODE).equal(3).and(unit(id,U.UDOOR).equal(0)),()=>{
          stateAt(id,TMODE).assign(select(unit(id,U.UOWNER).equal(0),int(0),int(4)));If(stateAt(id,TMODE).equal(4),()=>{goals.element(id).assign(-1);});
        });
      });
    });
    // APC missions have their own kernel; boarding helpers remain shared WGSL functions.
    const apcs=carrierKernel(movementType('APC'),(id,passengers,added)=>{Loop(1,()=>{
      const door=unit(id,U.UDOOR).toVar();
      If(door.equal(1).or(door.equal(5)),()=>{
        const rate=select(door.equal(5).or(unit(id,U.UFACE).equal(32)).or(unit(id,U.UFACE).equal(224)),int(10),int(1));
        stateAt(id,TRESERVED).addAssign(1);If(stateAt(id,TRESERVED).greaterThanEqual(rate),()=>{unit(id,U.UDOOR).assign(select(door.equal(1),int(4),int(0)));stateAt(id,TRESERVED).assign(0);});
      });
      If(stateAt(id,TMODE).equal(0),()=>{
        If(stateAt(id,TCONTACT).equal(0).or(goals.element(id).greaterThanEqual(0)).or(unit(id,U.UFACE).notEqual(unit(id,U.UDESIRED))).or(passengers.equal(5)),()=>{apcDoor(id,int(0).equal(1));});Continue();
      });
      If(stateAt(id,TTIMER).greaterThan(0),()=>{stateAt(id,TTIMER).subAssign(1);Continue();});stateAt(id,TTIMER).assign(14);
      const mode=stateAt(id,TMODE).toVar();
      If(mode.equal(1),()=>{
        If(unit(id,U.UDEST).greaterThanEqual(0),()=>{Continue();});
        const direction=apcDirection(id,int(-1)).toVar();If(passengers.equal(0).or(direction.lessThan(0)),()=>{stateAt(id,TMODE).assign(0);Continue();});
        unit(id,U.UDESIRED).assign(data.element(direction.add(apcFaces)));apcDoor(id,int(0).equal(1));stateAt(id,TMODE).assign(2);stateAt(id,TTIMER).assign(0);
      }).ElseIf(mode.equal(2),()=>{
        If(unit(id,U.UFACE).equal(unit(id,U.UDESIRED)).and(unit(id,U.UDEST).lessThan(0)),()=>{apcDoor(id,int(1).equal(1));stateAt(id,TMODE).assign(3);stateAt(id,TTIMER).assign(0);});
      }).ElseIf(mode.equal(3),()=>{
        If(unit(id,U.UDOOR).equal(4),()=>{stateAt(id,TMODE).assign(4);stateAt(id,TTIMER).assign(0);});
      }).ElseIf(mode.equal(4),()=>{
        If(passengers.equal(0),()=>{stateAt(id,TMODE).assign(6);Continue();});
        const passenger=int(-1).toVar(),order=int(-1).toVar();
        const choose=(candidate:I)=>{If(candidate.greaterThanEqual(0),()=>{If(unit(candidate,U.UHEALTH).greaterThan(0).and(unit(candidate,U.UATTACHED).equal(id.add(1))).and(stateAt(candidate,TORDER).greaterThan(order).or(stateAt(candidate,TORDER).equal(order).and(candidate.greaterThan(passenger)))),()=>{passenger.assign(candidate);order.assign(stateAt(candidate,TORDER));});});};
        const candidate=int(relations.element(id.add(index.cargoHead))).toVar();Loop(5,()=>{If(candidate.lessThan(0),()=>{Break();});choose(candidate);candidate.assign(int(relations.element(candidate.add(index.cargoNext))));});choose(added);
        const direction=int(-1).toVar(),destination=int(-1).toVar();
        Loop(8,({i})=>{const face=unit(id,U.UFACE).add(128).add(i).bitAnd(255),cell=adjacent(unit(id,U.UCELL),face.add(16).bitAnd(255).shiftRight(5));If(apcClear(cell,passenger),()=>{direction.assign(face);destination.assign(cell);Break();});});
        If(direction.lessThan(0),()=>{stateAt(id,TMODE).assign(6);Continue();});
        const point=move(position(id),direction,int(128)).toVar();
        unit(passenger,U.UATTACHED).assign(0);passengers.subAssign(1);stateAt(id,TREMOVED).assign(1);
        unit(passenger,U.UX).assign(point.x);unit(passenger,U.UY).assign(point.y);unit(passenger,U.UCELL).assign(point.y.div(256).mul(width).add(point.x.div(256)));
        unit(passenger,U.UFACE).assign(direction);unit(passenger,U.UDESIRED).assign(direction);unit(passenger,U.UDEST).assign(-1);unit(passenger,U.UTRACK).assign(-1);unit(passenger,U.UENTER).assign(0);unit(passenger,U.USLOT).assign(0);
        goals.element(passenger).assign(destination);paths.element(passenger).assign(-1);combat(passenger,C.CMISSION).assign(C.MOVE);
      }).ElseIf(mode.equal(6),()=>{apcDoor(id,int(0).equal(1));If(unit(id,U.UDOOR).equal(0),()=>{stateAt(id,TMODE).assign(0);});});
    });});
    const cancelFull=Fn(()=>{
      const id=int(instanceIndex),target=unit(id,U.UENTER).sub(1);
      If(target.greaterThanEqual(0).and(unit(id,U.UKIND).notEqual(0)).and(unit(id,U.UATTACHED).equal(0)),()=>{
        If(isCarrier(target),()=>{
          const added=stateAt(target,TADDED).sub(1),total=stateAt(target,TINITIAL).add(int(added.greaterThanEqual(0).and(added.lessThan(id)))).sub(int(stateAt(target,TREMOVED).notEqual(0).and(target.lessThan(id))));
          If(unit(target,U.UHEALTH).lessThanEqual(0).or(unit(target,U.UOWNER).notEqual(unit(id,U.UOWNER))).or(total.greaterThanEqual(5)),()=>{unit(id,U.UENTER).assign(0);stateAt(id,TMODE).assign(0);});
        });
      });
    })().compute(count);
    const retreat=Fn(()=>{const id=int(instanceIndex);If(unit(id,U.UTYPE).equal(movementType('TRAN')).and(stateAt(id,TMODE).equal(4)),()=>{flight(id,ARETREAT).assign(65);flight(id,AGOAL).assign(-1);});})().compute(count);
    const prepareDelivery=Fn(()=>{const id=int(instanceIndex);Loop(1,()=>{
      If(unit(id,U.UHEALTH).lessThanEqual(0).or(unit(id,U.UTYPE).notEqual(movementType('C17'))),()=>{Continue();});
      If(flight(id,AGENERATION).notEqual(unit(id,U.UGENERATION)),()=>{
        Loop(AIR_WORDS,({i})=>{air.element(id.mul(AIR_WORDS).add(i)).assign(0);});flight(id,AGENERATION).assign(unit(id,U.UGENERATION));flight(id,AGOAL).assign(-1);flight(id,ACONTACT).assign(-1);flight(id,ATARGET).assign(-1);flight(id,AFIRED).assign(-1);flight(id,AFACING).assign(unit(id,U.UFACE));flight(id,ADESIRED).assign(unit(id,U.UFACE));
      });
      const factory=unit(id,U.UENTER).sub(1).toVar(),missing=int(factory.lessThan(0)).toVar();If(factory.greaterThanEqual(0),()=>{If(unit(factory,U.UHEALTH).lessThanEqual(0).or(combat(factory,C.CACTIVE).equal(0)),()=>{missing.assign(1);});});
      If(stateAt(id,TMODE).equal(0).and(missing.notEqual(0)),()=>{
        factory.assign(-1);const other=int(relations.element(movementType('AFLD'))).toVar();Loop(()=>{If(other.lessThan(0),()=>{Break();});If(unit(other,U.UOWNER).equal(unit(id,U.UOWNER)).and(unit(other,U.UHEALTH).greaterThan(0)).and(combat(other,C.CACTIVE).notEqual(0)).and(factory.lessThan(0).or(other.lessThan(factory))),()=>{factory.assign(other);});other.assign(int(relations.element(other.add(index.typeNext))));});
        unit(id,U.UENTER).assign(factory.add(1));If(factory.lessThan(0),()=>{stateAt(id,TMODE).assign(1);});
      });
      If(stateAt(id,TMODE).equal(0),()=>{
        const origin=unit(factory,U.UORIGIN),goal=ivec2(origin.mod(width).mul(256).add(192),origin.div(width).mul(256).add(320)),d=unitDistance(position(id),goal).toVar();
        If(flight(id,AFACING).equal(flight(id,ADESIRED)),()=>{flight(id,ADESIRED).assign(unitDirection(position(id),goal));});
        unit(id,U.UALTITUDE).assign(select(d.greaterThanEqual(1536),int(24),d.mul(256).div(1536).mul(24).add(128).shiftRight(8)));
        If(d.lessThan(128),()=>{stateAt(id,TDROP).assign(1);stateAt(id,TFACTORY).assign(factory.add(1));});
      }).Else(()=>{flight(id,ADESIRED).assign(192);If(unit(id,U.UALTITUDE).lessThan(24),()=>{If(stateAt(id,TTIMER).mod(3).equal(0),()=>{unit(id,U.UALTITUDE).addAssign(1);});stateAt(id,TTIMER).addAssign(1);});});
    });})().compute(count);
    const drop=Fn(()=>{const id=int(instanceIndex);If(stateAt(id,TDROP).notEqual(0),()=>{
      const factory=stateAt(id,TFACTORY).sub(1),origin=unit(factory,U.UORIGIN),passenger=int(-1).toVar(),next=int(relations.element(id.add(index.cargoHead))).toVar();
      Loop(()=>{If(next.lessThan(0),()=>{Break();});If(unit(next,U.UHEALTH).greaterThan(0).and(unit(next,U.UATTACHED).equal(id.add(1))).and(passenger.lessThan(0).or(next.lessThan(passenger))),()=>{passenger.assign(next);});next.assign(int(relations.element(next.add(index.cargoNext))));});
      If(passenger.greaterThanEqual(0),()=>{
        const destination=int(-1).toVar();Loop(16,({i})=>{const cell=origin.add(data.element(i.mul(2).add(exits+1)).mul(width)).add(data.element(i.mul(2).add(exits)));If(clear(cell,passenger),()=>{destination.assign(cell);Break();});});
        If(destination.greaterThanEqual(0),()=>{
          unit(passenger,U.UATTACHED).assign(0);unit(passenger,U.UCELL).assign(destination);unit(passenger,U.UX).assign(destination.mod(width).mul(256).add(128));unit(passenger,U.UY).assign(destination.div(width).mul(256).add(128));
          const goal=destination.toVar(),start=int(randomNode(uint(battle.setup.seed),uint(t.element(4).add(int(0))),uint(passenger.add(0)),uint(1)).mod(uint(8)));
          Loop(8,({i})=>{const cell=adjacent(destination,start.add(i).bitAnd(7));If(clear(cell,passenger),()=>{goal.assign(cell);});});goals.element(passenger).assign(goal);paths.element(passenger).assign(-1);combat(passenger,C.CMISSION).assign(C.MOVE);If(unit(id,U.UOWNER).equal(0),()=>{stateAt(id,TDELIVER).assign(1);});
        });
      });stateAt(id,TMODE).assign(1);stateAt(id,TTIMER).assign(0);unit(id,U.UENTER).assign(0);
    });})().compute(count);
    const fly=Fn(()=>{const id=int(instanceIndex);If(unit(id,U.UHEALTH).greaterThan(0).and(unit(id,U.UTYPE).equal(movementType('C17'))),()=>{
      flight(id,AFACING).assign(unitRotate(flight(id,AFACING),flight(id,ADESIRED),int(5)));unit(id,U.UFACE).assign(flight(id,AFACING));unit(id,U.UDESIRED).assign(flight(id,AFACING));flight(id,ASPEED).assign(255);
      const total=flight(id,AACCUM).add(40).toVar(),length=total.sub(total.mod(10));flight(id,AACCUM).assign(total.mod(10));const pos=move(position(id),flight(id,AFACING),length).toVar();
      const inMap=pos.x.greaterThanEqual(bounds.x*256).and(pos.y.greaterThanEqual(bounds.y*256)).and(pos.x.lessThan((bounds.x+bounds.width)*256)).and(pos.y.lessThan((bounds.y+bounds.height)*256));
      If(inMap,()=>{stateAt(id,TLOCKED).assign(1);});
      If(pos.x.lessThan(0).or(pos.y.lessThan(0)).or(pos.x.greaterThanEqual(width*256)).or(pos.y.greaterThanEqual(height*256)).or(stateAt(id,TLOCKED).notEqual(0).and(inMap.not())),()=>{unit(id,U.UHEALTH).assign(0);})
        .Else(()=>{unit(id,U.UX).assign(pos.x);unit(id,U.UY).assign(pos.y);unit(id,U.UCELL).assign(pos.y.div(256).mul(width).add(pos.x.div(256)));});
    });})().compute(count);
    const refund=Fn(()=>{const id=int(instanceIndex);If(unit(id,U.UTYPE).equal(movementType('C17')).and(unit(id,U.UHEALTH).lessThanEqual(0)),()=>{
      const passenger=int(relations.element(id.add(index.cargoHead))).toVar();Loop(()=>{If(passenger.lessThan(0),()=>{Break();});If(unit(passenger,U.UHEALTH).greaterThan(0).and(unit(passenger,U.UATTACHED).equal(id.add(1))),()=>{stateAt(id,TREFUND).addAssign(data.element(unit(passenger,U.UTYPE)));unit(passenger,U.UHEALTH).assign(0);unit(passenger,U.UATTACHED).assign(0);});passenger.assign(int(relations.element(passenger.add(index.cargoNext))));});
    });})().compute(count);
    const collectAttachments=Fn(()=>{const id=int(instanceIndex);If(unit(id,U.UKIND).notEqual(0).and(stateAt(id,TADDED).notEqual(0)),()=>{this.attachments.add(id);});})().compute(count);
    const orderAttachments=Fn(()=>{this.attachments.forEach(id=>{t.element(3).addAssign(1);stateAt(id,TORDER).assign(t.element(3));});})().compute(1);
    const totals=storage(this.state,'int',this.state.count).toAtomic();
    const settle=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(TWORDS).add(TBASE),refund=atomicLoad(totals.element(at.add(TREFUND))),delivered=atomicLoad(totals.element(at.add(TDELIVER)));
      If(refund.greaterThan(0),()=>{atomicAdd(totals.element(unit(id,U.UOWNER)),refund);});If(delivered.greaterThan(0),()=>{atomicAdd(totals.element(2),delivered);});
      for(let field=TOLDENTER;field<TWORDS;field++)atomicStore(totals.element(at.add(field)),int(0));
    })().compute(count);
    if(!aircraft)for(const kernel of [retreat,prepareDelivery,drop,fly,refund])kernel.dispose();
    this.kernels=[initialize,commands,approach,...index.kernels,loading,carriers,apcs,cancelFull,...(aircraft?[retreat,prepareDelivery,drop,fly,refund]:[]),this.attachments.clear,collectAttachments,orderAttachments,settle];
  }
  step(){this.battle.renderer.compute(this.kernels);this.battle.movement.refreshOccupancy();}
  dispose(){for(const k of this.kernels)if(!this.battle.movement.actorIndex.kernels.includes(k)&&k!==this.attachments.clear)k.dispose();this.attachments.dispose();releaseStorage(this.battle.renderer,[this.constants,...(this.ownsState?[this.state]:[])]);}
}
