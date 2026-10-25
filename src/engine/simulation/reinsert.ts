import { IndirectStorageBufferAttribute,StorageBufferAttribute,type ComputeNode,type Node,type WebGPURenderer } from 'three/webgpu';
import { Fn,If,Break,int,uint,storage,instanceIndex,localId,workgroupId,workgroupArray,workgroupBarrier,atomicStore,atomicLoad,atomicMin,atomicAdd,select,wgslFn } from 'three/tsl';
import { loop as Loop } from './loop.ts';
import { GpuTaskMask } from './task-mask.ts';
import { GpuPrefixSum } from './prefix-sum.ts';
import { computeFunction } from './compute-function.ts';
import { releaseStorage } from './resources.ts';

type I=Node<'int'>;
type Q=Node<'uint'>;
type Shared={element(index:Q):Q};
const BLOCK=256,CACHED=4096;
const uniformLoad=wgslFn('fn reinsertUniform(p: ptr<workgroup, u32>) -> u32 { return workgroupUniformLoad(p); }');

/** Batch reinsertion into a partially ordered permutation, equivalent to ascending-ID edits. */
export class GpuReinsert {
  readonly changes:GpuTaskMask;
  readonly prepare:ComputeNode;
  readonly apply:ComputeNode;
  private readonly controls:ComputeNode[]=[];
  private readonly kernels:ComputeNode[]=[];
  private readonly attributes:StorageBufferAttribute[]=[];
  private readonly prefix:GpuPrefixSum;
  constructor(readonly renderer:WebGPURenderer,keys:StorageBufferAttribute,permutation:StorageBufferAttribute){
    const count=permutation.count;
    this.changes=new GpuTaskMask(renderer,count);
    const keep=(length:number)=>{const b=new StorageBufferAttribute(new Uint32Array(length),1);this.attributes.push(b);return b;};
    const jobBuffer=keep(count+1),workBuffer=keep(count*5),weightBuffer=keep(count+1),firstBuffer=keep(count+1),outputBuffer=keep(count),leafBuffer=keep(count);
    const jobs=storage(jobBuffer,'uint',count+1),work=storage(workBuffer,'uint',count*5);
    const order=storage(permutation,'uint',count),output=storage(outputBuffer,'uint',count);
    const key=storage(keys,'int',keys.count).toReadOnly(),mask=storage(this.changes.buffer,'uint',this.changes.buffer.count).toReadOnly();
    const weights=storage(weightBuffer,'uint',count+1),first=storage(firstBuffer,'uint',count+1),leaves=storage(leafBuffer,'uint',count);
    const position=(id:I)=>work.element(id),base=(job:I)=>work.element(job.add(count)),rank=(job:I)=>work.element(job.add(count*2)),anchor=(job:I)=>work.element(job.add(count*3));
    const moving=(id:Q)=>mask.element(id.div(32)).bitAnd(uint(1).shiftLeft(id.mod(32))).notEqual(0);
    // Encoded IDs reserve zero for an empty maximum, so every signed x/y key is supported.
    const greater=computeFunction(([left,right]:[Q,Q])=>{
      const yes=uint(0).toVar();
      If(left.notEqual(0),()=>{
        If(right.equal(0),()=>{yes.assign(1);}).Else(()=>{
          const l=left.sub(1).mul(2),r=right.sub(1).mul(2);
          yes.assign(uint(key.element(l.add(1)).greaterThan(key.element(r.add(1)))
            .or(key.element(l.add(1)).equal(key.element(r.add(1))).and(key.element(l).greaterThan(key.element(r))))));
        });
      });return yes.notEqual(0);
    },{name:'reinsertKeyGreater',type:'bool',inputs:[{name:'left',type:'uint'},{name:'right',type:'uint'}]});
    type Groups=number|'tasks'|'items';
    const dispatches=new Map<Groups,IndirectStorageBufferAttribute>();
    const gate=(node:ComputeNode,groups:Groups)=>{
      let dispatch=dispatches.get(groups);
      if(!dispatch){dispatch=new IndirectStorageBufferAttribute(new Uint32Array([0,1,1]),1);dispatches.set(groups,dispatch);this.attributes.push(dispatch);}
      (node as unknown as {dispatchSize:IndirectStorageBufferAttribute}).dispatchSize=dispatch;
      return node;
    };
    const add=(node:ComputeNode,groups:Groups)=>{
      if(groups==='tasks'){this.kernels.push(gate(node,groups));return;}
      // ExecuteIndirect has a measurable cost even with zero workgroups on D3D12.
      // Fixed-size passes use a cheap GPU guard; only variable-size work stays indirect.
      const body=node.computeNode;
      if(node.count===null){
        const active=workgroupArray('uint',1) as unknown as Shared;
        node.computeNode=Fn(()=>{
          If(localId.x.equal(0),()=>{active.element(uint(0)).assign(jobs.element(0));});
          const enabled=uniformLoad({p:active.element(uint(0))}) as Q;
          If(enabled.notEqual(0),()=>body);
        })();
        node.dispatchSize=[groups as number,1,1];
      }else node.computeNode=Fn(()=>{If(jobs.element(0).notEqual(0),()=>body);})();
      this.kernels.push(node);
    };
    add(Fn(()=>{
      const i=int(instanceIndex),id=order.element(i),changed=moving(id);
      position(int(id)).assign(uint(i));leaves.element(i).assign(select(changed,uint(0),id.add(1)));
      weights.element(i).assign(uint(changed.not()));first.element(i).assign(uint(count));
      work.element(i.add(count*4)).assign(uint(count));
      If(i.equal(0),()=>{weights.element(count).assign(uint(0));first.element(count).assign(uint(count));});
    })().compute(count),Math.ceil(count/64));
    // A hierarchical inclusive maximum lets each job binary-search the first greater
    // unchanged key. This works even though the original permutation is only partly sorted.
    const maxima=(input:StorageBufferAttribute,size:number):StorageBufferAttribute=>{
      const groups=Math.ceil(size/BLOCK),result=keep(size),totals=keep(groups);
      const src=storage(input,'uint',size).toReadOnly(),dst=storage(result,'uint',size),total=storage(totals,'uint',groups);
      const shared=workgroupArray('uint',BLOCK) as unknown as Shared;
      add(Fn(()=>{
        const lane=localId.x,index=workgroupId.x.mul(BLOCK).add(lane),value=uint(0).toVar();
        If(index.lessThan(size),()=>{value.assign(src.element(index));});shared.element(lane).assign(value);workgroupBarrier();
        for(let distance=1;distance<BLOCK;distance*=2){
          const prior=shared.element(lane).toVar(),left=uint(0).toVar();
          If(lane.greaterThanEqual(distance),()=>{left.assign(shared.element(lane.sub(distance)));});
          workgroupBarrier();shared.element(lane).assign(select(greater(left,prior),left,prior));workgroupBarrier();
        }
        If(index.lessThan(size),()=>{dst.element(index).assign(shared.element(lane));});
        If(lane.equal(BLOCK-1),()=>{total.element(workgroupId.x).assign(shared.element(lane));});
      })().computeKernel([BLOCK]),groups);
      if(groups>1){
        const parent=maxima(totals,groups),prefix=storage(parent,'uint',groups).toReadOnly();
        add(Fn(()=>{const i=int(instanceIndex),block=i.div(BLOCK);If(block.greaterThan(0),()=>{const earlier=prefix.element(block.sub(1));If(greater(earlier,dst.element(i)),()=>{dst.element(i).assign(earlier);});});})().compute(size),Math.ceil(size/64));
      }
      return result;
    };
    const maximum=storage(maxima(leafBuffer,count),'uint',count).toReadOnly();
    // Pairwise comparisons cost O(K^2) total work, distributed across K workgroups.
    // They touch only changed IDs; neither this pass nor the serial pass scans N per edit.
    const reductions=workgroupArray('uint',2).toAtomic() as unknown as Shared;
    add(Fn(()=>{
      const job=int(workgroupId.x),lane=int(localId.x),id=jobs.element(job.add(1)),encoded=id.add(1),tasks=int(jobs.element(0));
      If(lane.equal(0),()=>{
        const low=int(0).toVar(),high=int(count).toVar();
        Loop(()=>{If(low.greaterThanEqual(high),()=>{Break();});const mid=low.add(high).div(2).toVar();
          If(greater(maximum.element(mid),encoded),()=>{high.assign(mid);}).Else(()=>{low.assign(mid.add(1));});});
        atomicStore(reductions.element(uint(0)),uint(low));atomicStore(reductions.element(uint(1)),uint(0));
      });
      workgroupBarrier();
      const bound=uint(count).toVar(),before=uint(0).toVar();
      Loop({start:lane,end:tasks,update:'+=256',type:'int'},({i:other})=>{
        const peer=jobs.element(other.add(1)).add(1),higher=greater(peer,encoded).toVar(),lower=greater(encoded,peer).toVar();
        If(lower.or(higher.not().and(other.lessThan(job))),()=>{before.addAssign(1);});
        If(other.greaterThan(job).and(higher),()=>{const p=position(int(peer.sub(1)));If(p.lessThan(bound),()=>{bound.assign(p);});});
      });
      atomicMin(reductions.element(uint(0)),bound);atomicAdd(reductions.element(uint(1)),before);workgroupBarrier();
      If(lane.equal(0),()=>{base(job).assign(atomicLoad(reductions.element(uint(0))));rank(job).assign(atomicLoad(reductions.element(uint(1))));});
    })().computeKernel([BLOCK]),'tasks');
    // Inserted objects form a key/ID-ordered subsequence. Its anchor can only be pulled
    // earlier by a greater, previously inserted key. Future edits contribute their OLD
    // positions to base(job) above. A reverse-rank Fenwick minimum resolves these dependencies
    // in O(K log K), without scanning or moving the N-object permutation per edit.
    const cache=workgroupArray('uint',CACHED) as unknown as Shared;
    this.apply=gate(Fn(()=>{
      const tasks=int(jobs.element(0));
      Loop({start:0,end:select(tasks.lessThan(CACHED),tasks,int(CACHED)),type:'int'},({i})=>{cache.element(uint(i)).assign(uint(count));});
      const read=(i:I)=>{const value=uint(count).toVar();If(i.lessThanEqual(CACHED),()=>{value.assign(cache.element(uint(i.sub(1))));}).Else(()=>{value.assign(work.element(i.sub(1).add(count*4)));});return value;};
      Loop(tasks,({i:job})=>{
        const reversed=tasks.sub(int(rank(job))).toVar(),i=reversed.sub(1).toVar(),value=base(job).toVar();
        Loop(()=>{If(i.lessThanEqual(0),()=>{Break();});const prior=read(i).toVar();If(prior.lessThan(value),()=>{value.assign(prior);});i.subAssign(i.bitAnd(i.negate()));});
        anchor(job).assign(value);i.assign(reversed);
        Loop(()=>{If(i.greaterThan(tasks),()=>{Break();});const prior=read(i).toVar();
          If(value.lessThan(prior),()=>{If(i.lessThanEqual(CACHED),()=>{cache.element(uint(i.sub(1))).assign(value);}).Else(()=>{work.element(i.sub(1).add(count*4)).assign(value);});});
          i.addAssign(i.bitAnd(i.negate()));});
      });
    })().computeKernel([1]),1);
    this.kernels.push(this.apply);
    const atomicWeights=storage(weightBuffer,'uint',count+1).toAtomic(),atomicFirst=storage(firstBuffer,'uint',count+1).toAtomic();
    add(Fn(()=>{const job=int(instanceIndex);If(job.lessThan(int(jobs.element(0))),()=>{atomicAdd(atomicWeights.element(anchor(job)),uint(1));atomicMin(atomicFirst.element(anchor(job)),rank(job));});})().compute(count),'items');
    this.prefix=new GpuPrefixSum(renderer,weightBuffer,count+1);
    for(const kernel of this.prefix.kernels){
      const groups=Array.isArray(kernel.dispatchSize)?kernel.dispatchSize[0]:Math.ceil((kernel.count as number)/kernel.workgroupSize.reduce((a,b)=>a*b,1));
      add(kernel,groups);
    }
    const prefix=storage(this.prefix.output,'uint',count+2).toReadOnly();
    add(Fn(()=>{
      const i=int(instanceIndex),id=order.element(i);
      If(moving(id).not(),()=>{output.element(prefix.element(i).add(weights.element(i)).sub(1)).assign(id);});
      If(i.lessThan(int(jobs.element(0))),()=>{const at=anchor(i);output.element(prefix.element(at).add(rank(i)).sub(first.element(at))).assign(jobs.element(i.add(1)));});
    })().compute(count),Math.ceil(count/64));
    add(Fn(()=>{order.element(instanceIndex).assign(output.element(instanceIndex));})().compute(count),Math.ceil(count/64));
    this.prepare=Fn(()=>{const total=uint(0).toVar();this.changes.forEach(id=>{total.addAssign(1);jobs.element(total).assign(uint(id));});jobs.element(0).assign(total);})().compute(1);
    // Indirect arguments are produced on the GPU; an unchanged frame skips the
    // candidate groups and dependency traversal without any CPU readback.
    const entries=[...dispatches];
    for(let start=0;start<entries.length;start+=6){
      const part=entries.slice(start,start+6).map(([groups,buffer])=>({groups,node:storage(buffer,'uint',3)}));
      this.controls.push(Fn(()=>{const tasks=jobs.element(0);for(const {groups,node} of part)node.element(0).assign(select(tasks.equal(0),uint(0),groups==='tasks'?tasks:groups==='items'?tasks.add(63).div(64):uint(groups)));})().compute(1));
    }
  }
  clear(){this.renderer.compute(this.changes.clear);}
  step(){this.renderer.compute(this.prepare);this.renderer.compute(this.controls);this.renderer.compute(this.kernels);}
  dispose(){this.prepare.dispose();for(const k of [...this.controls,...this.kernels])if(!this.prefix.kernels.includes(k))k.dispose();this.prefix.dispose();this.changes.dispose();releaseStorage(this.renderer,this.attributes);}
}
