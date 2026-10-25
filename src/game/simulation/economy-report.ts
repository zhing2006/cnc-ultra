import { StorageBufferAttribute,ReadbackBuffer,type ComputeNode } from 'three/webgpu';
import { Fn,If,int,uint,instanceIndex,storage,select,atomicAdd,atomicStore,atomicMax,atomicLoad } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { intMax,intMin } from '../../engine/simulation/integer-nodes.ts';
import { GpuPrefixSum } from '../../engine/simulation/prefix-sum.ts';
import type { GpuCombat } from './combat-gpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
import { movementType,MOVEMENT } from '../data/movement.ts';
import { HBASE,HWORDS,HLOAD } from './harvest-cpu.ts';
import { SERVICE_BASE,SERVICE_WORDS,SMODE,SFACILITY } from './services-cpu.ts';

export const REPORT_HEADER=18,REPORT_RECORD=8;
/** CPU decisions receive requested actors, account totals and a bounded list of reusable slots. */
export class EconomyReport {
  readonly result:StorageBufferAttribute;
  readonly requests:StorageBufferAttribute;
  readonly kernels:ComputeNode[];
  private readonly facts:ComputeNode;
  private readonly scratch:StorageBufferAttribute;
  private readonly available:StorageBufferAttribute;
  private readonly freePrefix:GpuPrefixSum;
  private readonly readback:ReadbackBuffer;
  private requested=0;
  private freeLimit=0;
  private bytes=REPORT_HEADER*4;
  get readbackBytes(){return this.bytes;}
  constructor(readonly battle:GpuCombat,ledger:StorageBufferAttribute,transport:StorageBufferAttribute,services:StorageBufferAttribute){
    const count=battle.setup.units.length;
    this.result=new StorageBufferAttribute(new Int32Array(REPORT_HEADER+count*(REPORT_RECORD+2)),1);
    this.requests=new StorageBufferAttribute(new Int32Array(count+3),1);(this.requests.array as Int32Array)[0]=-1;
    const initial=new Int32Array(count*4+1);initial.fill(-1000,count,count*2);
    for(const [id,unit] of battle.setup.units.entries())initial[id]=unit.health??MOVEMENT[unit.type].strength;
    this.scratch=new StorageBufferAttribute(initial,1);this.available=new StorageBufferAttribute(new Uint32Array(count),1);
    this.freePrefix=new GpuPrefixSum(battle.renderer,this.available,count);
    this.readback=new ReadbackBuffer(this.result.array.byteLength);
    const u=storage(battle.units,'int',battle.units.count).toReadOnly(),combat=storage(battle.state,'int',battle.state.count).toReadOnly();
    const result=storage(this.result,'int',this.result.count),request=storage(this.requests,'int',this.requests.count).toReadOnly();
    const goals=storage(battle.movement.goals,'int',count).toReadOnly(),clock=storage(battle.movement.control,'int',2).toReadOnly();
    const credits=storage(ledger,'int',ledger.count).toReadOnly(),deliveries=storage(transport,'int',transport.count).toReadOnly(),repairs=storage(services,'int',services.count).toReadOnly();
    const scratch=storage(this.scratch,'int',initial.length),totals=storage(this.scratch,'int',initial.length).toAtomic();
    const available=storage(this.available,'uint',count),prefix=storage(this.freePrefix.output,'uint',count+1).toReadOnly();
    const reset=Fn(()=>{const id=int(instanceIndex);scratch.element(id.add(count*2)).assign(0);scratch.element(id.add(count*3)).assign(0);})().compute(count);
    const observe=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(U.WORDS),health=u.element(at.add(U.UHEALTH));
      If(atomicLoad(totals.element(id)).greaterThan(0).and(health.lessThanEqual(0)),()=>{
        atomicStore(totals.element(id.add(count)),clock.element(0));
        If(combat.element(id.mul(C.CWORDS).add(C.CDEATH)).greaterThanEqual(0).and(u.element(at.add(U.UOWNER)).equal(0)).and(u.element(at.add(U.UDOMAIN)).notEqual(2)),()=>{atomicAdd(totals.element(count*4),int(1));});
      });
      atomicStore(totals.element(id),health);
      available.element(id).assign(uint(health.lessThanEqual(0).and(clock.element(0).add(1).sub(atomicLoad(totals.element(id.add(count)))).greaterThanEqual(90))));
      If(health.greaterThan(0),()=>{
        const enter=u.element(at.add(U.UENTER)),factory=select(enter.lessThan(0),enter.negate(),select(u.element(at.add(U.UTYPE)).equal(movementType('C17')),enter,u.element(at.add(U.UATTACHED)))).toVar();
        If(factory.greaterThan(0),()=>{atomicStore(totals.element(factory.sub(1).add(count*2)),int(1));});
        const service=id.mul(SERVICE_WORDS).add(SERVICE_BASE);
        If(repairs.element(service.add(SMODE)).equal(3),()=>{const facility=repairs.element(service.add(SFACILITY));If(facility.greaterThan(0),()=>{atomicMax(totals.element(facility.sub(1).add(count*3)),id.add(1));});});
      });
    })().compute(count);
    this.facts=Fn(()=>{
      const index=int(instanceIndex),id=request.element(index.add(3)).toVar(),at=id.mul(U.WORDS),out=index.mul(REPORT_RECORD).add(REPORT_HEADER);
      const dock=scratch.element(id.add(count*3)).sub(1).toVar(),load=int(0).toVar();
      If(dock.greaterThanEqual(0),()=>{load.assign(credits.element(dock.mul(HWORDS).add(HBASE+HLOAD)));});
      const fields=[id,u.element(at.add(U.UHEALTH)),u.element(at.add(U.UGENERATION)),combat.element(id.mul(C.CWORDS).add(C.CDEATH)),scratch.element(id.add(count*2)),dock,load,u.element(at.add(U.UTYPE))];
      for(const [i,value] of fields.entries())result.element(out.add(i)).assign(value);
    })().compute(1);
    const free=Fn(()=>{
      const id=int(instanceIndex),index=int(prefix.element(id)).toVar(),out=request.element(1).mul(REPORT_RECORD).add(REPORT_HEADER).add(index.mul(2));
      If(available.element(id).notEqual(0).and(index.lessThan(request.element(2))),()=>{result.element(out).assign(id);result.element(out.add(1)).assign(u.element(id.mul(U.WORDS).add(U.UGENERATION)));});
    })().compute(count);
    const detail=Fn(()=>{
      const id=request.element(0),at=intMax(id,int(0)).mul(U.WORDS);result.element(0).assign(id);
      for(const [i,field] of [U.UTYPE,U.UCELL,U.UFACE,U.UDEST,U.UHEALTH,U.UALTITUDE].entries())result.element(i+1).assign(u.element(at.add(field)));
      result.element(7).assign(goals.element(intMax(id,int(0))));
    })().compute(1);
    const account=Fn(()=>{
      result.element(8).assign(credits.element(0));result.element(9).assign(credits.element(1));
      for(let i=0;i<3;i++)result.element(10+i).assign(deliveries.element(i));
      result.element(13).assign(repairs.element(0));result.element(14).assign(repairs.element(1));result.element(15).assign(scratch.element(count*4));
      result.element(16).assign(request.element(1));result.element(17).assign(intMin(int(prefix.element(count)),request.element(2)));
    })().compute(1);
    this.kernels=[reset,observe,...this.freePrefix.kernels,free,detail,account];
  }
  select(id:number){const values=this.requests.array as Int32Array;if(values[0]===id)return;values[0]=id;this.requests.addUpdateRange(0,1);this.requests.needsUpdate=true;}
  request(ids:Iterable<number>,freeLimit:number){
    const actors=[...new Set(ids)],values=this.requests.array as Int32Array;this.requested=actors.length;this.freeLimit=Math.min(this.battle.setup.units.length,freeLimit);
    const next=[this.requested,this.freeLimit,...actors];
    if(next.some((value,i)=>values[i+1]!==value)){values.set(next,1);this.requests.addUpdateRange(1,next.length);this.requests.needsUpdate=true;}
    this.facts.count=this.requested;this.bytes=(REPORT_HEADER+this.requested*REPORT_RECORD+this.freeLimit*2)*4;
  }
  prepareForPlay(){return this.battle.renderer.compileComputeAsync([...this.kernels,this.facts]);}
  async read(){
    this.battle.renderer.compute(this.kernels);if(this.requested)this.battle.renderer.compute(this.facts);
    await this.battle.renderer.getArrayBufferAsync(this.result,this.readback,0,this.bytes);
    const report=new Int32Array(this.readback.buffer!).slice();this.readback.release();return report;
  }
  dispose(){for(const pass of this.kernels)if(!this.freePrefix.kernels.includes(pass))pass.dispose();this.facts.dispose();this.freePrefix.dispose();this.readback.dispose();releaseStorage(this.battle.renderer,[this.result,this.requests,this.scratch,this.available]);}
}
