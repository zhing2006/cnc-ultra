import { StorageBufferAttribute,type ComputeNode,type Node,type WebGPURenderer } from 'three/webgpu';
import { Fn,If,Break,int,uint,storage,instanceIndex,atomicStore,atomicOr,uniform } from 'three/tsl';
import { loop as Loop } from './loop.ts';
import { trailingZeros } from './integer-nodes.ts';
import { releaseStorage } from './resources.ts';

/** Sparse tasks visited in ascending ID order, independent of atomic insertion order. */
export class GpuTaskMask {
  readonly buffer:StorageBufferAttribute;
  readonly clear:ComputeNode;
  readonly words:number;
  private readonly groups:number;
  private readonly groupCount;
  constructor(readonly renderer:WebGPURenderer,readonly capacity:number){
    this.words=Math.ceil(capacity/32);this.groups=Math.ceil(this.words/32);this.groupCount=uniform(this.groups,'int');
    this.buffer=new StorageBufferAttribute(new Uint32Array(this.words+this.groups),1);
    const values=storage(this.buffer,'uint',this.buffer.count).toAtomic();
    this.clear=Fn(()=>{atomicStore(values.element(instanceIndex),uint(0));})().compute(this.buffer.count);
  }
  add(id:Node<'int'>){
    const values=storage(this.buffer,'uint',this.buffer.count).toAtomic(),word=id.div(32);
    atomicOr(values.element(word),uint(1).shiftLeft(uint(id.mod(32))));
    atomicOr(values.element(word.div(32).add(this.words)),uint(1).shiftLeft(uint(word.mod(32))));
  }
  forEach(visit:(id:Node<'int'>)=>void){
    const values=storage(this.buffer,'uint',this.buffer.count).toReadOnly();
    Loop(this.groupCount,({i:group})=>{
      const occupied=values.element(group.add(this.words)).toVar();
      Loop(()=>{
        If(occupied.equal(0),()=>{Break();});
        const word=group.mul(32).add(int(trailingZeros(occupied))).toVar(),bits=values.element(word).toVar();
        Loop(()=>{
          If(bits.equal(0),()=>{Break();});
          const id=word.mul(32).add(int(trailingZeros(bits))).toVar();
          If(id.lessThan(this.capacity),()=>{Loop(1,()=>{visit(id);});});bits.bitAndAssign(bits.sub(uint(1)));
        });
        occupied.bitAndAssign(occupied.sub(uint(1)));
      });
    });
  }
  dispose(){this.clear.dispose();releaseStorage(this.renderer,[this.buffer]);}
}
