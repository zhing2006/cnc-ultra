import { StorageBufferAttribute, type ComputeNode } from 'three/webgpu';
import { Fn, If, Break, int, uint, storage,select,instanceIndex,uniform,atomicMin } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { computeFunction } from '../../engine/simulation/compute-function.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { randomNode } from '../../engine/simulation/integer-nodes.ts';
import { GROUND_SPEED,MOVEMENT,movementType } from '../data/movement.ts';
import { combatTypes } from '../data/combat.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { placementOffsets } from './building-rules.ts';
import type { GpuCombat } from './combat-gpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
import { FACTORY_POINT,FACTORY_EXITS } from './services-cpu.ts';
import { AIR_WORDS,ACONTACT,AGENERATION } from './aircraft-cpu.ts';

import { CHANGE_WORDS,CREATE,HEALTH,REMOVE,DESTINATION,TARGET,AMMO,FACING,STATUS,NEARBY,INITIAL_ORDER,DIRECT_ENTRY,ORDER,CREATE_TECHNICIAN,CREATE_LOANER } from './lifecycle-state.ts';
export { CHANGE_WORDS,CREATE,HEALTH,REMOVE,DESTINATION,TARGET,AMMO,FACING,STATUS,NEARBY,INITIAL_ORDER } from './lifecycle-state.ts';
const AIR_EDGE=512;
/** Recorded CPU construction commands are applied without copying live GPU state to the CPU. */
export class GpuLifecycle {
  readonly commands:StorageBufferAttribute;
  readonly kernel:ComputeNode;
  private readonly constants:StorageBufferAttribute;
  private terrainCheck?:ComputeNode;
  private terrainClear?:ComputeNode;
  private airContacts?:ComputeNode;
  private readonly placementOffset:number;
  private readonly exitCheck:ComputeNode;
  private readonly editPass:ComputeNode;
  private readonly changed=new Set<number>();
  private readonly statuses:Int32Array;
  private readonly listOffset:number;
  private readonly createOffset:number;
  private readonly frame=uniform(0,'int');
  constructor(readonly battle:GpuCombat) {
    const count=battle.setup.units.length,width=battle.setup.grid.width;
    this.listOffset=count*CHANGE_WORDS;this.createOffset=this.listOffset+count+1;
    this.commands=new StorageBufferAttribute(new Int32Array(this.createOffset+count+1),1);
    this.statuses=new Int32Array(count).fill(-1);
    const values:number[]=[],starts:number[]=[];
    for(let i=0;i<MOVEMENT.length;i++){
      const type=MOVEMENT[i],b=type.domain===2?BUILDINGS.get(type.name):undefined;
      const offsets=b?placementOffsets(type.name):[[0,0]];
      starts.push(values.length);
      values.push(type.infantry,type.domain??0,type.strength,combatTypes[i].ammo,combatTypes[i].twoShooter,
        b?.width===2?255:(b?.width??1)*128,b?.height===2?255:(b?.height??1)*128,offsets.length,
        ...offsets.flatMap(([x,y])=>[x,y]));
    }
    this.placementOffset=starts.length+values.length;
    const walkOffset=this.placementOffset+battle.setup.grid.edges.length;
    const edgeTerrain=this.placementOffset+battle.setup.grid.edges.length*3;
    const locomotion=edgeTerrain+battle.setup.grid.edges.length;
    const packed=Int32Array.from([...starts.map(i=>i+starts.length),...values,...Array.from(battle.setup.passable??battle.setup.grid.edges),...Array.from(battle.setup.passable??battle.setup.grid.edges),...Array.from(battle.setup.passable??battle.setup.grid.edges),
      ...Array.from(battle.setup.land,land=>GROUND_SPEED[land].reduce((mask,speed,index)=>mask|(speed?1<<index:0),0)),...MOVEMENT.map(type=>type.locomotion)]);
    this.constants=new StorageBufferAttribute(packed,1);
    battle.movement.mapObservers.add((_edges,passable)=>{(this.constants.array as Int32Array).set(passable,walkOffset);this.constants.needsUpdate=true;});
    const data=storage(this.constants,'int',packed.length).toReadOnly(),cmd=storage(this.commands,'int',this.commands.count).toReadOnly();
    const u=storage(battle.units,'int',battle.units.count),s=storage(battle.state,'int',battle.state.count);
    const goals=storage(battle.movement.goals,'int',count),paths=storage(battle.movement.pathGoals,'int',count);
    const occupancy=storage(battle.movement.occupancy,'uint',battle.movement.occupancy.count);
    const pending=storage(battle.movement.pending,'int',count*2);
    const requests=storage(this.commands,'int',this.commands.count);
    const index=battle.movement.actorIndex,locations=storage(index.buffer,'uint',index.buffer.count).toReadOnly();
    const order=(id:import('three/webgpu').Node<'int'>,p:import('three/webgpu').Node<'int'>,c:import('three/webgpu').Node<'int'>)=>{
      s.element(c.add(C.CMISSION)).assign(cmd.element(p.add(8)));s.element(c.add(C.CTARGET)).assign(cmd.element(p.add(14)));
      s.element(c.add(C.CFIRE)).assign(-1);s.element(c.add(C.CSCAN)).assign(0);s.element(c.add(C.CSUSPENDED_MISSION)).assign(0);
      goals.element(id).assign(cmd.element(p.add(13)));paths.element(id).assign(-1);
    };
    this.exitCheck=Fn(()=>{
      const id=requests.element(int(instanceIndex).add(this.createOffset+1)),at=id.mul(CHANGE_WORDS);
      If(requests.element(at).bitAnd(CREATE).notEqual(0).and(requests.element(at.add(12)).greaterThan(0)),()=>{
        const parent=requests.element(at.add(12)).sub(1),origin=u.element(parent.mul(U.WORDS).add(U.UORIGIN));
        If(u.element(parent.mul(U.WORDS).add(U.UTYPE)).equal(movementType('HPAD')),()=>{
          const busy=int(locations.element(origin.add(1+index.airCount)).greaterThan(0).or(int(locations.element(parent.add(index.airOwner))).greaterThanEqual(0))).toVar();
          Loop({start:0,end:int(instanceIndex),type:'int'},({i})=>{
            const earlier=requests.element(i.add(this.createOffset+1)).mul(CHANGE_WORDS);
            If(requests.element(earlier).bitAnd(CREATE).notEqual(0).and(requests.element(earlier.add(12)).equal(parent.add(1))),()=>{busy.assign(1);});
          });
          If(busy.notEqual(0),()=>{requests.element(at).bitOrAssign(AIR_EDGE);});
        });
      });
      If(requests.element(at).bitAnd(CREATE).notEqual(0).and(requests.element(at.add(12)).lessThan(0)),()=>{
        const parent=requests.element(at.add(12)).negate().sub(1).mul(U.WORDS),type=u.element(parent.add(U.UTYPE)),origin=u.element(parent.add(U.UORIGIN));
        for(const name of ['PYLE','HAND'])If(type.equal(movementType(name)),()=>{
          const found=int(0).toVar();
          for(const [x,y] of FACTORY_EXITS[name]){
            const cell=origin.add(y*width+x);
            If(cell.greaterThanEqual(0).and(cell.lessThan(battle.setup.grid.edges.length)).and(data.element(cell.add(walkOffset)).notEqual(0)),()=>{
              Loop(5,({i})=>{If(occupancy.element(cell.mul(5).add(i)).equal(uint(0)),()=>{found.assign(1);});});
            });
          }
          If(found.equal(0),()=>{requests.element(at).assign(0);});
        });
      });
    })().compute(1);
    this.editPass=Fn(()=>{
      const id=cmd.element(int(instanceIndex).add(this.listOffset+1)).toVar(),p=id.mul(CHANGE_WORDS).toVar(),mask=cmd.element(p).toVar(),at=id.mul(U.WORDS).toVar(),c=id.mul(C.CWORDS).toVar();
      If(mask.bitAnd(CREATE).equal(0),()=>{
        If(mask.bitAnd(REMOVE).notEqual(0),()=>{u.element(at.add(U.UHEALTH)).assign(0);goals.element(id).assign(-1);s.element(c.add(C.CDEATH)).assign(-1);});
        If(mask.bitAnd(HEALTH).notEqual(0),()=>{u.element(at.add(U.UHEALTH)).assign(cmd.element(p.add(4)));});
        If(mask.bitAnd(FACING).notEqual(0),()=>{u.element(at.add(U.UDESIRED)).assign(cmd.element(p.add(5)));});
        If(mask.bitAnd(STATUS).notEqual(0),()=>{s.element(c.add(C.CPOWER)).assign(cmd.element(p.add(10)).bitAnd(65535));s.element(c.add(C.CACTIVE)).assign(cmd.element(p.add(10)).shiftRight(16));});
        If(mask.bitAnd(AMMO).notEqual(0),()=>{s.element(c.add(C.CAMMO)).assign(cmd.element(p.add(7)));});
        If(mask.bitAnd(DESTINATION).notEqual(0),()=>{goals.element(id).assign(cmd.element(p.add(7)));paths.element(id).assign(-1);s.element(c.add(C.CMISSION)).assign(C.MOVE);});
        If(mask.bitAnd(TARGET).notEqual(0),()=>{s.element(c.add(C.CTARGET)).assign(cmd.element(p.add(7)));s.element(c.add(C.CMISSION)).assign(C.ATTACK);s.element(c.add(C.CSCAN)).assign(0);});
        If(mask.bitAnd(ORDER).notEqual(0),()=>{order(id,p,c);});
      });
    })().compute(1);
    const unoccupied=computeFunction(([target,id]:[import('three/webgpu').Node<'int'>,import('three/webgpu').Node<'int'>])=>{
      const result=int(1).toVar();
      If(target.lessThan(0).or(target.greaterThanEqual(battle.setup.grid.edges.length)),()=>{result.assign(0);}).Else(()=>{
        Loop(5,({i})=>{const owner=occupancy.element(target.mul(5).add(i));If(owner.notEqual(uint(0)).and(owner.notEqual(uint(id.add(1)))),()=>{result.assign(0);});});
      });return result.notEqual(0);
    },{name:'lifecycleCellClear',type:'bool',inputs:[{name:'cell',type:'int'},{name:'actor_id',type:'int'}]});
    this.kernel=Fn(()=>{
      const entryOrigin=int(-1).toVar(),entryCell=int(-1).toVar();
      Loop({start:0,end:cmd.element(this.createOffset),type:'int'},({i})=>{
        const id=cmd.element(i.add(this.createOffset+1)).toVar();
        // These addresses are also used without CREATE; initialize before that branch.
        const p=id.mul(CHANGE_WORDS).toVar(),mask=cmd.element(p).toVar(),at=id.mul(U.WORDS).toVar(),c=id.mul(C.CWORDS).toVar();
        If(mask.bitAnd(REMOVE).notEqual(0),()=>{u.element(at.add(U.UHEALTH)).assign(0);goals.element(id).assign(-1);s.element(c.add(C.CDEATH)).assign(-1);});
        If(mask.bitAnd(CREATE).notEqual(0),()=>{
          const type=cmd.element(p.add(1)).toVar(),row=data.element(type).toVar(),cell=cmd.element(p.add(3)).toVar();
          const free=int(1).toVar(),slot=int(-1).toVar(),domain=data.element(row.add(1)),ignore=cmd.element(p.add(9));
          if(battle.setup.bounds)If(mask.bitAnd(DIRECT_ENTRY).notEqual(0),()=>{
            const bounds=battle.setup.bounds!;
            If(entryOrigin.notEqual(cell),()=>{entryOrigin.assign(cell);entryCell.assign(cell);});cell.assign(entryCell);
            const clear=(x:import('three/webgpu').Node<'int'>,y:import('three/webgpu').Node<'int'>)=>{
              const available=int(0).toVar(),target=y.mul(width).add(x);
              If(x.greaterThanEqual(0).and(y.greaterThanEqual(0)).and(x.lessThan(width)).and(y.lessThan(battle.setup.grid.height))
                .and(x.lessThan(bounds.x).or(y.lessThan(bounds.y)).or(x.greaterThanEqual(bounds.x+bounds.width)).or(y.greaterThanEqual(bounds.y+bounds.height))),()=>{
                If(data.element(target.add(edgeTerrain)).bitAnd(int(1).shiftLeft(data.element(type.add(locomotion)))).notEqual(0),()=>{
                  const spots=int(0).toVar();Loop(5,({i})=>{If(occupancy.element(target.mul(5).add(i)).equal(uint(0)),()=>{spots.addAssign(1);});});
                  available.assign(int(select(data.element(row).notEqual(0),spots.greaterThan(0),spots.equal(5))));
                });
              });return available.notEqual(0);
            };
            If(clear(cell.mod(width),cell.div(width)).not(),()=>{
              const found=int(-1).toVar();
              for(const [dx,dy] of [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]]){
                If(found.lessThan(0),()=>{const x=cell.mod(width).add(dx),y=cell.div(width).add(dy);If(clear(x,y),()=>{found.assign(y.mul(width).add(x));});});
              }
              If(found.lessThan(0),()=>{free.assign(0);}).Else(()=>{cell.assign(found);});
            });entryCell.assign(cell);
          });
          If(mask.bitAnd(NEARBY).notEqual(0),()=>{
            If(unoccupied(cell,id).not(),()=>{
              const center=u.element(ignore.mul(U.WORDS).add(U.UCELL)),found=int(-1).toVar();
              const visit=(x:import('three/webgpu').Node<'int'>,y:import('three/webgpu').Node<'int'>)=>{
                const target=center.add(x).add(y.mul(width)),xx=center.mod(width).add(x),yy=center.div(width).add(y);
                If(xx.greaterThanEqual(0).and(xx.lessThan(width)).and(yy.greaterThanEqual(0)).and(yy.lessThan(battle.setup.grid.height)),()=>{
                  If(data.element(target.add(this.placementOffset)).notEqual(0).and(unoccupied(target,id)),()=>{found.assign(target);});
                });
              };
              Loop(32,({i:r})=>{
                Loop({start:r.negate(),end:r,condition:'<=',type:'int'},({i:x})=>{visit(x,r.negate());visit(x,r);});
                Loop({start:int(1).sub(r),end:r,type:'int'},({i:y})=>{visit(r.negate(),y);visit(r,y);});
                If(found.greaterThanEqual(0),()=>{Break();});
              });
              If(found.lessThan(0),()=>{free.assign(0);}).Else(()=>{cell.assign(found);});
            });
          });
          If(domain.notEqual(1).and(cmd.element(p.add(11)).equal(0)),()=>{
            Loop({start:0,end:data.element(row.add(7)),type:'int'},({i:offset})=>{
              const xx=cell.mod(width).add(data.element(row.add(8).add(offset.mul(2))));
              const yy=cell.div(width).add(data.element(row.add(9).add(offset.mul(2))));
              const target=yy.mul(width).add(xx);
              If(xx.lessThan(0).or(yy.lessThan(0)).or(xx.greaterThanEqual(width)).or(yy.greaterThanEqual(battle.setup.grid.height)),()=>{free.assign(0);}).Else(()=>{
                const spots=int(0).toVar();
                Loop(5,({i:j})=>{const owner=int(occupancy.element(target.mul(5).add(j))).sub(1);If(owner.lessThan(0).or(owner.equal(ignore)).or(owner.equal(id)),()=>{spots.addAssign(1);If(slot.lessThan(0),()=>{slot.assign(j);});});});
                If(data.element(row).equal(0).and(spots.lessThan(5)).or(spots.equal(0)),()=>{free.assign(0);});
              });
            });
          });
          If(free.notEqual(0),()=>{
            const generation=u.element(at.add(U.UGENERATION)).add(1).toVar();
            Loop(U.WORDS,({i})=>{u.element(at.add(i)).assign(0);});Loop(C.CWORDS,({i})=>{s.element(c.add(i)).assign(0);});
            for(const field of [U.UDEST,U.UTRACK,U.UJUMP,U.UJUMP_TRACK,U.UROUTE,U.UMIDDLE,U.UOVERRUN_CELL])u.element(at.add(field)).assign(-1);
            for(const field of [C.CTARGET,C.CAPPROACH_GOAL,C.CLOCAL_DEST,C.CFIRE,C.CDEATH,C.CLAST_FIRE,C.CCELEBRATED,C.CKILLER,C.CCREW])s.element(c.add(field)).assign(-1);
            u.element(at.add(U.UGENERATION)).assign(generation);u.element(at.add(U.UTYPE)).assign(type);
            u.element(at.add(U.UFLAGS)).assign(mask.shiftRight(13).bitAnd(3));
            u.element(at.add(U.UCLOAK_STAGE)).assign(select(type.equal(movementType('STNK')),int(1),int(0)));
            u.element(at.add(U.UX)).assign(cell.mod(width).mul(256).add(data.element(row.add(5))));
            u.element(at.add(U.UY)).assign(cell.div(width).mul(256).add(data.element(row.add(6))));
            u.element(at.add(U.UCELL)).assign(u.element(at.add(U.UY)).div(256).mul(width).add(u.element(at.add(U.UX)).div(256)));u.element(at.add(U.UORIGIN)).assign(cell);
            u.element(at.add(U.UKIND)).assign(data.element(row));u.element(at.add(U.UDOMAIN)).assign(domain);
            u.element(at.add(U.UOWNER)).assign(cmd.element(p.add(2)));u.element(at.add(U.UHEALTH)).assign(cmd.element(p.add(4)));
            u.element(at.add(U.UFACE)).assign(cmd.element(p.add(5)));u.element(at.add(U.UDESIRED)).assign(cmd.element(p.add(5)));u.element(at.add(U.URETRIES)).assign(10);
            u.element(at.add(U.UALTITUDE)).assign(cmd.element(p.add(6)));
            u.element(at.add(U.UATTACHED)).assign(cmd.element(p.add(11)));u.element(at.add(U.UENTER)).assign(cmd.element(p.add(12)));
            If(domain.equal(1).and(cmd.element(p.add(12)).greaterThan(0)),()=>{
              const parent=cmd.element(p.add(12)).sub(1).mul(U.WORDS),origin=u.element(parent.add(U.UORIGIN));
              If(u.element(parent.add(U.UTYPE)).equal(movementType('HPAD')),()=>{
              u.element(at.add(U.UX)).assign(origin.mod(width).mul(256).add(256));u.element(at.add(U.UY)).assign(origin.div(width).mul(256).add(192));
              u.element(at.add(U.UCELL)).assign(origin.add(1));
              });
            });
            s.element(c.add(C.CTURRET)).assign(cmd.element(p.add(5)));s.element(c.add(C.CTURN)).assign(cmd.element(p.add(5)));
            s.element(c.add(C.CSECOND)).assign(int(data.element(row.add(4)).equal(0)));s.element(c.add(C.CAMMO)).assign(data.element(row.add(3)));
            s.element(c.add(C.CSEEN)).assign(battle.setup.campaignLevel===undefined?int(1):int(cmd.element(p.add(2)).equal(0)));s.element(c.add(C.CMISSION)).assign(cmd.element(p.add(8)));s.element(c.add(C.CARM)).assign(select(mask.bitAnd(STATUS).notEqual(0),int(0),cmd.element(p.add(10))));
            s.element(c.add(C.CPOWER)).assign(256);s.element(c.add(C.CACTIVE)).assign(1);
            goals.element(id).assign(-1);paths.element(id).assign(-1);pending.element(id.mul(2)).assign(-1);
            If(mask.bitAnd(INITIAL_ORDER).notEqual(int(0)),()=>{goals.element(id).assign(cmd.element(p.add(13)));s.element(c.add(C.CTARGET)).assign(cmd.element(p.add(14)));});
            If(mask.bitAnd(DIRECT_ENTRY).notEqual(0),()=>{paths.element(id).assign(U.DIRECT_STEP);goals.element(id).addAssign(cell.sub(cmd.element(p.add(3))));});
            If(domain.equal(1).and(cmd.element(p.add(12)).greaterThan(0)),()=>{
              const parent=cmd.element(p.add(12)).sub(1).mul(U.WORDS),origin=u.element(parent.add(U.UORIGIN));
              If(u.element(parent.add(U.UTYPE)).equal(movementType('HPAD')),()=>{
                If(mask.bitAnd(AIR_EDGE).notEqual(0),()=>{
                  const bounds=battle.setup.bounds??{x:1,y:0,width:width-2,height:battle.setup.grid.height};
                  const edge=int(select(origin.mod(width).sub(bounds.x).lessThan(Math.trunc(bounds.width/2)),int(bounds.x-1),int(bounds.x+bounds.width)));
                  const y=int(randomNode(uint(battle.setup.seed),uint(this.frame),uint(id),uint(197)).mod(uint(bounds.height))).add(bounds.y);
                  const cell=y.mul(width).add(edge);
                  u.element(at.add(U.UX)).assign(edge.mul(256).add(128));u.element(at.add(U.UY)).assign(y.mul(256).add(128));u.element(at.add(U.UCELL)).assign(cell);u.element(at.add(U.UENTER)).assign(0);
                  u.element(at.add(U.UALTITUDE)).assign(24);
                  u.element(at.add(U.UFACE)).assign(0);u.element(at.add(U.UDESIRED)).assign(0);s.element(c.add(C.CTURRET)).assign(0);
                  const center=u.element(parent.add(U.UCELL)).toVar(),found=int(-1).toVar();
                  const visit=(dx:import('three/webgpu').Node<'int'>,dy:import('three/webgpu').Node<'int'>)=>{
                    const xx=center.mod(width).add(dx).toVar(),yy=center.div(width).add(dy).toVar(),cell=yy.mul(width).add(xx).toVar();
                    If(xx.greaterThanEqual(bounds.x).and(xx.lessThan(bounds.x+bounds.width)).and(yy.greaterThanEqual(bounds.y)).and(yy.lessThan(bounds.y+bounds.height)),()=>{
                      const clear=int(1).toVar();Loop(5,({i})=>{If(occupancy.element(cell.mul(5).add(i)).notEqual(uint(0)),()=>{clear.assign(0);});});
                      If(clear.notEqual(0).and(data.element(cell.add(this.placementOffset)).notEqual(0)),()=>{found.assign(cell);});
                    });
                  };
                  Loop(32,({i:r})=>{Loop({start:r.negate(),end:r,condition:'<=',type:'int'},({i:x})=>{visit(x,r.negate());visit(x,r);});Loop({start:int(1).sub(r),end:r,type:'int'},({i:y})=>{visit(r.negate(),y);visit(r,y);});If(found.greaterThanEqual(0),()=>{Break();});});
                  goals.element(id).assign(found);s.element(c.add(C.CMISSION)).assign(C.MOVE);
                });
              });
            });
            If(domain.notEqual(1).and(cmd.element(p.add(11)).equal(0)),()=>{
              If(data.element(row).notEqual(0),()=>{
                u.element(at.add(U.USLOT)).assign(slot);u.element(at.add(U.UDSLOT)).assign(slot);
                const sx=int(128).toVar(),sy=int(128).toVar();
                If(slot.greaterThan(0),()=>{sx.assign(slot.sub(1).mod(2).mul(128).add(64));sy.assign(slot.sub(1).div(2).mul(128).add(64));});
                u.element(at.add(U.UX)).assign(cell.mod(width).mul(256).add(sx));u.element(at.add(U.UY)).assign(cell.div(width).mul(256).add(sy));
                occupancy.element(cell.mul(5).add(slot)).assign(uint(id.add(1)));
              }).Else(()=>{Loop(5,({i:j})=>{occupancy.element(cell.mul(5).add(j)).assign(uint(id.add(1)));});});
            });
            If(cmd.element(p.add(12)).lessThan(0),()=>{
              const parent=cmd.element(p.add(12)).negate().sub(1).mul(U.WORDS),origin=u.element(parent.add(U.UORIGIN));
              for(const [name,[x,y]] of Object.entries(FACTORY_POINT))If(u.element(parent.add(U.UTYPE)).equal(movementType(name)),()=>{
                u.element(at.add(U.UX)).assign(origin.mod(width).mul(256).add(x));u.element(at.add(U.UY)).assign(origin.div(width).mul(256).add(y));
                u.element(at.add(U.UCELL)).assign(origin.add(Math.trunc(y/256)*width+Math.trunc(x/256)));
              });
            });
          });
        });
        If(mask.bitAnd(HEALTH).notEqual(0),()=>{u.element(at.add(U.UHEALTH)).assign(cmd.element(p.add(4)));});
        If(mask.bitAnd(FACING).notEqual(0),()=>{u.element(at.add(U.UDESIRED)).assign(cmd.element(p.add(5)));});
        If(mask.bitAnd(STATUS).notEqual(0),()=>{s.element(c.add(C.CPOWER)).assign(cmd.element(p.add(10)).bitAnd(65535));s.element(c.add(C.CACTIVE)).assign(cmd.element(p.add(10)).shiftRight(16));});
        If(mask.bitAnd(AMMO).notEqual(0),()=>{s.element(c.add(C.CAMMO)).assign(cmd.element(p.add(7)));});
        If(mask.bitAnd(DESTINATION).notEqual(0),()=>{goals.element(id).assign(cmd.element(p.add(7)));paths.element(id).assign(-1);s.element(c.add(C.CMISSION)).assign(C.MOVE);});
        If(mask.bitAnd(TARGET).notEqual(0),()=>{s.element(c.add(C.CTARGET)).assign(cmd.element(p.add(7)));s.element(c.add(C.CMISSION)).assign(C.ATTACK);s.element(c.add(C.CSCAN)).assign(0);});
        If(mask.bitAnd(ORDER).notEqual(0),()=>{order(id,p,c);});
      });
    })().compute(1);
  }
  create(id:number,unit:U.UnitPlacement,options:{ignore?:number;arm?:number;mission?:number;nearby?:boolean;destination?:number;target?:number;direct?:boolean}={}){
    this.changed.add(id);this.statuses[id]=-1;
    const data=this.commands.array as Int32Array,at=id*CHANGE_WORDS;
    const mask=CREATE|(options.nearby?NEARBY:0)|(options.destination!==undefined||options.target!==undefined?INITIAL_ORDER:0)|(options.direct?DIRECT_ENTRY:0)|((unit.flags??0)&U.TECHNICIAN?CREATE_TECHNICIAN:0)|((unit.flags??0)&U.LOANER?CREATE_LOANER:0);
    data.set([mask,unit.type,unit.owner??0,unit.cell,unit.health??MOVEMENT[unit.type].strength,unit.facing??0,unit.altitude??0,-1,options.mission??C.GUARD,options.ignore??-1,options.arm??0,unit.attached??0,unit.enter??0,options.destination??-1,options.target??-1],at);
  }
  setPlacementClear(clear:ArrayLike<number>){const values=this.constants.array as Int32Array;values.set(clear,this.placementOffset);values.set(clear,this.placementOffset+2*this.battle.setup.grid.edges.length);this.constants.needsUpdate=true;this.battle.movement.actorIndex.setBuildable(clear);}
  edit(id:number,mask:number,value=0){this.changed.add(id);const data=this.commands.array as Int32Array,at=id*CHANGE_WORDS;data[at]|=mask;data[at+(mask===HEALTH?4:7)]=value;}
  order(id:number,mission:number,target=-1,destination=-1){
    this.changed.add(id);const data=this.commands.array as Int32Array,at=id*CHANGE_WORDS;
    data[at]|=ORDER;data[at+8]=mission;data[at+13]=destination;data[at+14]=target;
  }
  face(id:number,value:number){this.changed.add(id);const data=this.commands.array as Int32Array,at=id*CHANGE_WORDS;data[at]|=FACING;data[at+5]=value;}
  status(id:number,power:number,active:boolean){
    const value=Math.min(256,power)+(active?65536:0);if(this.statuses[id]===value)return;
    this.statuses[id]=value;this.changed.add(id);const data=this.commands.array as Int32Array,at=id*CHANGE_WORDS;data[at]|=STATUS;data[at+10]=value;
  }
  validateTerrain(amount:StorageBufferAttribute){
    const cmd=storage(this.commands,'int',this.commands.count),data=storage(this.constants,'int',this.constants.count).toReadOnly(),ore=storage(amount,'int',amount.count).toReadOnly(),width=this.battle.setup.grid.width;
    const mutable=storage(this.constants,'int',this.constants.count);
    this.terrainClear=Fn(()=>{const cell=int(instanceIndex);mutable.element(cell.add(this.placementOffset)).assign(int(mutable.element(cell.add(this.placementOffset+2*amount.count)).notEqual(0).and(ore.element(cell).lessThan(0))));})().compute(amount.count);
    this.terrainCheck=Fn(()=>{
      const p=cmd.element(int(instanceIndex).add(this.createOffset+1)).mul(CHANGE_WORDS);
      If(cmd.element(p).bitAnd(CREATE).notEqual(0),()=>{
        const row=data.element(cmd.element(p.add(1))),origin=cmd.element(p.add(3));
        If(data.element(row.add(1)).equal(2),()=>{
          Loop({start:0,end:data.element(row.add(7)),type:'int'},({i})=>{
            const cell=origin.add(data.element(row.add(8).add(i.mul(2)))).add(data.element(row.add(9).add(i.mul(2))).mul(width));
            If(ore.element(cell).greaterThanEqual(0),()=>{cmd.element(p).assign(0);});
          });
        });
      });
    })().compute(1);
  }
  useAircraft(state:StorageBufferAttribute){
    const {battle}=this,index=battle.movement.actorIndex,count=battle.setup.units.length;
    const air=storage(state,'int',state.count).toReadOnly(),u=storage(battle.units,'int',battle.units.count).toReadOnly(),contacts=storage(index.buffer,'uint',index.buffer.count).toAtomic();
    this.airContacts?.dispose();
    this.airContacts=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(U.WORDS),contact=air.element(id.mul(AIR_WORDS).add(ACONTACT));
      If(u.element(at.add(U.UDOMAIN)).equal(1).and(u.element(at.add(U.UHEALTH)).greaterThan(0)).and(contact.greaterThanEqual(0))
        .and(air.element(id.mul(AIR_WORDS).add(AGENERATION)).equal(u.element(at.add(U.UGENERATION)))),()=>{atomicMin(contacts.element(contact.add(index.airOwner)),uint(id));});
    })().compute(count);
  }
  flush(){
    if(!this.changed.size)return;
    const data=this.commands.array as Int32Array,ids=[...this.changed].sort((a,b)=>a-b),creates=ids.filter(id=>data[id*CHANGE_WORDS]&CREATE);
    data[this.listOffset]=ids.length;data.set(ids,this.listOffset+1);data[this.createOffset]=creates.length;data.set(creates,this.createOffset+1);
    this.commands.addUpdateRange(this.listOffset,ids.length+1);this.commands.addUpdateRange(this.createOffset,creates.length+1);
    let occupancy=false;
    for(const id of ids){this.commands.addUpdateRange(id*CHANGE_WORDS,CHANGE_WORDS);occupancy||=!!(data[id*CHANGE_WORDS]&(CREATE|REMOVE|HEALTH));}
    this.frame.value=this.battle.frame;this.commands.needsUpdate=true;this.editPass.count=ids.length;this.battle.renderer.compute(this.editPass);
    if(creates.length){
      this.battle.movement.actorIndex.refresh();
      if(this.airContacts)this.battle.renderer.compute(this.airContacts);
      this.exitCheck.count=creates.length;if(this.terrainClear)this.battle.renderer.compute(this.terrainClear);
      if(this.terrainCheck){this.terrainCheck.count=creates.length;this.battle.renderer.compute(this.terrainCheck);}
      this.battle.renderer.compute(this.exitCheck);this.battle.renderer.compute(this.kernel);
    }
    for(const id of ids)data.fill(0,id*CHANGE_WORDS,(id+1)*CHANGE_WORDS);this.changed.clear();
    if(occupancy)this.battle.movement.refreshOccupancy();
  }
  prepareForPlay(){return this.battle.renderer.compileComputeAsync([this.kernel,this.editPass,this.exitCheck,...(this.terrainCheck?[this.terrainCheck]:[]),...(this.terrainClear?[this.terrainClear]:[]),...(this.airContacts?[this.airContacts]:[])]);}
  dispose(){this.airContacts?.dispose();this.terrainCheck?.dispose();this.terrainClear?.dispose();this.exitCheck.dispose();this.editPass.dispose();this.kernel.dispose();releaseStorage(this.battle.renderer,[this.commands,this.constants]);}
}
