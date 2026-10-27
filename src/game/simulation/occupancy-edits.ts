import { StorageBufferAttribute,type ComputeNode } from 'three/webgpu';
import { Fn,If,int,uint,storage,instanceIndex,atomicStore,atomicMax } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { MOVEMENT,movementType } from '../data/movement.ts';
import { BUILDINGS } from '../data/buildings.ts';
import type { GpuUnits } from './units-gpu.ts';
import * as U from './units-state.ts';

const FIELDS=[U.UCELL,U.UDEST,U.UMIDDLE,U.UKIND,U.UDOMAIN,U.UALTITUDE,U.UHEALTH,U.UATTACHED,U.UORIGIN,U.UTYPE,U.USLOT,U.UDSLOT];
/** Refresh only cells touched by external edits, retaining reservations between systems. */
export class GpuOccupancyEdits {
  readonly capture:ComputeNode;
  readonly kernels:ComputeNode[];
  private readonly attributes:StorageBufferAttribute[]=[];
  constructor(readonly movement:GpuUnits){
    const {width}=movement.setup.grid,cells=movement.setup.grid.edges.length,count=movement.setup.units.length;
    const keep=(data:Int32Array|Uint32Array)=>{const value=new StorageBufferAttribute(data,1);this.attributes.push(value);return value;};
    const u=storage(movement.units,'int',movement.units.count).toReadOnly(),prior=storage(keep(new Int32Array(count*FIELDS.length)),'int',count*FIELDS.length);
    const dirtyBuffer=keep(new Uint32Array(cells)),dirty=storage(dirtyBuffer,'uint',cells).toAtomic(),flags=storage(dirtyBuffer,'uint',cells).toReadOnly();
    const masks=storage(keep(Int32Array.from(MOVEMENT,t=>BUILDINGS.get(t.name)?.occupy.reduce((bits,[x,y])=>bits|(1<<(y*4+x)),0)??0)),'int',MOVEMENT.length).toReadOnly();
    const occupancy=storage(movement.occupancy,'uint',cells*5).toAtomic();
    const field=(id:import('three/webgpu').Node<'int'>,i:number)=>{const value=u.element(id.mul(U.WORDS).add(FIELDS[i]));return FIELDS[i]===U.UHEALTH?int(value.greaterThan(0)):FIELDS[i]===U.UALTITUDE?int(value.lessThan(16)):value;};
    this.capture=Fn(()=>{const id=int(instanceIndex);for(let i=0;i<FIELDS.length;i++)prior.element(id.mul(FIELDS.length).add(i)).assign(field(id,i));})().compute(count);
    const reset=Fn(()=>{atomicStore(dirty.element(instanceIndex),uint(0));})().compute(cells);
    const detect=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(FIELDS.length),changed=int(0).toVar();
      for(let i=0;i<FIELDS.length;i++)If(prior.element(at.add(i)).notEqual(field(id,i)),()=>{changed.assign(1);});
      If(changed.notEqual(0),()=>{
        for(const old of [true,false]){
          const value=(i:number)=>old?prior.element(at.add(i)):field(id,i);
          const mark=(cell:import('three/webgpu').Node<'int'>)=>{If(cell.greaterThanEqual(0).and(cell.lessThan(cells)),()=>{atomicStore(dirty.element(cell),uint(1));});};
          If(value(4).equal(2),()=>{const mask=masks.element(value(9)),origin=value(8);Loop(16,({i})=>{If(mask.bitAnd(int(1).shiftLeft(i)).notEqual(0),()=>{mark(origin.add(i.div(4).mul(width)).add(i.mod(4)));});});})
            .Else(()=>{for(let i=0;i<3;i++)mark(value(i));});
        }
        for(let i=0;i<FIELDS.length;i++)prior.element(at.add(i)).assign(field(id,i));
      });
    })().compute(count);
    const clear=Fn(()=>{const slot=int(instanceIndex);If(flags.element(slot.div(5)).notEqual(0),()=>{atomicStore(occupancy.element(slot),uint(0));});})().compute(cells*5);
    const buildings=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(U.WORDS);
      If(u.element(at.add(U.UDOMAIN)).equal(2).and(u.element(at.add(U.UHEALTH)).greaterThan(0)),()=>{
        const mask=masks.element(u.element(at.add(U.UTYPE))),origin=u.element(at.add(U.UORIGIN));
        Loop(16,({i})=>{If(mask.bitAnd(int(1).shiftLeft(i)).notEqual(0),()=>{const cell=origin.add(i.div(4).mul(width)).add(i.mod(4));If(flags.element(cell).notEqual(0),()=>{Loop(5,({i:slot})=>{atomicStore(occupancy.element(cell.mul(5).add(slot)),uint(id.add(1)));});});});});
      });
    })().compute(count);
    const actors=[-2,1,-1,0].map(layer=>Fn(()=>{
      const kind=layer===1||layer===-2?1:0;
      const id=int(instanceIndex),at=id.mul(U.WORDS),domain=u.element(at.add(U.UDOMAIN)),type=u.element(at.add(U.UTYPE));
      If(u.element(at.add(U.UHEALTH)).greaterThan(0).and(u.element(at.add(U.UATTACHED)).equal(0)).and(u.element(at.add(U.UKIND)).equal(kind)).and(domain.notEqual(2))
        .and(domain.notEqual(1).or(u.element(at.add(U.UALTITUDE)).lessThan(16).and(type.notEqual(movementType('C17'))).and(type.notEqual(movementType('A10'))))),()=>{
        for(const field of [U.UCELL,U.UDEST,U.UMIDDLE]){
          const cell=u.element(at.add(field)),slot=u.element(at.add(field===U.UCELL?U.USLOT:U.UDSLOT));
          const reserved=field===U.UCELL&&kind===1?u.element(at.add(U.UDEST)).lessThan(0):int(1).equal(1);
          If(cell.greaterThanEqual(0).and(reserved),()=>{If(flags.element(cell).notEqual(0),()=>{Loop(5,({i})=>{If(int(kind).equal(0).or(slot.equal(i)),()=>{if(layer<0)atomicStore(occupancy.element(cell.mul(5).add(i)),uint(0));else atomicMax(occupancy.element(cell.mul(5).add(i)),uint(id.add(1)));});});});});
        }
      });
    })().compute(count));
    this.kernels=[reset,detect,clear,buildings,...actors];
  }
  begin(){this.movement.renderer.compute(this.capture);}
  refresh(){this.movement.renderer.compute(this.kernels);}
  prepareForPlay(){return this.movement.renderer.compileComputeAsync([this.capture,...this.kernels]);}
  dispose(){this.capture.dispose();for(const pass of this.kernels)pass.dispose();releaseStorage(this.movement.renderer,this.attributes);}
}
