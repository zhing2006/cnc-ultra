import { StorageBufferAttribute,type ComputeNode,type Node,type WebGPURenderer } from 'three/webgpu';
import { Fn,If,int,uint,storage,instanceIndex,localId,workgroupId,workgroupArray,workgroupBarrier } from 'three/tsl';
import { releaseStorage } from './resources.ts';

type Shared={element(index:Node<'uint'>):Node<'uint'>};
const BLOCK=128;

/** Exclusive integer prefix sums; output[count] contains the total. No CPU readback. */
export class GpuPrefixSum {
  readonly output:StorageBufferAttribute;
  readonly kernels:ComputeNode[];
  private readonly totals:StorageBufferAttribute;
  private readonly parent?:GpuPrefixSum;
  constructor(readonly renderer:WebGPURenderer,input:StorageBufferAttribute,readonly count:number){
    const groups=Math.ceil(count/BLOCK);
    this.output=new StorageBufferAttribute(new Uint32Array(count+1),1);this.totals=new StorageBufferAttribute(new Uint32Array(groups),1);
    const source=storage(input,'uint',input.count).toReadOnly(),result=storage(this.output,'uint',count+1),totals=storage(this.totals,'uint',groups);
    const local=workgroupArray('uint',BLOCK) as unknown as Shared;
    const scan=Fn(()=>{
      const lane=localId.x,index=workgroupId.x.mul(BLOCK).add(lane),value=uint(0).toVar();
      If(index.lessThan(count),()=>{value.assign(source.element(index));});
      local.element(lane).assign(value);workgroupBarrier();
      for(let distance=1;distance<BLOCK;distance*=2){
        const prior=local.element(lane).toVar(),extra=uint(0).toVar();
        If(lane.greaterThanEqual(distance),()=>{extra.assign(local.element(lane.sub(distance)));});
        workgroupBarrier();local.element(lane).assign(prior.add(extra));workgroupBarrier();
      }
      If(index.lessThan(count),()=>{result.element(index).assign(local.element(lane).sub(value));});
      If(lane.equal(BLOCK-1),()=>{totals.element(workgroupId.x).assign(local.element(lane));if(groups===1)result.element(count).assign(local.element(lane));});
    })().computeKernel([BLOCK]);
    // Three.js treats a scalar dispatch size as an invocation count, not workgroups.
    scan.dispatchSize=[groups,1,1];
    this.kernels=[scan];
    if(groups>1){
      this.parent=new GpuPrefixSum(renderer,this.totals,groups);
      const offsets=storage(this.parent.output,'uint',groups+1).toReadOnly();
      const add=Fn(()=>{const index=int(instanceIndex);result.element(index).addAssign(offsets.element(index.div(BLOCK)));If(index.equal(0),()=>{result.element(count).assign(offsets.element(groups));});})().compute(count);
      this.kernels.push(...this.parent.kernels,add);
    }
  }
  dispose(){for(const pass of this.kernels)if(!this.parent?.kernels.includes(pass))pass.dispose();this.parent?.dispose();releaseStorage(this.renderer,[this.output,this.totals]);}
}
