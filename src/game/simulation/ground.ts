// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type WebGPURenderer, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, instanceIndex, int, storage, vec4 } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { GpuOrder } from '../../engine/simulation/order.ts';
import { GpuSimulation } from '../../engine/simulation/gpu.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { UNIT_WORDS, X, Y } from '../../engine/simulation/state.ts';
import type { PalettePipeline, Sprite } from '../../engine/indexed/pipeline.ts';
import type { GameScene } from '../scene.ts';
import { leptonToPixel } from '../coord.ts';
import { BODY_SHAPE, HUMAN_SHAPE, facingTo32, turretAdjust } from '../coord.ts';
import { MOVEMENT } from '../data/movement.ts';
import { UNITS } from '../data/units.ts';
import { UTYPE, UFACE, UDEST, UWALK } from './units-state.ts';

/** Ported from LAYER.CPP, LayerClass::Sort, and OBJECT.H, comparison operators. */
export function bubbleGround(order: Uint32Array, keys: Int32Array) {
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i] * 2, b = order[i + 1] * 2;
    if (keys[b + 1] < keys[a + 1] || (keys[b + 1] === keys[a + 1] && keys[b] < keys[a])) {
      [order[i], order[i + 1]] = [order[i + 1], order[i]];
    }
  }
}

/** Ported from LAYER.CPP, LayerClass::Sorted_Add, including insertion into a partly sorted layer. */
export function insertGround(order: number[], keys: Int32Array, id: number) {
  const at = order.findIndex(other => keys[other * 2 + 1] > keys[id * 2 + 1]
    || (keys[other * 2 + 1] === keys[id * 2 + 1] && keys[other * 2] > keys[id * 2]));
  order.splice(at < 0 ? order.length : at, 0, id);
}

/** Associates each original drawable object with its simulation unit, if any. */
export function groundLayout(scene: GameScene, initial: Int32Array, stride = UNIT_WORDS, flash = false) {
  const units = new Map(scene.scenario.units.map((u,i) => [`unit:${u.cell}:${u.type}`, i]));
  const infantry = new Map(scene.scenario.infantry.map((u,i) => {
    const id = scene.scenario.units.length + i;
    return [`infantry:${u.cell}:${u.type}:${initial[id*stride]}:${initial[id*stride+1]+0x30}`,id];
  }));
  const slots = scene.objects.reduce((max, object) => Math.max(max, object.count), 1);
  const first = scene.objects[0]?.first ?? scene.sprites.length;
  const keys = new Int32Array([...scene.objects.flatMap(o => [o.sortX, o.sortY]), ...(flash ? [0,-0x3fffffff] : [])]);
  const bindings = new Int32Array([...scene.objects.flatMap(o => {
    const unit = units.get(o.key) ?? (stride !== UNIT_WORDS ? infantry.get(`${o.key}:${o.sortX}:${o.sortY}`) : undefined) ?? -1;
    return [unit, unit < 0 ? 0 : initial[unit * stride + X], unit < 0 ? 0 : initial[unit * stride + Y], o.sortX, o.sortY];
  }), ...(flash ? [-2,0,0,0,-0x3fffffff] : [])]);
  const packed = new Float32Array((first + (scene.objects.length + Number(flash)) * slots) * 12);
  const write = (sprite: Sprite, i: number) => packed.set([sprite.x, sprite.y, sprite.region.width, sprite.region.height,
    sprite.region.x, sprite.region.y, sprite.remap, sprite.shadow ? 1 : 0,
    sprite.filter === undefined ? 0 : sprite.filter + 2, sprite.displace ? 1 : 0, 0, 0], i * 12);
  scene.sprites.slice(0, first).forEach(write);
  scene.objects.forEach((o,id) => scene.sprites.slice(o.first, o.first + o.count).forEach((s,j) => write(s, first + id * slots + j)));
  return { slots, first, keys, bindings, packed, count: packed.length / 12, stride, flashId: flash ? scene.objects.length : -1 };
}

export function updateGroundKeys(layout: ReturnType<typeof groundLayout>, units: Int32Array, keys: Int32Array) {
  for (let id = 0; id < keys.length / 2; id++) {
    const at = id * 5, unit = layout.bindings[at];
    keys[id * 2] = layout.bindings[at + 3] + (unit < 0 ? 0 : units[unit * layout.stride] - layout.bindings[at + 1]);
    keys[id * 2 + 1] = layout.bindings[at + 4] + (unit < 0 ? 0 : units[unit * layout.stride + 1] - layout.bindings[at + 2]);
  }
}

/** CPU drawing reference; production animation uses GpuGround. */
export function groundSprites(scene: GameScene, layout: ReturnType<typeof groundLayout>, units: Int32Array, order: Uint32Array): Sprite[] {
  const sprites = scene.sprites.slice(0, layout.first);
  for (const id of order) {
    const o = scene.objects[id], at = id * 5, unit = layout.bindings[at];
    const dx = unit < 0 ? 0 : leptonToPixel(units[unit * layout.stride]) - leptonToPixel(layout.bindings[at + 1]);
    const dy = unit < 0 ? 0 : leptonToPixel(units[unit * layout.stride + 1]) - leptonToPixel(layout.bindings[at + 2]);
    sprites.push(...scene.sprites.slice(o.first, o.first + o.count).map((s,part) => {
      if (unit < 0 || !scene.animation) return {...s, x:s.x+dx,y:s.y+dy};
      const at=unit*layout.stride,type=MOVEMENT[units[at+UTYPE]],dir=units[at+UFACE],face=facingTo32(dir);
      let frame=BODY_SHAPE[face],x=leptonToPixel(units[at]),y=leptonToPixel(units[at+1]);
      if(type.infantry){
        frame=HUMAN_SHAPE[face];x-=2;y+=4;
        if(units[at+UDEST]>=0)frame=type.walk+HUMAN_SHAPE[face]*type.walkJump+Math.floor(units[at+UWALK]/2)%type.walkCount;
      }else if(part){
        frame+=32;
        if(type.name==='JEEP'||type.name==='BGGY')y-=4;
        if(type.name==='MLRS'||type.name==='MSAM'){const [tx,ty]=turretAdjust(dir);x+=tx;y+=ty;}
      }
      const region=scene.animation.frames.get(type.name)![frame];
      return {...s,region,x:x-Math.floor(region.width/2),y:y-Math.floor(region.height/2)};
    }));
  }
  return sprites;
}

export class GpuGround {
  readonly order: GpuOrder;
  readonly keys: StorageBufferAttribute;
  private readonly attributes: StorageBufferAttribute[];
  private readonly keyPass;
  private readonly spritePass;
  private readonly flashPass?: ComputeNode;
  private readonly flashSpritePass?: ComputeNode;
  constructor(private readonly renderer: WebGPURenderer, private readonly simulation: Pick<GpuSimulation,'units'|'frame'>,
    private readonly pipeline: PalettePipeline, readonly layout: ReturnType<typeof groundLayout>, scene?: GameScene,
    flashSource?: {state:StorageBufferAttribute;offset:number;clock:StorageBufferAttribute}) {
    const count = layout.keys.length / 2;
    this.keys = new StorageBufferAttribute(layout.keys.slice(), 1);
    const bindings = new StorageBufferAttribute(layout.bindings, 1), source = new StorageBufferAttribute(layout.packed, 4);
    this.attributes = [this.keys, bindings, source];
    this.order = new GpuOrder(renderer, this.keys, Uint32Array.from({length: count}, (_,i) =>
      layout.flashId < 0 ? i : i === 0 ? layout.flashId : i - 1));
    const key = storage(this.keys, 'int', count * 2);
    const meta = storage(bindings, 'int', layout.bindings.length).toReadOnly();
    const units = storage(simulation.units, 'int', simulation.units.count).toReadOnly();
    const local=flashSource && storage(flashSource.state,'int',flashSource.state.count).toReadOnly();
    const flash=local && {element:(i:number)=>local.element(flashSource!.offset+i)};
    const clock=flashSource && storage(flashSource.clock,'int',2).toReadOnly();
    this.keyPass = Fn(() => {
      const id = instanceIndex, at = id.mul(5), unit = meta.element(at);
      const x = meta.element(at.add(3)).toVar(), y = meta.element(at.add(4)).toVar();
      If(unit.greaterThanEqual(0), () => {
        x.addAssign(units.element(unit.mul(layout.stride)).sub(meta.element(at.add(1))));
        y.addAssign(units.element(unit.mul(layout.stride).add(1)).sub(meta.element(at.add(2))));
      });
      if(flash) If(unit.equal(-2).and(flash.element(2).greaterThanEqual(0)),()=>{
        // Ported from ANIM.CPP, AnimClass::Sort_Y: the move flash sorts one cell above its center.
        x.assign(flash.element(0));y.assign(flash.element(1).sub(256));
      });
      key.element(id.mul(2)).assign(x); key.element(id.mul(2).add(1)).assign(y);
    })().compute(count);
    if(flash){
      const seenAttribute=new StorageBufferAttribute(new Int32Array(1),1);this.attributes.push(seenAttribute);
      const seen=storage(seenAttribute,'int',1),ordered=storage(this.order.order,'uint',count);
      this.flashPass=Fn(()=>{
        // Ported from LAYER.CPP, Sorted_Add: relocate a new local animation in the partly sorted layer.
        If(seen.element(0).notEqual(flash.element(3)),()=>{
          const old=int(0).toVar(),insert=int(count-1).toVar();
          Loop(count,({i})=>{If(ordered.element(i).equal(layout.flashId),()=>{old.assign(i);});});
          Loop(count-1,({i})=>{If(i.greaterThanEqual(old),()=>{ordered.element(i).assign(ordered.element(i.add(1)));});});
          Loop(count-1,({i})=>{
            const at=int(ordered.element(i)).mul(2),x=key.element(at),y=key.element(at.add(1));
            If(insert.equal(count-1).and(y.greaterThan(flash.element(1).sub(256))
              .or(y.equal(flash.element(1).sub(256)).and(x.greaterThan(flash.element(0))))),()=>{insert.assign(i);});
          });
          Loop(count-1,({i})=>{const at=int(count-1).sub(i);If(at.greaterThan(insert),()=>{ordered.element(at).assign(ordered.element(at.sub(1)));});});
          ordered.element(insert).assign(layout.flashId);seen.element(0).assign(flash.element(3));
        });
      })().compute(1);
    }
    const order = storage(this.order.order, 'uint', count).toReadOnly();
    const original = storage(source, 'vec4', layout.count * 3).toReadOnly();
    const destination = storage(pipeline.spriteBuffer, 'vec4', pipeline.spriteBuffer.count);
    // Ported from FUNCTION.H, Lepton_To_Pixel; integer rounding precedes conversion for drawing.
    const pixel = (value: Node<'int'>) => value.mul(24).add(128).div(256);
    const animation: number[] = [];
    const types = MOVEMENT.flatMap(type => {
      const frames = scene?.animation?.frames.get(type.name), start = animation.length / 4;
      if (frames) for (const region of frames) animation.push(region.x,region.y,region.width,region.height);
      const flags = UNITS.get(type.name);
      return [start,type.infantry,type.walk,type.walkCount,type.walkJump,flags?.turret ? 1 : 0,
        type.name==='JEEP'||type.name==='BGGY' ? 1 : 0,type.name==='MLRS'||type.name==='MSAM' ? 1 : 0];
    });
    const flashFrames=scene?.animation?.frames.get('MOVEFLSH') ?? [],flashStart=animation.length/4;
    for(const region of flashFrames)animation.push(region.x,region.y,region.width,region.height);
    const animationAttribute=new StorageBufferAttribute(Int32Array.from(animation.length?animation:[0,0,0,0]),4);
    const typeAttribute=new StorageBufferAttribute(Int32Array.from(types),1);
    const facingAttribute=new StorageBufferAttribute(Int32Array.from(Array.from({length:256},(_,dir)=>[
      BODY_SHAPE[facingTo32(dir)],HUMAN_SHAPE[facingTo32(dir)],...turretAdjust(dir)]).flat()),4);
    this.attributes.push(animationAttribute,typeAttribute,facingAttribute);
    const frames=storage(animationAttribute,'ivec4',animationAttribute.count).toReadOnly();
    const typeData=storage(typeAttribute,'int',typeAttribute.count).toReadOnly();
    const facingData=storage(facingAttribute,'ivec4',256).toReadOnly();
    this.spritePass = Fn(() => {
      const index = int(instanceIndex), sourceIndex = index.toVar(), dx = int(0).toVar(), dy = int(0).toVar(), bound = int(-1).toVar();
      If(index.greaterThanEqual(layout.first), () => {
        const relative = index.sub(layout.first), id = order.element(relative.div(layout.slots)), at = id.mul(5);
        sourceIndex.assign(int(id).mul(layout.slots).add(relative.mod(layout.slots)).add(layout.first));
        const unit = meta.element(at);
        bound.assign(unit);
        If(unit.greaterThanEqual(0), () => {
          dx.assign(pixel(int(units.element(unit.mul(layout.stride)))).sub(pixel(int(meta.element(at.add(1))))));
          dy.assign(pixel(int(units.element(unit.mul(layout.stride).add(1)))).sub(pixel(int(meta.element(at.add(2))))));
        });
      });
      const rect = original.element(sourceIndex.mul(3));
      destination.element(index.mul(3)).assign(vec4(rect.x.add(dx), rect.y.add(dy), rect.zw));
      destination.element(index.mul(3).add(1)).assign(original.element(sourceIndex.mul(3).add(1)));
      destination.element(index.mul(3).add(2)).assign(original.element(sourceIndex.mul(3).add(2)));
      if(scene?.animation) If(bound.greaterThanEqual(0).and(rect.z.greaterThan(0)),()=>{
        const at=bound.mul(layout.stride),type=units.element(at.add(UTYPE)).mul(8),face=facingData.element(units.element(at.add(UFACE)));
        const frame=face.x.toVar(),x=pixel(int(units.element(at))).toVar(),y=pixel(int(units.element(at.add(1)))).toVar();
        const part=index.sub(layout.first).mod(layout.slots);
        If(typeData.element(type.add(1)).notEqual(0),()=>{
          frame.assign(face.y);x.subAssign(2);y.addAssign(4);
          If(units.element(at.add(UDEST)).greaterThanEqual(0),()=>{
            frame.assign(typeData.element(type.add(2)).add(face.y.mul(typeData.element(type.add(4))))
              .add(units.element(at.add(UWALK)).div(2).mod(typeData.element(type.add(3)))));
          });
        }).ElseIf(part.greaterThan(0),()=>{
          frame.addAssign(32);
          If(typeData.element(type.add(6)).notEqual(0),()=>{ y.subAssign(4); });
          If(typeData.element(type.add(7)).notEqual(0),()=>{x.addAssign(face.z);y.addAssign(face.w);});
        });
        const region=frames.element(typeData.element(type).add(frame));
        destination.element(index.mul(3)).assign(vec4(x.sub(region.z.div(2)),y.sub(region.w.div(2)),region.z,region.w));
        const info=original.element(sourceIndex.mul(3).add(1));
        destination.element(index.mul(3).add(1)).assign(vec4(region.x,region.y,info.z,info.w));
      });
    })().compute(layout.count);
    if(flash&&clock)this.flashSpritePass=Fn(()=>{
      const index=int(instanceIndex);
      If(index.greaterThanEqual(layout.first),()=>{
        const relative=index.sub(layout.first),id=order.element(relative.div(layout.slots));
        If(id.equal(layout.flashId).and(relative.mod(layout.slots).equal(0)),()=>{
          // The queued order starts on the next logic tick; that tick displays animation frame 0.
          const frame=clock.element(0).sub(flash.element(2)).sub(1);
          If(flash.element(2).greaterThanEqual(0).and(frame.greaterThanEqual(0)).and(frame.lessThan(flashFrames.length)),()=>{
            const region=frames.element(int(flashStart).add(frame));
            destination.element(index.mul(3)).assign(vec4(pixel(flash.element(0)).sub(region.z.div(2)),pixel(flash.element(1)).sub(region.w.div(2)),region.z,region.w));
            destination.element(index.mul(3).add(1)).assign(vec4(region.x,region.y,scene!.plainRemap,0));
            // ADATA.CPP MoveFlash uses WhiteTranslucentTable (singleUseFilter).
            destination.element(index.mul(3).add(2)).assign(vec4(3,0,0,0));
          });
        });
      });
    })().compute(layout.count);
    this.sort();
    this.updateSprites();
  }
  /** One bubble pass using the positions before this tick's simulation update. */
  sort() { this.renderer.compute(this.keyPass); if(this.flashPass)this.renderer.compute(this.flashPass); this.order.step(); }
  /** Write the new positions with the order established before the simulation update. */
  updateSprites() {
    this.renderer.compute(this.spritePass); if(this.flashSpritePass)this.renderer.compute(this.flashSpritePass); this.pipeline.updateGpuSprites(this.layout.count); this.pipeline.setFrame(this.simulation.frame);
  }
  dispose() { this.keyPass.dispose(); this.flashPass?.dispose(); this.flashSpritePass?.dispose(); this.spritePass.dispose(); this.order.dispose(); releaseStorage(this.renderer, this.attributes); }
}
