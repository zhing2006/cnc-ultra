// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute,Vector2, type WebGPURenderer, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, instanceIndex, int, storage, vec4,select,uniformArray,uniform,atomicStore,atomicMax } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { GpuReinsert } from '../../engine/simulation/reinsert.ts';
import { GpuOrder } from '../../engine/simulation/order.ts';
import { GpuSimulation } from '../../engine/simulation/gpu.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { UNIT_WORDS, X, Y } from '../../engine/simulation/state.ts';
import type { PalettePipeline, Sprite } from '../../engine/indexed/pipeline.ts';
import type { GameScene } from '../scene.ts';
import { leptonToPixel } from '../coord.ts';
import { BODY_SHAPE, HUMAN_SHAPE, facingTo32, turretAdjust } from '../coord.ts';
import { MOVEMENT,movementType } from '../data/movement.ts';
import { UNITS } from '../data/units.ts';
import { UTYPE, UFACE, UDEST, UWALK, UDOMAIN, UALTITUDE,UHEALTH,UGENERATION,UDOOR,UENTER,UCELL,UKIND,UATTACHED,UFLAGS,UNLOADING,HOVER_TETHERED } from './units-state.ts';
import { BUILDINGS } from '../data/buildings.ts';

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
  const aircraft=new Map((scene.scenario.aircraft??[]).map((u,i)=>[`aircraft:${u.cell}:${u.type}`,scene.scenario.units.length+scene.scenario.infantry.length+i]));
  const cloakSlots=stride!==UNIT_WORDS&&(scene.objects.some(o=>o.key.startsWith('live:'))||scene.scenario.units.some(u=>u.type==='STNK'))?3:1;
  const slots = scene.objects.reduce((max, object) => Math.max(max, object.count), cloakSlots);
  const first = scene.objects[0]?.first ?? scene.sprites.length;
  const keys = new Int32Array([...scene.objects.flatMap(o => [o.sortX, o.sortY]), ...(flash ? [0,-0x3fffffff] : [])]);
  const bindings = new Int32Array([...scene.objects.flatMap(o => {
    const unit = o.key.startsWith('live:')?Number(o.key.slice(5)):units.get(o.key) ?? (stride !== UNIT_WORDS ? infantry.get(`${o.key}:${o.sortX}:${o.sortY}`) ?? aircraft.get(o.key) : undefined) ?? -1;
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

/** UNIT.CPP / FOOT.CPP / AIRCRAFT.CPP Sort_Y, including infantry boarding an APC. */
export function updateGroundKeys(layout: ReturnType<typeof groundLayout>, units: Int32Array, keys: Int32Array) {
  for (let id = 0; id < keys.length / 2; id++) {
    const at = id * 5, unit = layout.bindings[at];
    keys[id * 2] = layout.bindings[at + 3] + (unit < 0 ? 0 : units[unit * layout.stride] - layout.bindings[at + 1]);
    keys[id * 2 + 1] = layout.bindings[at + 4] + (unit < 0 ? 0 : units[unit * layout.stride + 1] - layout.bindings[at + 2]);
    if(unit>=0&&layout.stride!==UNIT_WORDS){
      const p=unit*layout.stride,type=MOVEMENT[units[p+UTYPE]],b=BUILDINGS.get(type.name);
      if(units[p+UDOMAIN]===1){keys[id*2]=units[p];keys[id*2+1]=units[p+1]+128+(units[p+UALTITUDE]>=16||type.name==='C17'||type.name==='A10'?1<<24:0);}
      else if(!b){
        const carrier=units[p+UENTER]-1,tethered=type.infantry&&carrier>=0&&units[carrier*layout.stride+UTYPE]===movementType('APC')&&units[p+UDEST]===units[carrier*layout.stride+UCELL];
        const hover=type.name==='LST'&&(units[p+UFLAGS]&HOVER_TETHERED)!==0;
        keys[id*2]=units[p];keys[id*2+1]=units[p+1]+(hover?-128:type.infantry?(tethered||(units[p+UFLAGS]&UNLOADING)?256:48):128);
      }
      else if(b){keys[id*2]=units[p]+(type.name==='FIX'?-384:0);keys[id*2+1]=units[p+1]+(type.name==='FIX'?-384:type.name==='PYLE'||type.name==='PROC'?0:Math.trunc(b.height*256/3));}
    }
  }
}

/** AIRCRAFT.CPP In_Which_Layer and LAYER.CPP Sorted_Add on birth and layer changes. */
export function groundLayers(layout:ReturnType<typeof groundLayout>,units:Int32Array){
  return Int32Array.from({length:layout.keys.length/2},(_,id)=>{
    const unit=layout.bindings[id*5];if(unit<0)return -1;
    const at=unit*layout.stride,type=MOVEMENT[units[at+UTYPE]];
    return units[at+UGENERATION]*4+Number(units[at+UHEALTH]>0&&units[at+UATTACHED]===0)*2+Number(units[at+UDOMAIN]===1&&(units[at+UALTITUDE]>=16||type.name==='C17'||type.name==='A10'));
  });
}
export function transitionGround(layout:ReturnType<typeof groundLayout>,units:Int32Array,keys:Int32Array,order:Uint32Array,previous:Int32Array){
  const current=groundLayers(layout,units),list=Array.from(order);
  let unloading=false;
  for(let id=0;id<current.length;id++)if(current[id]!==previous[id]){
    previous[id]=current[id];
    if(current[id]>=0&&(current[id]&2)){
      unloading ||= (units[layout.bindings[id*5]*layout.stride+UFLAGS]&UNLOADING)!==0;
      list.splice(list.indexOf(id),1);insertGround(list,keys,id);
    }
  }
  order.set(list);
  return unloading;
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
      if(type.name==='APC'&&part===0&&units[at+UDOOR]&&(dir===32||dir===224))frame=dir===32?32:35;
      const region=scene.animation.frames.get(type.name)![frame];
      return {...s,region,x:x-Math.floor(region.width/2),y:y-Math.floor(region.height/2)};
    }));
  }
  return sprites;
}

export class GpuGround {
  readonly order: GpuOrder;
  readonly keys: StorageBufferAttribute;
  readonly bindings:StorageBufferAttribute;
  private readonly attributes: StorageBufferAttribute[];
  private readonly keyPass;
  private readonly spritePass;
  private readonly changes?: GpuReinsert;
  private readonly flashSpritePass?: ComputeNode;
  private readonly clearUnloadSort?: ComputeNode;
  private readonly source: StorageBufferAttribute;
  constructor(private readonly renderer: WebGPURenderer, private readonly simulation: Pick<GpuSimulation,'units'|'frame'>,
    private readonly pipeline: PalettePipeline, readonly layout: ReturnType<typeof groundLayout>, private readonly scene?: GameScene,
    flashSource?: {state:StorageBufferAttribute;offset:number;clock:StorageBufferAttribute}, hovercraftUnloading=false) {
    const count = layout.keys.length / 2;
    this.keys = new StorageBufferAttribute(layout.keys.slice(), 1);
    const bindings = new StorageBufferAttribute(layout.bindings, 1), source = new StorageBufferAttribute(layout.packed, 4);
    this.source=source;
    this.bindings=bindings;
    this.attributes = [this.keys, bindings, source];
    const unloadSort = hovercraftUnloading && scene?.animation?.frames.has('LST') ? new StorageBufferAttribute(new Int32Array(1), 1) : undefined;
    const unload = unloadSort && storage(unloadSort, 'int', 1).toAtomic();
    if (unloadSort && unload) {
      this.attributes.push(unloadSort);
      this.clearUnloadSort = Fn(() => { atomicStore(unload.element(0), int(0)); })().compute(1);
    }
    // Ported from UNIT.CPP, Unload_Hovercraft_Process: three ground-layer sweeps
    // settle all newly detached passengers before their first visible frame.
    this.order = new GpuOrder(renderer, this.keys, Uint32Array.from({length: count}, (_,i) =>
      layout.flashId < 0 ? i : i === 0 ? layout.flashId : i - 1),
      unloadSort ? { condition: storage(unloadSort, 'int', 1).toReadOnly().element(0).notEqual(0), count: 2 } : undefined);
    const key = storage(this.keys, 'int', count * 2);
    const meta = storage(bindings, 'int', layout.bindings.length).toReadOnly();
    const units = storage(simulation.units, 'int', simulation.units.count).toReadOnly();
    const local=flashSource && storage(flashSource.state,'int',flashSource.state.count).toReadOnly();
    const flash=local && {element:(i:number)=>local.element(flashSource!.offset+i)};
    const clock=flashSource && storage(flashSource.clock,'int',2).toReadOnly();
    const buildingSort=uniformArray<'ivec2'>(MOVEMENT.map(t=>{const b=BUILDINGS.get(t.name);return new Vector2(t.name==='FIX'?-384:0,t.name==='FIX'?-384:t.name==='PYLE'||t.name==='PROC'?0:b?Math.trunc(b.height*256/3):128);}), 'ivec2');
    let seen:ReturnType<typeof storage<'int'>>|undefined;
    if(layout.stride!==UNIT_WORDS||flash){
      this.changes=new GpuReinsert(renderer,this.keys,this.order.order);
      const previous=new StorageBufferAttribute(groundLayers(layout,simulation.units.array as Int32Array),1);
      this.attributes.push(previous);seen=storage(previous,'int',count);
    }
    this.keyPass = Fn(() => {
      const id = instanceIndex, at = id.mul(5), unit = meta.element(at),changed=int(0).toVar();
      const x = meta.element(at.add(3)).toVar(), y = meta.element(at.add(4)).toVar();
      If(unit.greaterThanEqual(0), () => {
        x.addAssign(units.element(unit.mul(layout.stride)).sub(meta.element(at.add(1))));
        y.addAssign(units.element(unit.mul(layout.stride).add(1)).sub(meta.element(at.add(2))));
        if(layout.stride!==UNIT_WORDS)If(units.element(unit.mul(layout.stride).add(UDOMAIN)).equal(1),()=>{
          x.assign(units.element(unit.mul(layout.stride)));
          y.assign(units.element(unit.mul(layout.stride).add(1)).add(128));
          const type=units.element(unit.mul(layout.stride).add(UTYPE));
          If(units.element(unit.mul(layout.stride).add(UALTITUDE)).greaterThanEqual(16).or(type.equal(movementType('C17'))).or(type.equal(movementType('A10'))),()=>{y.addAssign(1<<24);});
        }).ElseIf(units.element(unit.mul(layout.stride).add(UDOMAIN)).equal(0),()=>{
          const at=unit.mul(layout.stride),foot=units.element(at.add(UKIND)),carrier=units.element(at.add(UENTER)).sub(1);
          x.assign(units.element(at));y.assign(units.element(at.add(1)).add(select(foot.notEqual(0),int(48),int(128))));
          // Ported from UNIT.CPP / FOOT.CPP, Sort_Y: keep the deck behind its passengers.
          If(units.element(at.add(UTYPE)).equal(movementType('LST')).and(units.element(at.add(UFLAGS)).bitAnd(HOVER_TETHERED).notEqual(0)),()=>{
            y.assign(units.element(at.add(1)).sub(128));
          });
          If(foot.notEqual(0).and(units.element(at.add(UFLAGS)).bitAnd(UNLOADING).notEqual(0)),()=>{
            y.assign(units.element(at.add(1)).add(256));
          });
          If(foot.notEqual(0).and(carrier.greaterThanEqual(0)),()=>{
            If(units.element(carrier.mul(layout.stride).add(UTYPE)).equal(movementType('APC')).and(units.element(at.add(UDEST)).equal(units.element(carrier.mul(layout.stride).add(UCELL)))),()=>{y.assign(units.element(at.add(1)).add(256));});
          });
        }).ElseIf(units.element(unit.mul(layout.stride).add(UDOMAIN)).equal(2),()=>{
          const offset=buildingSort.element(units.element(unit.mul(layout.stride).add(UTYPE)));
          x.assign(units.element(unit.mul(layout.stride)).add(offset.x));y.assign(units.element(unit.mul(layout.stride).add(1)).add(offset.y));
        });
      });
      if(flash) If(unit.equal(-2).and(flash.element(2).greaterThanEqual(0)),()=>{
        // Ported from ANIM.CPP, AnimClass::Sort_Y: the move flash sorts one cell above its center.
        x.assign(flash.element(0));y.assign(flash.element(1).sub(256));
      });
      key.element(id.mul(2)).assign(x); key.element(id.mul(2).add(1)).assign(y);
      if(seen&&this.changes){
        If(unit.greaterThanEqual(0),()=>{
          const at=unit.mul(layout.stride),alive=units.element(at.add(UHEALTH)).greaterThan(0).and(units.element(at.add(UATTACHED)).equal(0)),type=units.element(at.add(UTYPE));
          const top=units.element(at.add(UDOMAIN)).equal(1).and(units.element(at.add(UALTITUDE)).greaterThanEqual(16).or(type.equal(movementType('C17'))).or(type.equal(movementType('A10'))));
          const state=units.element(at.add(UGENERATION)).mul(4).add(int(alive).mul(2)).add(int(top));
          If(seen!.element(id).notEqual(state),()=>{
            seen!.element(id).assign(state);
            If(alive,()=>{
              changed.assign(1);
              if(unload)If(units.element(at.add(UFLAGS)).bitAnd(UNLOADING).notEqual(0),()=>{atomicMax(unload.element(0),int(1));});
            });
          });
        });
        if(flash)If(unit.equal(-2).and(flash.element(2).greaterThanEqual(0)).and(seen.element(id).notEqual(flash.element(3))),()=>{
          seen!.element(id).assign(flash.element(3));changed.assign(1);
        });
        If(changed.notEqual(0),()=>{this.changes!.changes.add(int(id));});
      }
    })().compute(count);
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
      if(scene?.animation) If(bound.greaterThanEqual(0).and(rect.z.greaterThan(0)).and(units.element(bound.mul(layout.stride).add(UDOMAIN)).equal(0)),()=>{
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
        // UNIT.CPP Draw_It, DOOR.CPP Door_Stage: APC doors use frames 32/35 at NE/NW.
        If(part.equal(0).and(units.element(at.add(UTYPE)).equal(movementType('APC'))).and(units.element(at.add(UDOOR)).notEqual(0)),()=>{
          If(units.element(at.add(UFACE)).equal(32),()=>{frame.assign(32);}).ElseIf(units.element(at.add(UFACE)).equal(224),()=>{frame.assign(35);});
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
  /** Sort before movement, including the immediate extra sweeps when hovercraft cargo unloads. */
  sort() { this.changes?.clear();if(this.clearUnloadSort)this.renderer.compute(this.clearUnloadSort);this.renderer.compute(this.keyPass);this.changes?.step();this.order.step(); }
  transitionLayers(){if(this.changes){this.changes.clear();this.renderer.compute(this.keyPass);this.changes.step();}}
  /** CELL.CPP Goodie_Check removes a collected crate from the static ground layer. */
  setStaticSpriteVisible(index:number,visible:boolean){
    const sprite=this.scene!.sprites[index],values=this.source.array as Float32Array;
    values[index*12+2]=visible?sprite.region.width:0;values[index*12+3]=visible?sprite.region.height:0;
    this.source.addUpdateRange(index*12+2,2);this.source.needsUpdate=true;
  }
  /** Write the new positions with the order established before the simulation update. */
  updateSprites(rebuildIndex=true) {
    this.renderer.compute(this.spritePass); if(this.flashSpritePass)this.renderer.compute(this.flashSpritePass); if(rebuildIndex)this.pipeline.updateGpuSprites(this.layout.count); this.pipeline.setFrame(this.simulation.frame);
  }
  dispose() { this.keyPass.dispose();this.changes?.dispose(); this.clearUnloadSort?.dispose(); this.flashSpritePass?.dispose(); this.spritePass.dispose(); this.order.dispose(); releaseStorage(this.renderer, this.attributes); }
}
