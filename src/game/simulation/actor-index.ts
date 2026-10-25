import { StorageBufferAttribute,type ComputeNode } from 'three/webgpu';
import { Fn,If,int,uint,storage,instanceIndex,atomicStore,atomicAdd,atomicMin,wgslFn,select } from 'three/tsl';
import { MOVEMENT } from '../data/movement.ts';
import type { GpuUnits } from './units-gpu.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import * as U from './units-state.ts';

const exchange=wgslFn('fn actorIndexExchange(p: ptr<storage, atomic<u32>, read_write>, value: u32) -> u32 { return atomicExchange(p, value); }');
export const NO_ACTOR=0xffffffff;

/** Derived GPU indexes. List order is unspecified; rule decisions compare stable actor IDs. */
export class GpuActorIndex {
  readonly buffer:StorageBufferAttribute;
  readonly kernels:ComputeNode[];
  readonly typeHead=0;
  readonly domainHead=MOVEMENT.length;
  readonly typeNext:number;
  readonly domainNext:number;
  readonly cargoHead:number;
  readonly cargoNext:number;
  readonly cargoCount:number;
  readonly enteringCount:number;
  readonly enteringMin:number;
  readonly enteringFirst:number;
  readonly transportLoading:number;
  readonly harvestOwner:number;
  readonly harvestDock:number;
  readonly harvestApproach:number;
  readonly airOwner:number;
  readonly airCount:number;
  readonly airMin:number;
  readonly goalMin:number;
  readonly goalHead:number;
  readonly goalNext:number;
  readonly passable:number;
  readonly playable:number;
  readonly buildable:number;
  private readonly mapChanged:(_edges:Uint32Array,passable:Uint8Array)=>void;
  constructor(readonly movement:GpuUnits){
    const count=movement.setup.units.length,cells=movement.setup.grid.edges.length;
    this.typeNext=MOVEMENT.length+3;this.domainNext=this.typeNext+count;this.cargoHead=this.domainNext+count;this.cargoNext=this.cargoHead+count;
    this.cargoCount=this.cargoNext+count;this.enteringCount=this.cargoCount+count;this.enteringMin=this.enteringCount+count;
    this.enteringFirst=this.enteringMin+count;this.transportLoading=this.enteringFirst+count*6;
    this.harvestOwner=this.transportLoading+count;this.harvestDock=this.harvestOwner+count;this.harvestApproach=this.harvestDock+count;
    this.airOwner=this.harvestApproach+count;this.airCount=this.airOwner+count;this.airMin=this.airCount+cells;this.goalMin=this.airMin+cells;
    this.goalHead=this.goalMin+cells;this.goalNext=this.goalHead+cells;
    this.passable=this.goalNext+count;this.playable=this.passable+cells;this.buildable=this.playable+cells;
    const values=new Uint32Array(this.buildable+cells);values.set(movement.setup.passable??movement.setup.grid.edges,this.passable);
    for(let cell=0;cell<cells;cell++)values[this.buildable+cell]=Number(!!values[this.passable+cell]&&(movement.setup.land[cell]===0||movement.setup.land[cell]===1));
    const {width,height}=movement.setup.grid,bounds=movement.setup.bounds??{x:0,y:0,width,height};
    for(let y=bounds.y;y<bounds.y+bounds.height;y++)for(let x=bounds.x;x<bounds.x+bounds.width;x++)values[this.playable+y*width+x]=1;
    this.buffer=new StorageBufferAttribute(values,1);
    this.mapChanged=(_edges,passable)=>{values.set(passable,this.passable);this.buffer.addUpdateRange(this.passable,cells);this.buffer.needsUpdate=true;};
    movement.mapObservers.add(this.mapChanged);
    const index=storage(this.buffer,'uint',values.length).toAtomic(),u=storage(movement.units,'int',movement.units.count).toReadOnly(),goals=storage(movement.goals,'int',count).toReadOnly();
    const reset=Fn(()=>{
      const id=int(instanceIndex);
      If(id.lessThan(MOVEMENT.length+3),()=>{atomicStore(index.element(id),uint(NO_ACTOR));});
      If(id.lessThan(count),()=>{
        atomicStore(index.element(id.add(this.cargoHead)),uint(NO_ACTOR));atomicStore(index.element(id.add(this.cargoCount)),uint(0));
        atomicStore(index.element(id.add(this.enteringCount)),uint(0));atomicStore(index.element(id.add(this.enteringMin)),uint(NO_ACTOR));
        for(let entry=0;entry<6;entry++)atomicStore(index.element(id.mul(6).add(this.enteringFirst+entry)),uint(NO_ACTOR));
        atomicStore(index.element(id.add(this.transportLoading)),uint(0));
        for(const base of [this.harvestOwner,this.harvestDock,this.harvestApproach,this.airOwner])atomicStore(index.element(id.add(base)),uint(NO_ACTOR));
      });
      If(id.lessThan(cells),()=>{atomicStore(index.element(id.add(this.airCount)),uint(0));atomicStore(index.element(id.add(this.airMin)),uint(NO_ACTOR));atomicStore(index.element(id.add(this.goalMin)),uint(NO_ACTOR));atomicStore(index.element(id.add(this.goalHead)),uint(NO_ACTOR));});
    })().compute(Math.max(count,cells,MOVEMENT.length+3));
    const collect=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(U.WORDS);
      If(u.element(at.add(U.UHEALTH)).greaterThan(0),()=>{
        atomicStore(index.element(id.add(this.typeNext)),exchange(index.element(u.element(at.add(U.UTYPE))),uint(id)));
        atomicStore(index.element(id.add(this.domainNext)),exchange(index.element(u.element(at.add(U.UDOMAIN)).add(this.domainHead)),uint(id)));
        const parent=u.element(at.add(U.UATTACHED)).sub(1),enter=u.element(at.add(U.UENTER)).sub(1);
        If(parent.greaterThanEqual(0).and(parent.lessThan(count)),()=>{
          atomicStore(index.element(id.add(this.cargoNext)),exchange(index.element(parent.add(this.cargoHead)),uint(id)));
          atomicAdd(index.element(parent.add(this.cargoCount)),uint(1));
        });
        If(enter.greaterThanEqual(0).and(enter.lessThan(count)),()=>{
          atomicAdd(index.element(enter.add(this.enteringCount)),uint(1));atomicMin(index.element(enter.add(this.enteringMin)),uint(id));
          If(u.element(at.add(U.UKIND)).notEqual(0).and(u.element(at.add(U.UATTACHED)).equal(0)),()=>{
            const candidate=uint(id).toVar();
            for(let entry=0;entry<6;entry++){
              const previous=atomicMin(index.element(enter.mul(6).add(this.enteringFirst+entry)),candidate).toVar();
              candidate.assign(select(previous.greaterThan(candidate),previous,candidate));
            }
          });
        });
        If(u.element(at.add(U.UDOMAIN)).equal(1),()=>{
          const cell=u.element(at.add(U.UCELL)),goal=goals.element(id);
          If(cell.greaterThanEqual(0).and(cell.lessThan(cells)),()=>{atomicAdd(index.element(cell.add(this.airCount)),uint(1));atomicMin(index.element(cell.add(this.airMin)),uint(id));});
          If(goal.greaterThanEqual(0).and(goal.lessThan(cells)),()=>{atomicMin(index.element(goal.add(this.goalMin)),uint(id));atomicStore(index.element(id.add(this.goalNext)),exchange(index.element(goal.add(this.goalHead)),uint(id)));});
        });
      });
    })().compute(count);
    this.kernels=[reset,collect];
  }
  setPlayable(mask:ArrayLike<number>){const values=this.buffer.array as Uint32Array;values.set(mask,this.playable);this.buffer.addUpdateRange(this.playable,mask.length);this.buffer.needsUpdate=true;}
  setBuildable(mask:ArrayLike<number>){const values=this.buffer.array as Uint32Array;values.set(mask,this.buildable);this.buffer.addUpdateRange(this.buildable,mask.length);this.buffer.needsUpdate=true;}
  refresh(){this.movement.renderer.compute(this.kernels);}
  prepareForPlay(){return this.movement.renderer.compileComputeAsync(this.kernels);}
  dispose(){this.movement.mapObservers.delete(this.mapChanged);for(const pass of this.kernels)pass.dispose();releaseStorage(this.movement.renderer,[this.buffer]);}
}
