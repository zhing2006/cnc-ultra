import { StorageBufferAttribute,type ComputeNode } from 'three/webgpu';
import type { WebGPURenderer,Node } from 'three/webgpu';
import { Fn,If,Break,int,uint,ivec2,storage,instanceIndex,localId,workgroupArray,workgroupBarrier,atomicAdd,atomicLoad,atomicOr,select } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { CpuFlowFields,type GpuFlowFields,type CpuFlowPolicy,type GpuFlowPolicy,FIELD_WORDS,FIELD_READY,FIELD_RESET } from '../../engine/simulation/flow.ts';
import { UNREACHABLE } from '../../engine/simulation/state.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { combatTypes } from '../data/combat.ts';
import { distance } from '../coord.ts';
import { unitDistance } from './units-nodes.ts';
import * as U from './units-state.ts';

// Equal (destination, owner, limit) requests share the lowest requesting actor's
// key. Sorting avoids a serial all-actors/all-cache-slots search each tick.
const ENTRY_WORDS=4,ACTOR_WORDS=7;
const TEAM=0,GENERATION=1,STAGE=2,LAST_GOAL=3,REQUEST_GOAL=4,REQUEST_OWNER=5,REQUEST_LIMIT=6;
function layout(setup:U.UnitsSetup){
  const count=setup.units.length,cells=setup.grid.edges.length,columns=Math.ceil(setup.grid.width/4),rows=Math.ceil(setup.grid.height/4);
  const houses=setup.houseCount??2,regions=columns*rows,actors=1,entries=actors+count*ACTOR_WORDS;
  const risk=entries+count*ENTRY_WORDS,raw=risk+count,threat=raw+houses*regions,visible=threat+houses*regions;
  const nextVisible=visible+cells,visibilityChanges=nextVisible+cells,types=visibilityChanges+regions;
  const sorted=types+combatTypes.length,sortCount=2**Math.ceil(Math.log2(Math.max(1,count))),data=new Int32Array(sorted+sortCount);
  for(let id=0;id<count;id++){data[actors+id*ACTOR_WORDS+TEAM]=-1;data[actors+id*ACTOR_WORDS+LAST_GOAL]=-1;data[entries+id*ENTRY_WORDS]=-1;}
  combatTypes.forEach((type,id)=>data[types+id]=type.risk);
  return {count,cells,columns,rows,houses,regions,actors,entries,risk,raw,threat,visible,nextVisible,visibilityChanges,types,sorted,sortCount,data};
}
type Layout=ReturnType<typeof layout>;
function setTeams(l:Layout,groups:readonly number[][],generations:ArrayLike<number>,update?:(start:number,count:number)=>void){
  const membership=new Int32Array(l.count).fill(-1);
  for(const ids of groups)for(const id of ids)membership[id]=ids[0];
  for(let id=0;id<l.count;id++){
    const at=l.actors+id*ACTOR_WORDS,team=membership[id],generation=generations[id]??0;
    if(l.data[at+TEAM]===team&&l.data[at+GENERATION]===generation)continue;
    l.data[at+TEAM]=team;l.data[at+GENERATION]=generation;
    l.data[at+STAGE]=0;l.data[at+LAST_GOAL]=-1;
    update?.(at,4);
  }
}

/** Ported from FINDPATH.CPP Find_Path/Passable_Cell and HOUSE.CPP Adjust_Threat. */
export class CpuCampaignRouting {
  readonly layout:Layout;
  readonly goals:Int32Array;
  readonly policy:CpuFlowPolicy;
  visible?:Int32Array;
  constructor(readonly setup:U.UnitsSetup,readonly units:Int32Array,readonly paths:Int32Array){
    const l=this.layout=layout(setup),d=l.data;this.goals=new Int32Array(l.count).fill(-1);
    this.policy={keys:l.cells+l.count,target:key=>key<l.cells?key:d[l.entries+(key-l.cells)*ENTRY_WORDS],allows:(cell,key)=>{
      if(key<l.cells)return true;
      const at=l.entries+(key-l.cells)*ENTRY_WORDS,target=d[at];
      if(distance(cell%setup.grid.width,Math.trunc(cell/setup.grid.width),target%setup.grid.width,Math.trunc(target/setup.grid.width))<=5)return true;
      const region=Math.trunc(cell%setup.grid.width/4)+Math.trunc(cell/setup.grid.width/4)*l.columns;
      return Math.max(d[l.threat+d[at+1]*l.regions+region],d[l.visible+cell]?1:0)<=d[at+2];
    }};
  }
  setTeams(groups:readonly number[][],generations:ArrayLike<number>){setTeams(this.layout,groups,generations);}
  key(id:number,goal:number){return this.layout.data[this.layout.actors+id*ACTOR_WORDS+LAST_GOAL]===goal?this.goals[id]:goal;}
  step(flow:CpuFlowFields){
    const l=this.layout,d=l.data,u=this.units,width=this.setup.grid.width;
    d.fill(0,l.risk,l.threat);
    for(let id=0;id<l.count;id++){
      const at=id*U.WORDS,p=l.actors+id*ACTOR_WORDS,team=d[p+TEAM];
      if(u[at+U.UHEALTH]<=0)continue;
      const risk=d[l.types+u[at+U.UTYPE]];
      if(team>=0&&d[p+GENERATION]===u[at+U.UGENERATION])d[l.risk+team]+=risk;
      if(u[at+U.UATTACHED])continue;
      const x=Math.trunc(u[at+U.UCELL]%width/4),y=Math.trunc(u[at+U.UCELL]/width/4),owner=u[at+U.UOWNER];
      for(let house=0;house<l.houses;house++){
        // CELL.CPP Adjust_Threat: AI houses also count allied objects as threats.
        if(house===owner||house===0&&((this.setup.allies?.[0]??1)&1<<owner))continue;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<l.columns&&y+dy>=0&&y+dy<l.rows)
          d[l.raw+house*l.regions+(y+dy)*l.columns+x+dx]+=risk>>(Math.abs(dx)+Math.abs(dy));
      }
    }
    d[0]=0;d.fill(0,l.visibilityChanges,l.types);
    for(let i=0;i<l.houses*l.regions;i++)if(d[l.threat+i]!==d[l.raw+i])d[0]|=1<<Math.trunc(i/l.regions);
    for(let i=0;i<l.cells;i++){
      const value=Number(this.visible!==undefined&&this.visible[i]!==-2);d[l.nextVisible+i]=value;
      if(d[l.visible+i]!==value){d[l.visibilityChanges+Math.trunc(i%width/4)+Math.trunc(i/width/4)*l.columns]=1;d[0]|=(1<<l.houses)-1;}
    }
    for(let slot=0;slot<l.count;slot++)d[l.entries+slot*ENTRY_WORDS+3]=0;
    for(let id=0;id<l.count;id++){
      const at=id*U.WORDS,p=l.actors+id*ACTOR_WORDS,goal=this.paths[id],team=d[p+TEAM],old=this.goals[id];
      if(goal!==d[p+LAST_GOAL])d[p+STAGE]=0;
      else if(old>=l.cells){const field=flow.lookup[old];if(field>=0&&flow.fields[field*FIELD_WORDS+FIELD_READY]&&flow.distance[field*l.cells+u[at+U.UCELL]]===UNREACHABLE)d[p+STAGE]=Math.min(3,d[p+STAGE]+1);}
      d[p+LAST_GOAL]=goal;this.goals[id]=goal;
      d[p+REQUEST_GOAL]=-1;
      if(goal<0||team<0||d[p+STAGE]>=3||d[p+GENERATION]!==u[at+U.UGENERATION]||u[at+U.UHEALTH]<=0||u[at+U.UATTACHED]||u[at+U.UDOMAIN]||u[at+U.UOWNER]===0&&(u[at+U.UFLAGS]&U.PLAYER_ORDER))continue;
      const risk=d[l.risk+team],limit=d[p+STAGE]===0?0:d[p+STAGE]===1?risk>>1:risk+(risk>>1);
      d[p+REQUEST_GOAL]=goal;d[p+REQUEST_OWNER]=u[at+U.UOWNER];d[p+REQUEST_LIMIT]=limit;
    }
    const compare=(a:number,b:number)=>{
      const pa=l.actors+a*ACTOR_WORDS,pb=l.actors+b*ACTOR_WORDS;
      const activeA=a<l.count&&d[pa+REQUEST_GOAL]>=0,activeB=b<l.count&&d[pb+REQUEST_GOAL]>=0;
      if(!activeA||!activeB)return Number(activeB)-Number(activeA)||a-b;
      return d[pa+REQUEST_GOAL]-d[pb+REQUEST_GOAL]||d[pa+REQUEST_OWNER]-d[pb+REQUEST_OWNER]||d[pa+REQUEST_LIMIT]-d[pb+REQUEST_LIMIT]||a-b;
    };
    const sorted=d.subarray(l.sorted,l.sorted+l.sortCount);for(let i=0;i<l.sortCount;i++)sorted[i]=i;sorted.sort(compare);
    let representative=-1;
    for(const id of sorted){
      const p=l.actors+id*ACTOR_WORDS;if(id>=l.count||d[p+REQUEST_GOAL]<0)break;
      const prior=l.actors+representative*ACTOR_WORDS;
      if(representative<0||[REQUEST_GOAL,REQUEST_OWNER,REQUEST_LIMIT].some(field=>d[p+field]!==d[prior+field])){
        representative=id;const e=l.entries+id*ENTRY_WORDS;
        d[e+3]=[0,1,2].some(field=>d[e+field]!==d[p+REQUEST_GOAL+field])?2:0;
        d.set(d.subarray(p+REQUEST_GOAL,p+REQUEST_LIMIT+1),e);
      }
      this.goals[id]=l.cells+representative;
    }
    for(let slot=0;slot<flow.capacity;slot++){
      const at=slot*FIELD_WORDS,key=flow.fields[at];if(key<l.cells)continue;
      const e=l.entries+(key-l.cells)*ENTRY_WORDS,target=d[e],owner=d[e+1],limit=d[e+2];let changed=!!d[e+3];
      if(!changed&&(d[0]&1<<owner))for(let region=0;region<l.regions&&!changed;region++){
        const old=d[l.threat+owner*l.regions+region],next=d[l.raw+owner*l.regions+region];
        if((old<=limit)===(next<=limit)&&!(limit===0&&(old===0||next===0)&&d[l.visibilityChanges+region]))continue;
        for(let bit=0;bit<16;bit++){
          const x=region%l.columns*4+bit%4,y=Math.trunc(region/l.columns)*4+Math.trunc(bit/4),cell=y*width+x;
          if(x>=width||y>=this.setup.grid.height||distance(x,y,target%width,Math.trunc(target/width))<=5)continue;
          if((Math.max(old,d[l.visible+cell])<=limit)!==(Math.max(next,d[l.nextVisible+cell])<=limit)){changed=true;break;}
        }
      }
      if(changed){flow.fields[at+FIELD_READY]=0;flow.fields[at+FIELD_RESET]=1;}
    }
    d.copyWithin(l.threat,l.raw,l.raw+l.houses*l.regions);d.copyWithin(l.visible,l.nextVisible,l.nextVisible+l.cells);d[0]=0;
  }
}

export class GpuCampaignRouting {
  readonly layout:Layout;
  readonly data:StorageBufferAttribute;
  readonly goals:StorageBufferAttribute;
  readonly policy:GpuFlowPolicy;
  readonly kernels:ComputeNode[]=[];
  private readonly attributes:StorageBufferAttribute[];
  constructor(readonly renderer:WebGPURenderer,readonly setup:U.UnitsSetup,readonly units:StorageBufferAttribute,readonly paths:StorageBufferAttribute){
    const l=this.layout=layout(setup),width=setup.grid.width;
    this.data=new StorageBufferAttribute(l.data,1);this.goals=new StorageBufferAttribute(new Int32Array(l.count).fill(-1),1);this.attributes=[this.data,this.goals];
    const data=storage(this.data,'int',this.data.count).toReadOnly();
    this.policy={keys:l.cells+l.count,target:key=>Fn(()=>{const target=key.toVar();If(key.greaterThanEqual(l.cells),()=>{target.assign(data.element(key.sub(l.cells).mul(ENTRY_WORDS).add(l.entries)));});return target;})(),
      allows:(cell,key)=>Fn(()=>{
        const allowed=int(1).toVar();If(key.greaterThanEqual(l.cells),()=>{
          const at=key.sub(l.cells).mul(ENTRY_WORDS).add(l.entries),target=data.element(at);
          const region=cell.mod(width).div(4).add(cell.div(width).div(4).mul(l.columns)),threat=data.element(data.element(at.add(1)).mul(l.regions).add(region).add(l.threat));
          const value=select(threat.equal(0).and(data.element(cell.add(l.visible)).notEqual(0)),int(1),threat);
          allowed.assign(int(unitDistance(ivec2(cell.mod(width),cell.div(width)),ivec2(target.mod(width),target.div(width))).lessThanEqual(5).or(value.lessThanEqual(data.element(at.add(2))))));
        });return allowed.notEqual(0);
      })()};
  }
  get saveBuffers(){return this.attributes;}
  setTeams(groups:readonly number[][],generations:ArrayLike<number>){setTeams(this.layout,groups,generations,(start,count)=>{this.data.addUpdateRange(start,count);this.data.needsUpdate=true;});}
  copySight(sight:StorageBufferAttribute){
    const l=this.layout,width=this.setup.grid.width,d=storage(this.data,'int',this.data.count),s=storage(sight,'int',sight.count).toReadOnly();
    const pass=Fn(()=>{
      const region=int(instanceIndex),changed=int(0).toVar();
      Loop(16,({i})=>{
        const x=region.mod(l.columns).mul(4).add(i.mod(4)),y=region.div(l.columns).mul(4).add(i.div(4)),cell=y.mul(width).add(x);
        If(x.lessThan(width).and(y.lessThan(this.setup.grid.height)),()=>{
          const value=int(s.element(cell).notEqual(-2));d.element(cell.add(l.nextVisible)).assign(value);
          If(d.element(cell.add(l.visible)).notEqual(value),()=>{changed.assign(1);});
        });
      });d.element(region.add(l.visibilityChanges)).assign(changed);
    })().compute(l.regions);
    this.kernels.push(pass);return pass;
  }
  connect(flow:GpuFlowFields,proposals:StorageBufferAttribute,words:number,keyOffset:number){
    const l=this.layout,width=this.setup.grid.width,d=storage(this.data,'int',this.data.count),a=storage(this.data,'int',this.data.count).toAtomic();
    const u=storage(this.units,'int',this.units.count).toReadOnly(),paths=storage(this.paths,'int',l.count).toReadOnly(),keys=storage(this.goals,'int',l.count);
    const meta=storage(flow.fields,'int',flow.fields.count),lookup=storage(flow.lookup,'int',flow.lookup.count).toReadOnly(),dist=storage(flow.distance,'int',flow.distance.count).toReadOnly();
    const clear=Fn(()=>{
      const i=int(instanceIndex);If(i.equal(0),()=>{d.element(0).assign(0);});
      If(i.lessThan(l.count),()=>{d.element(i.add(l.risk)).assign(0);d.element(i.mul(ENTRY_WORDS).add(l.entries+3)).assign(0);});
      If(i.lessThan(l.houses*l.regions),()=>{d.element(i.add(l.raw)).assign(0);});
    })().compute(Math.max(l.count,l.houses*l.regions));
    const threats=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(U.WORDS),p=id.mul(ACTOR_WORDS).add(l.actors),team=atomicLoad(a.element(p.add(TEAM)));
      If(u.element(at.add(U.UHEALTH)).greaterThan(0),()=>{
        const risk=atomicLoad(a.element(u.element(at.add(U.UTYPE)).add(l.types)));
        If(team.greaterThanEqual(0).and(atomicLoad(a.element(p.add(GENERATION))).equal(u.element(at.add(U.UGENERATION)))),()=>{atomicAdd(a.element(team.add(l.risk)),risk);});
        If(u.element(at.add(U.UATTACHED)).equal(0),()=>{
          const cell=u.element(at.add(U.UCELL)),x=cell.mod(width).div(4),y=cell.div(width).div(4),owner=u.element(at.add(U.UOWNER));
          for(let house=0;house<l.houses;house++){
            const ally=house===0?int(setupAllies(this.setup)).bitAnd(int(1).shiftLeft(owner)).notEqual(0):int(0).notEqual(0);
            If(owner.notEqual(house).and(ally.not()),()=>{
              for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
                const xx=x.add(dx),yy=y.add(dy);
                If(xx.greaterThanEqual(0).and(xx.lessThan(l.columns)).and(yy.greaterThanEqual(0)).and(yy.lessThan(l.rows)),()=>{atomicAdd(a.element(yy.mul(l.columns).add(xx).add(l.raw+house*l.regions)),risk.shiftRight(Math.abs(dx)+Math.abs(dy)));});
              }
            });
          }
        });
      });
    })().compute(l.count);
    const changedOwners=Fn(()=>{
      const i=int(instanceIndex);
      If(atomicLoad(a.element(i.add(l.raw))).notEqual(atomicLoad(a.element(i.add(l.threat)))),()=>{atomicOr(a.element(0),int(1).shiftLeft(i.div(l.regions)));});
      If(i.lessThan(l.regions),()=>{If(atomicLoad(a.element(i.add(l.visibilityChanges))).notEqual(0),()=>{atomicOr(a.element(0),int((1<<l.houses)-1));});});
    })().compute(l.houses*l.regions);
    const requests=Fn(()=>{
      const id=int(instanceIndex);d.element(id.add(l.sorted)).assign(id);
      If(id.lessThan(l.count),()=>{
        const at=id.mul(U.WORDS),p=id.mul(ACTOR_WORDS).add(l.actors),goal=paths.element(id),old=keys.element(id).toVar(),team=d.element(p.add(TEAM));
        If(goal.notEqual(d.element(p.add(LAST_GOAL))),()=>{d.element(p.add(STAGE)).assign(0);})
          .ElseIf(old.greaterThanEqual(l.cells),()=>{const field=lookup.element(old);If(field.greaterThanEqual(0).and(meta.element(field.mul(FIELD_WORDS).add(FIELD_READY)).notEqual(0)).and(dist.element(field.mul(l.cells).add(u.element(at.add(U.UCELL)))).equal(UNREACHABLE)),()=>{If(d.element(p.add(STAGE)).lessThan(3),()=>{d.element(p.add(STAGE)).addAssign(1);});});});
        d.element(p.add(LAST_GOAL)).assign(goal);keys.element(id).assign(goal);
        d.element(p.add(REQUEST_GOAL)).assign(-1);
        If(goal.greaterThanEqual(0).and(team.greaterThanEqual(0)).and(d.element(p.add(STAGE)).lessThan(3)).and(d.element(p.add(GENERATION)).equal(u.element(at.add(U.UGENERATION)))).and(u.element(at.add(U.UHEALTH)).greaterThan(0)).and(u.element(at.add(U.UATTACHED)).equal(0)).and(u.element(at.add(U.UDOMAIN)).equal(0)).and(u.element(at.add(U.UOWNER)).notEqual(0).or(u.element(at.add(U.UFLAGS)).bitAnd(U.PLAYER_ORDER).equal(0))),()=>{
          const risk=d.element(team.add(l.risk)),limit=select(d.element(p.add(STAGE)).equal(0),int(0),select(d.element(p.add(STAGE)).equal(1),risk.shiftRight(1),risk.add(risk.shiftRight(1))));
          d.element(p.add(REQUEST_GOAL)).assign(goal);d.element(p.add(REQUEST_OWNER)).assign(u.element(at.add(U.UOWNER)));d.element(p.add(REQUEST_LIMIT)).assign(limit);
        });
      });
    })().compute(l.sortCount);
    const less=(left:Node<'int'>,right:Node<'int'>,tie=true)=>Fn(()=>{
      const goalA=int(0x7fffffff).toVar(),goalB=int(0x7fffffff).toVar(),ownerA=int(0).toVar(),ownerB=int(0).toVar(),limitA=int(0).toVar(),limitB=int(0).toVar();
      const read=(id:Node<'int'>,goal:Node<'int'>,owner:Node<'int'>,limit:Node<'int'>)=>{
        If(id.lessThan(l.count),()=>{const p=id.mul(ACTOR_WORDS).add(l.actors);If(d.element(p.add(REQUEST_GOAL)).greaterThanEqual(0),()=>{goal.assign(d.element(p.add(REQUEST_GOAL)));owner.assign(d.element(p.add(REQUEST_OWNER)));limit.assign(d.element(p.add(REQUEST_LIMIT)));});});
      };read(left,goalA,ownerA,limitA);read(right,goalB,ownerB,limitB);
      return goalA.lessThan(goalB).or(goalA.equal(goalB).and(ownerA.lessThan(ownerB).or(ownerA.equal(ownerB).and(limitA.lessThan(limitB).or(limitA.equal(limitB).and(tie?left.lessThan(right):int(0).notEqual(0)))))));
    })();
    const sorts:ComputeNode[]=[];
    if(l.sortCount<=1024){
      // The normal 512-actor campaign fits in 2 KB of shared memory. One
      // workgroup sorts in parallel without dispatching each network stage.
      const shared=workgroupArray('int',l.sortCount) as unknown as {element(index:Node<'uint'>):Node<'int'>};
      const sort=Fn(()=>{
        const lane=int(localId.x);
        Loop({start:lane,end:l.sortCount,update:'+= 128'},({i})=>{shared.element(uint(i)).assign(i);});workgroupBarrier();
        Loop(Math.log2(l.sortCount),({i:level})=>{
          const span=int(2).shiftLeft(level);
          Loop({start:level,end:0,condition:'>=',update:'--'},({i:step})=>{
            const stride=int(1).shiftLeft(step);
            Loop({start:lane,end:l.sortCount,update:'+= 128'},({i})=>{
              const other=i.bitXor(stride);
              If(i.lessThan(other),()=>{
                const left=shared.element(uint(i)).toVar(),right=shared.element(uint(other)).toVar();
                If(select(i.bitAnd(span).equal(0),less(right,left),less(left,right)),()=>{shared.element(uint(i)).assign(right);shared.element(uint(other)).assign(left);});
              });
            });workgroupBarrier();
          });
        });
        Loop({start:lane,end:l.sortCount,update:'+= 128'},({i})=>{d.element(i.add(l.sorted)).assign(shared.element(uint(i)));});
      })().computeKernel([128]);sort.dispatchSize=[1,1,1];sorts.push(sort);
    }else{
      // Larger custom campaign capacities keep the same bounded sorting network.
      for(let span=2;span<=l.sortCount;span*=2)for(let stride=span/2;stride>=1;stride/=2)sorts.push(Fn(()=>{
        const id=int(instanceIndex),other=id.bitXor(stride);
        If(id.lessThan(other),()=>{
          const left=d.element(id.add(l.sorted)).toVar(),right=d.element(other.add(l.sorted)).toVar();
          If(select(id.bitAnd(span).equal(0),less(right,left),less(left,right)),()=>{d.element(id.add(l.sorted)).assign(right);d.element(other.add(l.sorted)).assign(left);});
        });
      })().compute(l.sortCount));
    }
    const encode=Fn(()=>{
      const id=int(instanceIndex),p=id.mul(ACTOR_WORDS).add(l.actors);
      If(d.element(p.add(REQUEST_GOAL)).greaterThanEqual(0),()=>{
        const low=int(0).toVar(),high=int(l.sortCount).toVar();
        Loop(()=>{If(low.greaterThanEqual(high),()=>{Break();});const mid=low.add(high).div(2).toVar();If(less(d.element(mid.add(l.sorted)),id,false),()=>{low.assign(mid.add(1));}).Else(()=>{high.assign(mid);});});
        const representative=d.element(low.add(l.sorted));keys.element(id).assign(representative.add(l.cells));
        If(representative.equal(id),()=>{
          const e=id.mul(ENTRY_WORDS).add(l.entries),changed=d.element(e).notEqual(d.element(p.add(REQUEST_GOAL))).or(d.element(e.add(1)).notEqual(d.element(p.add(REQUEST_OWNER)))).or(d.element(e.add(2)).notEqual(d.element(p.add(REQUEST_LIMIT))));
          d.element(e.add(3)).assign(select(changed,int(2),int(0)));
          for(let j=0;j<3;j++)d.element(e.add(j)).assign(d.element(p.add(REQUEST_GOAL+j)));
        });
      });
    })().compute(l.count);
    const invalidate=Fn(()=>{
      const at=int(instanceIndex).mul(FIELD_WORDS),key=meta.element(at);
      If(key.greaterThanEqual(l.cells),()=>{
        const e=key.sub(l.cells).mul(ENTRY_WORDS).add(l.entries),target=d.element(e),owner=d.element(e.add(1)),limit=d.element(e.add(2)),changed=d.element(e.add(3)).notEqual(0).toVar();
        If(changed.not().and(d.element(0).bitAnd(int(1).shiftLeft(owner)).notEqual(0)),()=>{
          Loop(l.regions,({i:region})=>{
            const old=d.element(owner.mul(l.regions).add(region).add(l.threat)),next=d.element(owner.mul(l.regions).add(region).add(l.raw));
            If(int(old.lessThanEqual(limit)).notEqual(int(next.lessThanEqual(limit))).or(limit.equal(0).and(old.equal(0).or(next.equal(0))).and(d.element(region.add(l.visibilityChanges)).notEqual(0))),()=>{
              Loop(16,({i:bit})=>{
                const x=region.mod(l.columns).mul(4).add(bit.mod(4)),y=region.div(l.columns).mul(4).add(bit.div(4)),cell=y.mul(width).add(x);
                If(x.lessThan(width).and(y.lessThan(this.setup.grid.height)).and(unitDistance(ivec2(x,y),ivec2(target.mod(width),target.div(width))).greaterThan(5)),()=>{
                  const before=old.lessThanEqual(limit).and(limit.greaterThan(0).or(d.element(cell.add(l.visible)).equal(0)));
                  const after=next.lessThanEqual(limit).and(limit.greaterThan(0).or(d.element(cell.add(l.nextVisible)).equal(0)));
                  If(int(before).notEqual(int(after)),()=>{changed.assign(true);Break();});
                });
              });
            });If(changed,()=>{Break();});
          });
        });
        If(changed,()=>{meta.element(at.add(FIELD_READY)).assign(0);meta.element(at.add(FIELD_RESET)).assign(1);});
      });
    })().compute(flow.capacity);
    const publish=Fn(()=>{
      const i=int(instanceIndex);If(i.equal(0),()=>{d.element(0).assign(0);});If(i.lessThan(l.houses*l.regions),()=>{d.element(i.add(l.threat)).assign(d.element(i.add(l.raw)));});
      If(i.lessThan(l.cells),()=>{d.element(i.add(l.visible)).assign(d.element(i.add(l.nextVisible)));});
    })().compute(Math.max(l.cells,l.houses*l.regions));
    const proposal=storage(proposals,'int',proposals.count);
    const snapshot=Fn(()=>{proposal.element(int(instanceIndex).mul(words).add(keyOffset)).assign(keys.element(instanceIndex));})().compute(l.count);
    const passes=[clear,threats,changedOwners,requests,...sorts,encode,invalidate,publish,snapshot];this.kernels.push(...passes);return passes;
  }
  dispose(){for(const kernel of this.kernels)kernel.dispose();releaseStorage(this.renderer,this.attributes);}
}
function setupAllies(setup:U.UnitsSetup){return setup.allies?.[0]??1;}
