// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, int, storage, instanceIndex, vec4 } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { intMin } from '../../engine/simulation/integer-nodes.ts';
import type { PalettePipeline } from '../../engine/indexed/pipeline.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { BODY_SHAPE, facingTo32, dirFacing, movePoint } from '../coord.ts';
import type { GameScene } from '../scene.ts';
import type { GpuGround } from './ground.ts';
import type { GpuAircraft } from './aircraft-gpu.ts';
import { AIR_WORDS, ASPEED } from './aircraft-cpu.ts';
import * as U from './units-state.ts';

/** AIRCRAFT.CPP Draw_It: projected body, ground shadow and independently placed rotors. */
export class AircraftView {
  private readonly kernel:ComputeNode;
  private readonly attributes:StorageBufferAttribute[]=[];
  constructor(readonly aircraft:GpuAircraft,ground:GpuGround,pipeline:PalettePipeline,scene:GameScene) {
    const {layout}=ground,movement=aircraft.movement;
    const keep=(array:Int32Array,tuple=1)=>{const b=new StorageBufferAttribute(array,tuple);this.attributes.push(b);return b;};
    const regions:number[]=[],starts:number[]=[];
    for(const type of MOVEMENT){
      starts.push(regions.length/4);
      if(type.domain===1)for(const r of scene.animation!.frames.get(type.name)??[])regions.push(r.x,r.y,r.width,r.height);
    }
    const right=regions.length/4;
    for(const r of scene.animation!.frames.get('RROTOR')??[])regions.push(r.x,r.y,r.width,r.height);
    const left=regions.length/4;
    for(const r of scene.animation!.frames.get('LROTOR')??[])regions.push(r.x,r.y,r.width,r.height);
    const frames=storage(keep(Int32Array.from(regions),4),'ivec4',regions.length/4).toReadOnly();
    const facings=Int32Array.from(Array.from({length:256},(_,dir)=>{
      const stretch=[8,9,10,9,8,9,10,9][dirFacing(dir)];
      const first=movePoint(0,0,dir,stretch),second=movePoint(first[0],first[1],dir+128,stretch*2);
      return [BODY_SHAPE[facingTo32(dir)],...first,...second];
    }).flat());
    const constants=storage(keep(Int32Array.from([...starts,...facings])),'int',starts.length+facings.length).toReadOnly();
    const types={element:(index:Node<'int'>)=>constants.element(index)};
    const face={element:(index:Node<'int'>)=>constants.element(index.add(starts.length))};
    const u=storage(movement.units,'int',movement.units.count).toReadOnly();
    const a=storage(aircraft.state,'int',aircraft.state.count).toReadOnly();
    const order=storage(ground.order.order,'uint',ground.order.order.count).toReadOnly();
    const bindings=storage(keep(layout.bindings),'int',layout.bindings.length).toReadOnly();
    const sprites=storage(pipeline.spriteBuffer,'vec4',pipeline.spriteBuffer.count);
    const clock=storage(movement.control,'int',2).toReadOnly();
    const pixel=(value:Node<'int'>)=>value.mul(24).add(128).div(256);
    this.kernel=Fn(()=>{
      const index=int(instanceIndex);
      If(index.greaterThanEqual(layout.first),()=>{
        const relative=index.sub(layout.first),object=int(order.element(relative.div(layout.slots)));
        const id=bindings.element(object.mul(5));
        If(id.greaterThanEqual(0),()=>{
          const at=id.mul(U.WORDS);
          If(u.element(at.add(U.UDOMAIN)).equal(1).and(u.element(at.add(U.UHEALTH)).greaterThan(0)),()=>{
            const type=u.element(at.add(U.UTYPE)),altitude=u.element(at.add(U.UALTITUDE));
            const part=relative.mod(layout.slots),direction=u.element(at.add(U.UFACE)).mul(5);
            const frame=face.element(direction).toVar(),start=types.element(type).toVar();
            const x=pixel(u.element(at)).toVar(),y=pixel(u.element(at.add(1))).toVar();
            const info=sprites.element(index.mul(3).add(1)).toVar(),effect=sprites.element(index.mul(3).add(2)).toVar();
            If(type.equal(movementType('ORCA')).and(a.element(id.mul(AIR_WORDS).add(ASPEED)).mul(40).add(128).shiftRight(8).greaterThanEqual(30)),()=>{frame.addAssign(32);});
            // DOOR.CPP stores stages - 1, then returns Stages - 1 while held open.
            If(type.equal(movementType('TRAN')).and(u.element(at.add(U.UDOOR)).greaterThan(0)),()=>{
              const door=u.element(at.add(U.UDOOR));
              frame.assign(intMin(int(2),door.sub(1)).add(32));
              If(door.greaterThanEqual(5),()=>{frame.assign(int(7).sub(door).add(32));});
            });
            If(part.equal(0),()=>{x.addAssign(1);y.addAssign(2);effect.x.assign(2);info.w.assign(0);}).Else(()=>{
              y.subAssign(altitude);effect.x.assign(0);info.w.assign(1);
              If(part.greaterThanEqual(2),()=>{
                start.assign(right);
                If(part.equal(3),()=>{start.assign(left);});
                frame.assign(clock.element(0).div(2).mod(8).add(4));
                If(altitude.greaterThan(0),()=>{frame.assign(clock.element(0).div(2).mod(4));effect.x.assign(2);info.w.assign(0);});
                info.z.assign(scene.plainRemap);y.subAssign(2);
                If(type.equal(movementType('TRAN')),()=>{
                  If(part.equal(2),()=>{x.addAssign(face.element(direction.add(1)));y.addAssign(face.element(direction.add(2)));})
                    .Else(()=>{x.addAssign(face.element(direction.add(3)));y.addAssign(face.element(direction.add(4)));});
                });
              });
            });
            const region=frames.element(start.add(frame));
            const visible=u.element(at.add(U.UHEALTH)).greaterThan(0).and(part.lessThan(2).or(part.equal(2).and(type.equal(movementType('HELI')).or(type.equal(movementType('TRAN'))))).or(part.equal(3).and(type.equal(movementType('TRAN')))));
            If(visible,()=>{sprites.element(index.mul(3)).assign(vec4(x.sub(region.z.div(2)),y.sub(region.w.div(2)),region.z,region.w));})
              .ElseIf(u.element(at.add(U.UHEALTH)).greaterThan(0).or(part.notEqual(0)),()=>{sprites.element(index.mul(3)).assign(vec4(0));});
            sprites.element(index.mul(3).add(1)).assign(vec4(region.x,region.y,info.z,info.w));
            sprites.element(index.mul(3).add(2)).assign(effect);
          });
        });
      });
    })().compute(layout.count);
  }
  update(){this.aircraft.movement.renderer.compute(this.kernel);}
  dispose(){this.kernel.dispose();releaseStorage(this.aircraft.movement.renderer,this.attributes);}
}
