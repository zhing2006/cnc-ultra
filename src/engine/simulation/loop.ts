import type { Node } from 'three/webgpu';
import { getCurrentStack, Loop as tslLoop } from 'three/tsl';

const sequences=new WeakMap<object,number>();
type ScopeStack={parent:ScopeStack|null};
type Bounds={start:number|Node<'int'>;end:number|Node<'int'>;type?:'int';update?:string|number;condition?:string};
/** TSL's default loop variable is always `i`; give nested loops distinct shader identifiers. */
export function loop(body:()=>void):void;
export function loop(count:number|Node<'int'>|Bounds,body:(value:{i:Node<'int'>})=>void):void;
export function loop(count:number|Node<'int'>|Bounds|(()=>void),body?:(value:{i:Node<'int'>})=>void){
  if(typeof count==='function'){tslLoop(()=>{count();});return;}
  // If/Loop bodies are built lazily. Their common root stack, rather than a
  // JavaScript callback scope, identifies the shader throughout that process.
  // StackNode's declarations currently omit its singular parent link.
  let root=getCurrentStack() as unknown as ScopeStack;
  while(root.parent)root=root.parent;
  const sequence=sequences.get(root)??0;sequences.set(root,sequence+1);
  const name=`loop${sequence}`;
  const bounds=typeof count==='number'||'isNode' in count?{start:0,end:count,type:'int' as const,name}:{...count,name};
  tslLoop(bounds,value=>{body!({i:(value as unknown as Record<string,Node<'int'>>)[name]});});
}
