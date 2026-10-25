// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { IndirectStorageBufferAttribute,StorageBufferAttribute,Vector4,type ComputeNode,type Node } from 'three/webgpu';
import { Fn,If,Continue,Break,int,uint,storage,uniform,instanceIndex,select,vec4,atomicStore,atomicMax,wgslFn } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { randomNode,intMax,intMin } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { GpuPrefixSum } from '../../engine/simulation/prefix-sum.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { MOVEMENT,movementType } from '../data/movement.ts';
import { WALLS } from '../data/overlays.ts';
import { ANIMATION_IDS as A,combatTypes,warheads } from '../data/combat.ts';
import { movePoint } from '../coord.ts';
import type { PalettePipeline } from '../../engine/indexed/pipeline.ts';
import type { GameScene } from '../scene.ts';
import type { GpuCombat } from './combat-gpu.ts';
import * as E from './building-effects-state.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
type I=Node<'int'>;
const MAX_REQUESTS=48;
const exchange=wgslFn('fn effectExchange(p: ptr<storage, atomic<u32>, read_write>, value: u32) -> u32 { return atomicExchange(p,value); }');

/** Ordered original building effects; fire damage and animation lifetime remain integer state. */
export class GpuBuildingEffects {
  get saveBuffers() { return this.attributes; }
  readonly state:StorageBufferAttribute;
  readonly smudges:StorageBufferAttribute;
  readonly capacity:number;
  private readonly attributes:StorageBufferAttribute[]=[];
  private readonly passes:ComputeNode[];
  private readonly spawnPass:ComputeNode;
  private readonly external=uniform(new Vector4(),'ivec4');
  private readonly externalPass:ComputeNode;
  private readonly prefixes:GpuPrefixSum[];
  private drawPass?:ComputeNode;
  constructor(readonly battle:GpuCombat,frames:E.EffectFrames,smudges?:StorageBufferAttribute){
    const count=battle.setup.units.length,width=battle.setup.grid.width,initial=E.initialBuildingEffects(battle.setup),definitions=E.effectDefinitions(frames),base=initial.base;
    this.capacity=initial.capacity;
    const keep=(array:Int32Array)=>{const b=new StorageBufferAttribute(array,1);this.attributes.push(b);return b;};
    this.state=keep(initial.state);this.smudges=smudges??keep(new Int32Array(battle.setup.grid.edges.length));
    const types=MOVEMENT.flatMap((type,id)=>[WALLS[type.name]?0:BUILDINGS.get(type.name)?.occupy.reduce((mask,[x,y])=>mask|(1<<(y*4+x)),0)??0,type.strength,warheads[3].armor[combatTypes[id].armor]]);
    const defBase=types.length,trigBase=defBase+definitions.length*8;
    const values=[...types,...definitions.flatMap(a=>[a.count,a.loopEnd,a.start,a.loopStart,a.loops,a.damage,Math.max(1,a.rate),a.next]),...Array.from({length:256},(_,dir)=>movePoint(0,0,dir,128)).flat()];
    const data=storage(keep(Int32Array.from(values)),'int',values.length).toReadOnly();
    const renderer=battle.renderer,cells=battle.setup.grid.edges.length,wordCount=Math.ceil(this.capacity/32);
    const linkBuffer=keep(new Int32Array(count+this.capacity));
    const requestBuffer=keep(new Int32Array(count*MAX_REQUESTS*E.EFFECT_WORDS)),countBuffer=keep(new Int32Array(count)),freeBuffer=keep(new Int32Array(wordCount*2)),markBuffer=keep(new Int32Array(cells));
    const dispatch=new IndirectStorageBufferAttribute(new Uint32Array([0,1,1]),1);this.attributes.push(dispatch);
    const s=storage(this.state,'int',this.state.count),u=storage(battle.units,'int',battle.units.count),c=storage(battle.state,'int',battle.state.count),clock=storage(battle.movement.control,'int',2).toReadOnly();
    this.externalPass=Fn(()=>{
      const request=this.external,kind=request.x;
      If(data.element(kind.mul(8).add(defBase)).greaterThan(0),()=>{
        Loop(this.capacity,({i})=>{
          const at=i.mul(E.EFFECT_WORDS).add(base);
          If(s.element(at.add(E.ETYPE)).equal(0),()=>{
            const values=[kind.add(1),int(0),int(0),intMax(int(1),request.w.mul(data.element(kind.mul(8).add(defBase+4))).bitAnd(255)),int(0),int(0),request.y,request.z,clock.element(0),int(0),int(0)];
            values.forEach((value,index)=>s.element(at.add(index)).assign(value));Break();
          });
        });
      });
    })().compute(1);
    const links=storage(linkBuffer,'uint',linkBuffer.count).toAtomic(),linked=storage(linkBuffer,'uint',linkBuffer.count).toReadOnly();
    const clearLinks=Fn(()=>{atomicStore(links.element(instanceIndex),uint(0xffffffff));})().compute(count);
    const link=Fn(()=>{
      const slot=int(instanceIndex),at=slot.mul(E.EFFECT_WORDS).add(base),parent=s.element(at.add(E.EPARENT)).sub(1);
      If(s.element(at.add(E.ETYPE)).notEqual(0).and(parent.greaterThanEqual(0)),()=>{
        If(u.element(parent.mul(U.WORDS).add(U.UHEALTH)).greaterThan(0).and(u.element(parent.mul(U.WORDS).add(U.UGENERATION)).equal(s.element(at.add(E.EGEN)))),()=>{
          atomicStore(links.element(slot.add(count)),exchange(links.element(parent),uint(slot)));
        });
      });
    })().compute(this.capacity);
    const advance=(slot:I,withDamage:boolean)=>{Loop(1,()=>{
      const tick=clock.element(0);
        const at=slot.mul(E.EFFECT_WORDS).add(base);
        If(s.element(at.add(E.ETYPE)).equal(0).or(tick.lessThanEqual(s.element(at.add(E.EBORN)).add(1))),()=>{Continue();});
        If(s.element(at.add(E.EDELAY)).greaterThan(0),()=>{s.element(at.add(E.EDELAY)).subAssign(1);Continue();});
        const type=s.element(at.add(E.ETYPE)).sub(1).mul(8).add(defBase).toVar();
        s.element(at.add(E.ETIMER)).addAssign(1);If(s.element(at.add(E.ETIMER)).lessThan(data.element(type.add(6))),()=>{Continue();});
        s.element(at.add(E.ETIMER)).assign(0);s.element(at.add(E.EFRAME)).addAssign(1);
        if(withDamage){
        const parent=s.element(at.add(E.EPARENT)).sub(1).toVar(),attached=int(0).toVar();
        If(parent.greaterThanEqual(0),()=>{attached.assign(int(u.element(parent.mul(U.WORDS).add(U.UGENERATION)).equal(s.element(at.add(E.EGEN))).and(u.element(parent.mul(U.WORDS).add(U.UHEALTH)).greaterThan(0))));});
        If(attached.notEqual(0),()=>{
          s.element(at.add(E.EACCUM)).addAssign(data.element(type.add(5)));
          const raw=s.element(at.add(E.EACCUM)).shiftRight(8).toVar();s.element(at.add(E.EACCUM)).bitAndAssign(255);
          const p=parent.mul(U.WORDS),damage=battle.scaleDamage(raw.mul(data.element(u.element(p.add(U.UTYPE)).mul(3).add(2))).add(128).shiftRight(8),u.element(p.add(U.UOWNER)));
          If(damage.greaterThan(0),()=>{u.element(p.add(U.UHEALTH)).assign(intMax(int(0),u.element(p.add(U.UHEALTH)).sub(damage)));c.element(parent.mul(C.CWORDS).add(C.CWARHEAD)).assign(3);});
          If(u.element(p.add(U.UHEALTH)).equal(0),()=>{
            const cp=parent.mul(C.CWORDS);c.element(cp.add(C.CDEATH)).assign(tick);c.element(cp.add(C.CKILLER)).assign(-1);c.element(cp.add(C.CTARGET)).assign(-1);c.element(cp.add(C.CFIRE)).assign(-1);s.element(at.add(E.ETYPE)).assign(0);Continue();
          });
        }).Else(()=>{
          If(parent.greaterThanEqual(0),()=>{s.element(at.add(E.EX)).addAssign(u.element(parent.mul(U.WORDS).add(U.UX)));s.element(at.add(E.EY)).addAssign(u.element(parent.mul(U.WORDS).add(U.UY)));s.element(at.add(E.EPARENT)).assign(0);});
        });
        }else{
          const parent=s.element(at.add(E.EPARENT)).sub(1);
          If(parent.greaterThanEqual(0),()=>{s.element(at.add(E.EX)).addAssign(u.element(parent.mul(U.WORDS).add(U.UX)));s.element(at.add(E.EY)).addAssign(u.element(parent.mul(U.WORDS).add(U.UY)));s.element(at.add(E.EPARENT)).assign(0);});
        }
        const end=select(s.element(at.add(E.ELOOPS)).greaterThan(1),data.element(type.add(1)).sub(data.element(type.add(2))),data.element(type));
        If(s.element(at.add(E.EFRAME)).greaterThanEqual(end),()=>{
          If(s.element(at.add(E.ELOOPS)).greaterThan(0),()=>{s.element(at.add(E.ELOOPS)).subAssign(1);});
          If(s.element(at.add(E.ELOOPS)).notEqual(0),()=>{s.element(at.add(E.EFRAME)).assign(data.element(type.add(3)));})
            .ElseIf(data.element(type.add(7)).greaterThanEqual(0),()=>{const next=data.element(type.add(7));s.element(at.add(E.ETYPE)).assign(next.add(1));s.element(at.add(E.EFRAME)).assign(data.element(next.mul(8).add(defBase+2)));})
            .Else(()=>{s.element(at.add(E.ETYPE)).assign(0);});
        });
    });};
    const loose=Fn(()=>{
      const slot=int(instanceIndex),at=slot.mul(E.EFFECT_WORDS).add(base),attached=int(0).toVar();
      If(s.element(at.add(E.ETYPE)).notEqual(0),()=>{
        const parent=s.element(at.add(E.EPARENT)).sub(1);
        If(parent.greaterThanEqual(0),()=>{attached.assign(int(u.element(parent.mul(U.WORDS).add(U.UHEALTH)).greaterThan(0).and(u.element(parent.mul(U.WORDS).add(U.UGENERATION)).equal(s.element(at.add(E.EGEN))))));});
        If(attached.equal(0),()=>{advance(slot,false);});
      });
    })().compute(this.capacity);
    const attached=Fn(()=>{
      const parent=int(instanceIndex),last=int(-1).toVar();
      Loop(()=>{
        const slot=int(0x7fffffff).toVar(),candidate=int(linked.element(parent)).toVar();
        Loop(()=>{If(candidate.lessThan(0),()=>{Break();});If(candidate.greaterThan(last).and(candidate.lessThan(slot)),()=>{slot.assign(candidate);});candidate.assign(int(linked.element(candidate.add(count))));});
        If(slot.equal(0x7fffffff),()=>{Break();});advance(slot,true);last.assign(slot);
      });
    })().compute(count);
    const freeInfo=storage(freeBuffer,'uint',freeBuffer.count),requestCounts=storage(countBuffer,'uint',count),requests=storage(requestBuffer,'int',requestBuffer.count);
    const collectFree=Fn(()=>{
      const word=int(instanceIndex),bits=uint(0).toVar(),total=uint(0).toVar();
      Loop(32,({i})=>{const slot=word.mul(32).add(i);If(slot.lessThan(this.capacity),()=>{If(s.element(slot.mul(E.EFFECT_WORDS).add(base+E.ETYPE)).equal(0),()=>{bits.bitOrAssign(uint(1).shiftLeft(uint(i)));total.addAssign(1);});});});
      freeInfo.element(word).assign(total);freeInfo.element(word.add(wordCount)).assign(bits);
    })().compute(wordCount);
    const markRequests=storage(markBuffer,'uint',cells).toAtomic();
    const clearMarks=Fn(()=>{atomicStore(markRequests.element(instanceIndex),uint(0));})().compute(cells);
    const emit=Fn(()=>{
      const id=int(instanceIndex),tick=clock.element(0),requestCount=int(0).toVar();
      Loop(1,()=>{
        const at=id.mul(U.WORDS),p=id.mul(C.CWORDS),hp=u.element(at.add(U.UHEALTH)).toVar(),old=s.element(id.mul(2)).toVar(),type=u.element(at.add(U.UTYPE)).mul(3).toVar();
        const same=s.element(id.mul(2).add(1)).equal(u.element(at.add(U.UGENERATION))).toVar();
        s.element(id.mul(2)).assign(hp);s.element(id.mul(2).add(1)).assign(u.element(at.add(U.UGENERATION)));
        If(same.not(),()=>{Continue();});
        If(u.element(at.add(U.UTYPE)).equal(movementType('BOAT')).and(hp.greaterThan(0)).and(old.mul(2).greaterThanEqual(700)).and(hp.mul(2).lessThan(700)),()=>{
          const kind=A.ANIM_ON_FIRE_MED;
          If(data.element(int(kind*8+defBase)).greaterThan(0),()=>{
            const x=int(randomNode(uint(battle.setup.seed),uint(tick),uint(id),uint(322)).mod(uint(17))).sub(8).mul(256).add(12).div(24);
            const dst=id.mul(MAX_REQUESTS*E.EFFECT_WORDS),entry=[int(kind+1),int(0),int(1),data.element(int(kind*8+defBase+4)),int(0),id.add(1),x,int(-20),tick,u.element(at.add(U.UGENERATION)),int(0)];
            entry.forEach((value,index)=>requests.element(dst.add(index)).assign(value));requestCount.assign(1);
          });
        });
        If(data.element(type).equal(0),()=>{Continue();});
        const death=c.element(p.add(C.CDEATH)),dead=old.greaterThan(0).and(hp.lessThanEqual(0)).and(death.greaterThanEqual(0));
        const burn=hp.greaterThan(0).and(old.mul(2).greaterThanEqual(data.element(type.add(1))).and(hp.mul(2).lessThan(data.element(type.add(1)))).or(hp.equal(1).and(old.greaterThan(1))));
        const debris=hp.lessThanEqual(0).and(death.greaterThanEqual(0)).and(death.equal(tick.sub(8)));
        If(dead.or(burn).or(debris),()=>{
          const part=int(0).toVar();
          Loop(16,({i:offset})=>{
            If(data.element(type).bitAnd(int(1).shiftLeft(offset)).equal(0),()=>{Continue();});
            const cell=u.element(at.add(U.UORIGIN)).add(offset.div(4).mul(width)).add(offset.mod(4)).toVar();
            const pick=(stream:number,n:number)=>int(randomNode(uint(battle.setup.seed),uint(tick),uint(id),uint(part.mul(24).add(300+stream))).mod(uint(n)));
            const spawn=(kind:I,radius:number,delay:I,loops:I,parent:I,stream:number,offsetX=0,offsetY=0,corner=false)=>{
              If(data.element(kind.mul(8).add(defBase)).greaterThan(0),()=>{
                const origin=corner?0:128,x=cell.mod(width).mul(256).add(origin+offsetX),y=cell.div(width).mul(256).add(origin+offsetY),direction=pick(stream,256).mul(2).add(trigBase);
                const xx=x.add(data.element(direction).mul(radius).shiftRight(7)).toVar(),yy=y.sub(data.element(direction.add(1)).negate().mul(radius).shiftRight(7)).toVar();
                If(xx.lessThan(0).or(yy.lessThan(0)).or(xx.greaterThanEqual(width*256)).or(yy.greaterThanEqual(battle.setup.grid.height*256)),()=>{xx.assign(x);yy.assign(y);});
                const dst=id.mul(MAX_REQUESTS).add(requestCount).mul(E.EFFECT_WORDS),entry=[kind.add(1),int(0),delay,intMax(int(1),intMax(int(1),loops).mul(data.element(kind.mul(8).add(defBase+4))).bitAnd(255)),int(0),parent,xx.sub(select(parent.greaterThan(0),u.element(at.add(U.UX)),int(0))),yy.sub(select(parent.greaterThan(0),u.element(at.add(U.UY)),int(0))),tick,u.element(at.add(U.UGENERATION)),int(0)];
                entry.forEach((value,index)=>requests.element(dst.add(index)).assign(value));requestCount.addAssign(1);
              });
            };
            If(dead,()=>{
              atomicMax(markRequests.element(cell),uint(id.add(1).mul(16).add(pick(0,6)).add(1)));
              If(pick(1,2).equal(0),()=>{spawn(int(A.ANIM_FIRE_SMALL),128,pick(2,8),pick(3,3).add(1),int(0),4);If(pick(5,2).equal(0),()=>{spawn(int(A.ANIM_FIRE_MED),64,pick(6,8),pick(7,3).add(1),int(0),8);});});
              spawn(int(A.ANIM_FBALL1),64,pick(9,4),int(1),int(0),10);
            });
            If(burn,()=>{
              If(part.equal(0).and(u.element(at.add(U.UTYPE)).equal(movementType('V19'))).and(old.mul(2).greaterThanEqual(data.element(type.add(1)))).and(hp.mul(2).lessThan(data.element(type.add(1)))),()=>{
                spawn(int(A.ANIM_OILFIELD_BURN),0,int(1),int(1),id.add(1),21,304,64,true);
              });
              If(c.element(p.add(C.CWARHEAD)).equal(3),()=>{const roll=pick(11,14);If(roll.lessThan(9),()=>{spawn(int(select(roll.lessThan(5),int(A.ANIM_ON_FIRE_SMALL),select(roll.lessThan(8),int(A.ANIM_ON_FIRE_MED),int(A.ANIM_ON_FIRE_BIG)))),96,int(0),int(select(roll.equal(8),int(1),pick(12,3).add(1))),id.add(1),13);});})
                .ElseIf(pick(11,2).equal(0),()=>{spawn(int(A.ANIM_FIRE_SMALL),96,pick(12,8),pick(13,3).add(1),id.add(1),14);});
            });
            If(debris,()=>{If(pick(15,6).lessThan(3),()=>{spawn(int(A.ANIM_SMOKE_M),80,pick(16,6),pick(17,2).add(1),int(0),18);});atomicMax(markRequests.element(cell),uint(id.add(1).mul(16).add(int(select(pick(19,4).equal(0),int(7),int(1)))).add(pick(20,6))));});
            part.addAssign(1);
          });
        });
      });
      requestCounts.element(id).assign(uint(requestCount));
    })().compute(count);
    const requestPrefix=new GpuPrefixSum(renderer,countBuffer,count),freePrefix=new GpuPrefixSum(renderer,freeBuffer,wordCount);this.prefixes=[requestPrefix,freePrefix];
    const starts=storage(requestPrefix.output,'uint',requestPrefix.output.count).toReadOnly(),available=storage(freePrefix.output,'uint',freePrefix.output.count).toReadOnly();
    const dispatchData=storage(dispatch,'uint',3);
    const prepare=Fn(()=>{const total=intMin(int(starts.element(count)),int(available.element(wordCount)));dispatchData.element(0).assign(uint(total.add(63).div(64)));})().compute(1);
    this.spawnPass=Fn(()=>{
      const rank=int(instanceIndex),total=intMin(int(starts.element(count)),int(available.element(wordCount)));
      If(rank.lessThan(total),()=>{
        const actorLow=int(0).toVar(),actorHigh=int(count).toVar();
        Loop(()=>{If(actorLow.greaterThanEqual(actorHigh),()=>{Break();});const mid=actorLow.add(actorHigh).div(2).toVar();If(starts.element(mid).lessThanEqual(uint(rank)),()=>{actorLow.assign(mid.add(1));}).Else(()=>{actorHigh.assign(mid);});});
        const actor=actorLow.sub(1).toVar(),wordLow=int(0).toVar(),wordHigh=int(wordCount).toVar();
        Loop(()=>{If(wordLow.greaterThanEqual(wordHigh),()=>{Break();});const mid=wordLow.add(wordHigh).div(2).toVar();If(available.element(mid).lessThanEqual(uint(rank)),()=>{wordLow.assign(mid.add(1));}).Else(()=>{wordHigh.assign(mid);});});
        const word=wordLow.sub(1).toVar(),ordinal=rank.sub(int(available.element(word))).toVar(),bits=freeInfo.element(word.add(wordCount)).toVar(),bit=int(0).toVar();
        Loop(32,({i})=>{If(bits.bitAnd(uint(1).shiftLeft(uint(i))).notEqual(0),()=>{If(ordinal.equal(0),()=>{bit.assign(i);Break();});ordinal.subAssign(1);});});
        const dst=word.mul(32).add(bit).mul(E.EFFECT_WORDS).add(base),src=actor.mul(MAX_REQUESTS).add(rank.sub(int(starts.element(actor)))).mul(E.EFFECT_WORDS);
        for(let field=0;field<E.EFFECT_WORDS;field++)s.element(dst.add(field)).assign(requests.element(src.add(field)));
      });
    })().computeKernel([64]);
    (this.spawnPass as unknown as {dispatchSize:IndirectStorageBufferAttribute}).dispatchSize=dispatch;
    const marks=storage(this.smudges,'uint',cells),markValues=storage(markBuffer,'uint',cells).toReadOnly();
    const applyMarks=Fn(()=>{const cell=int(instanceIndex),value=markValues.element(cell);If(value.greaterThan(0),()=>{marks.element(cell).assign(value.mod(16));});})().compute(cells);
    this.passes=[clearLinks,link,loose,attached,collectFree,clearMarks,emit,...requestPrefix.kernels,...freePrefix.kernels,applyMarks,prepare];
  }
  prepareForPlay(){return this.battle.renderer.compileComputeAsync([...this.passes,this.spawnPass,this.externalPass]);}
  step(){this.battle.renderer.compute(this.passes);this.battle.renderer.compute(this.spawnPass);this.battle.movement.refreshOccupancy();}
  setView(pipeline:PalettePipeline,scene:GameScene,start:number){
    const rects:number[]=[],starts=E.effectDefinitions(scene.animation!.frames).flatMap(a=>{const at=rects.length/4;for(const r of scene.animation!.frames.get(a.name)??[])rects.push(r.x,r.y,r.width,r.height);return [at,a.start];});
    const attribute=new StorageBufferAttribute(Int32Array.from([...starts,...rects]),1);this.attributes.push(attribute);
    const data=storage(attribute,'int',attribute.count).toReadOnly(),s=storage(this.state,'int',this.state.count).toReadOnly(),dest=storage(pipeline.spriteBuffer,'vec4',pipeline.spriteBuffer.count),base=this.battle.setup.units.length*2;
    const units=storage(this.battle.movement.units,'int',this.battle.movement.units.count).toReadOnly();
    this.drawPass=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(E.EFFECT_WORDS).add(base),dst=id.add(start).mul(3),kind=s.element(at.add(E.ETYPE)).sub(1);
      dest.element(dst).assign(vec4(0));dest.element(dst.add(2)).assign(vec4(0));
      If(kind.greaterThanEqual(0).and(s.element(at.add(E.EDELAY)).equal(0)),()=>{
        const frame=data.element(kind.mul(2)).add(data.element(kind.mul(2).add(1))).add(s.element(at.add(E.EFRAME))),r=frame.mul(4).add(starts.length);
        const w=data.element(r.add(2)),h=data.element(r.add(3));
        const x=s.element(at.add(E.EX)).toVar(),y=s.element(at.add(E.EY)).toVar(),parent=s.element(at.add(E.EPARENT)).sub(1);
        If(parent.greaterThanEqual(0),()=>{x.addAssign(units.element(parent.mul(U.WORDS).add(U.UX)));y.addAssign(units.element(parent.mul(U.WORDS).add(U.UY)));});
        dest.element(dst).assign(vec4(x.mul(24).add(128).div(256).sub(w.div(2)),y.mul(24).add(128).div(256).sub(h.div(2)),w,h));
        dest.element(dst.add(1)).assign(vec4(data.element(r),data.element(r.add(1)),scene.plainRemap,0));
      });
    })().compute(this.capacity);
  }
  update(){if(this.drawPass)this.battle.renderer.compute(this.drawPass);}
  spawn(request:E.AnimationRequest){this.external.value.set(request.kind,request.x,request.y,request.loops??1);this.battle.renderer.compute(this.externalPass);}
  dispose(){for(const pass of this.passes)if(!this.prefixes.some(prefix=>prefix.kernels.includes(pass)))pass.dispose();for(const prefix of this.prefixes)prefix.dispose();this.externalPass.dispose();this.spawnPass.dispose();this.drawPass?.dispose();releaseStorage(this.battle.renderer,this.attributes);}
}
