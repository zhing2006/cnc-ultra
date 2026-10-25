import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { Fn, If, int, ivec2, storage, abs, select } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { DIRECTIONS } from '../../engine/simulation/state.ts';
import { intMax, intMin } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { combatTypes } from '../data/combat.ts';
import { GROUND_SPEED, MOVEMENT, movementType } from '../data/movement.ts';
import { distance } from '../coord.ts';
import { cellFacing } from '../simulation/navigation.ts';
import { unitDistance } from '../simulation/units-nodes.ts';
import type { CpuCombat } from '../simulation/combat-cpu.ts';
import type { GpuCombat } from '../simulation/combat-gpu.ts';
import * as U from '../simulation/units-state.ts';

/** Ported from TEAM.CPP AI, FINDPATH.CPP Safety_Point and HOUSE.CPP Adjust_Threat. */
export function teamRetreatCell(battle:CpuCombat,leader:number,center:number){
  const {width,height}=battle.setup.grid,u=battle.units,owner=u[leader*U.WORDS+U.UOWNER],type=MOVEMENT[u[leader*U.WORDS+U.UTYPE]];
  const bounds=battle.setup.bounds??{x:0,y:0,width,height};
  const clear=(cell:number)=>{
    const x=cell%width,y=Math.trunc(cell/width);
    if(x<bounds.x||x>=bounds.x+bounds.width||y<bounds.y||y>=bounds.y+bounds.height||!(battle.setup.passable?battle.setup.passable[cell]:battle.setup.grid.edges[cell])||!GROUND_SPEED[battle.setup.land[cell]][type.locomotion])return false;
    let free=0;
    for(let spot=0;spot<5;spot++){const occupier=battle.movement.occupancy[cell*5+spot];if(!occupier||occupier===leader+1)free++;}
    return free>=(type.infantry?1:5);
  };
  let chosen=center,best=0x7fffffff;
  for(let id=0;id<battle.setup.units.length;id++){
    const p=id*U.WORDS,t=combatTypes[u[p+U.UTYPE]];
    if(u[p+U.UHEALTH]<=0||u[p+U.UATTACHED]||u[p+U.UOWNER]!==owner||u[p+U.UDOMAIN]!==2||t.primary>=0)continue;
    const x=Math.trunc(u[p]/256),y=Math.trunc(u[p+1]/256),cell=y*width+x;
    let threat=0;
    for(let other=0;other<battle.setup.units.length;other++){
      const q=other*U.WORDS;
      if(u[q+U.UHEALTH]<=0||u[q+U.UATTACHED]||u[q+U.UOWNER]===owner)continue;
      const dx=Math.abs(Math.trunc(x/4)-Math.trunc(u[q+U.UCELL]%width/4)),dy=Math.abs(Math.trunc(y/4)-Math.trunc(Math.trunc(u[q+U.UCELL]/width)/4));
      if(dx<=1&&dy<=1)threat+=combatTypes[u[q+U.UTYPE]].risk>>(dx+dy);
    }
    if(!threat&&battle.sight.mapped[cell])threat=1;
    let score=distance(center%width,Math.trunc(center/width),x,y)*(threat+1);
    if(t.name==='FIX')score>>=1;
    if(score>=best)continue;
    const facing=((cellFacing(center,cell,width)^4)-1)&7;
    let safe=-1;
    for(let radius=2;radius<4&&safe<0;radius++){
      const [dx,dy]=DIRECTIONS[facing];let next=cell+(dy*width+dx)*radius;
      for(let step=0;step<radius*2;step++){
        const dir=(facing+(facing&1?3:step<radius?2:4))&7;
        next+=DIRECTIONS[dir][1]*width+DIRECTIONS[dir][0];
        if(clear(next)){safe=next;break;}
      }
    }
    if(safe>=0){chosen=safe;best=score;}
  }
  return chosen;
}

/** Evaluated only when a damaged team starts retreating, never for every actor each tick. */
export class TeamRetreatPlanner {
  private readonly data:StorageBufferAttribute;
  private readonly updateMap:(_edges:Uint32Array,passable:Uint8Array,land:Uint8Array)=>void;
  readonly find:(leader:Node<'int'>,center:Node<'ivec2'>)=>Node<'int'>;
  constructor(private readonly battle:GpuCombat){
    const {width,height}=battle.setup.grid,cells=width*height,typeBase=cells,dirBase=typeBase+MOVEMENT.length*3;
    const values=new Int32Array(dirBase+16);
    for(let cell=0;cell<cells;cell++)if(battle.setup.passable?battle.setup.passable[cell]:battle.setup.grid.edges[cell])values[cell]=GROUND_SPEED[battle.setup.land[cell]].reduce((mask,speed,i)=>mask|(speed?1<<i:0),0);
    combatTypes.forEach((type,i)=>values.set([type.primary,type.risk,MOVEMENT[i].locomotion],typeBase+i*3));
    values.set(DIRECTIONS.flat(),dirBase);this.data=new StorageBufferAttribute(values,1);
    this.updateMap=(_edges,passable,land)=>{
      for(let cell=0;cell<cells;cell++)values[cell]=passable[cell]?GROUND_SPEED[land[cell]].reduce((mask,speed,i)=>mask|(speed?1<<i:0),0):0;
      this.data.addUpdateRange(0,cells);this.data.needsUpdate=true;
    };
    battle.movement.mapObservers.add(this.updateMap);
    const u=storage(battle.units,'int',battle.units.count).toReadOnly(),data=storage(this.data,'int',values.length).toReadOnly();
    const occupancy=storage(battle.movement.occupancy,'uint',cells*5).toReadOnly(),visible=storage(battle.sight.mapped,'int',cells).toReadOnly();
    const bounds=battle.setup.bounds??{x:0,y:0,width,height};
    const step=(dir:Node<'int'>)=>{const at=dir.bitAnd(7).mul(2).add(dirBase);return data.element(at).add(data.element(at.add(1)).mul(width));};
    this.find=(leader,center)=>Fn(()=>{
      const at=leader.mul(U.WORDS),owner=u.element(at.add(U.UOWNER)),chosen=center.y.mul(width).add(center.x).toVar(),best=int(0x7fffffff).toVar();
      const locomotion=data.element(u.element(at.add(U.UTYPE)).mul(3).add(typeBase+2));
      Loop(battle.setup.units.length,({i:id})=>{
        const p=id.mul(U.WORDS),type=u.element(p.add(U.UTYPE));
        If(u.element(p.add(U.UHEALTH)).greaterThan(0).and(u.element(p.add(U.UATTACHED)).equal(0)).and(u.element(p.add(U.UOWNER)).equal(owner)).and(u.element(p.add(U.UDOMAIN)).equal(2)).and(data.element(type.mul(3).add(typeBase)).lessThan(0)),()=>{
          const point=ivec2(u.element(p),u.element(p.add(1))).div(256).toVar(),cell=point.y.mul(width).add(point.x),threat=int(0).toVar();
          Loop(battle.setup.units.length,({i:other})=>{
            const q=other.mul(U.WORDS),where=u.element(q.add(U.UCELL));
            If(u.element(q.add(U.UHEALTH)).greaterThan(0).and(u.element(q.add(U.UATTACHED)).equal(0)).and(u.element(q.add(U.UOWNER)).notEqual(owner)),()=>{
              const delta=abs(point.div(4).sub(ivec2(where.mod(width).div(4),where.div(width).div(4))));
              If(delta.x.lessThanEqual(1).and(delta.y.lessThanEqual(1)),()=>{threat.addAssign(data.element(u.element(q.add(U.UTYPE)).mul(3).add(typeBase+1)).shiftRight(delta.x.add(delta.y)));});
            });
          });
          If(threat.equal(0).and(visible.element(cell).notEqual(0)),()=>{threat.assign(1);});
          const score=unitDistance(center,point).mul(threat.add(1)).toVar();If(type.equal(movementType('FIX')),()=>{score.shiftRightAssign(1);});
          If(score.lessThan(best),()=>{
            // FACING8.ASM Desired_Facing8, also used by CELL_FACING in Safety_Point.
            const delta=point.sub(center),d=abs(delta),facing=select(delta.x.lessThan(0),select(delta.y.greaterThan(0),int(5),int(7)),select(delta.y.greaterThan(0),int(3),int(1))).toVar();
            If(intMin(d.x,d.y).lessThan(intMax(d.x,d.y).add(1).shiftRight(1)),()=>{facing.assign(select(d.x.greaterThanEqual(d.y),select(delta.x.lessThan(0),int(6),int(2)),select(delta.y.lessThan(0),int(0),int(4))));});
            facing.assign(facing.bitXor(4).sub(1).bitAnd(7));const safe=int(-1).toVar();
            Loop({start:int(2),end:int(4),type:'int',condition:'<'},({i:radius})=>{
              const next=cell.add(step(facing).mul(radius)).toVar();
              Loop(radius.mul(2),({i:index})=>{
                const turn=select(facing.bitAnd(1).notEqual(0),int(3),select(index.lessThan(radius),int(2),int(4)));
                next.addAssign(step(facing.add(turn)));
                const x=next.mod(width),y=next.div(width);
                If(safe.lessThan(0).and(x.greaterThanEqual(bounds.x)).and(x.lessThan(bounds.x+bounds.width)).and(y.greaterThanEqual(bounds.y)).and(y.lessThan(bounds.y+bounds.height)).and(data.element(next).bitAnd(int(1).shiftLeft(locomotion)).notEqual(0)),()=>{
                  const free=int(0).toVar();Loop(5,({i:spot})=>{const occupier=int(occupancy.element(next.mul(5).add(spot)));If(occupier.equal(0).or(occupier.equal(leader.add(1))),()=>{free.addAssign(1);});});
                  If(free.greaterThanEqual(select(u.element(at.add(U.UKIND)).notEqual(0),int(1),int(5))),()=>{safe.assign(next);});
                });
              });
            });
            If(safe.greaterThanEqual(0),()=>{chosen.assign(safe);best.assign(score);});
          });
        });
      });return chosen;
    })();
  }
  dispose(){this.battle.movement.mapObservers.delete(this.updateMap);releaseStorage(this.battle.renderer,[this.data]);}
}
