import type { ComputeNode,Node } from 'three/webgpu';
import { Fn } from 'three/tsl';
import type { FnNode } from 'three/src/nodes/tsl/TSLCore.js';

/** Share a function inside each kernel without caching its captured bindings across kernels. */
export function computeFunction<Args extends readonly Node[],Result extends Node>(
  body:(args:Args)=>Result,layout:Parameters<FnNode<Args,Result>['setLayout']>[0],
){
  const functions=new WeakMap<ComputeNode,FnNode<Args,Result>>();
  return Fn<Args,Result>((args,builder)=>{
    if(!builder.compute)throw new Error('A captured compute function requires a compute kernel');
    let fn=functions.get(builder.compute);
    if(!fn){fn=Fn(body).setLayout(layout) as FnNode<Args,Result>;functions.set(builder.compute,fn);}
    return fn(...args) as Result;
  });
}
