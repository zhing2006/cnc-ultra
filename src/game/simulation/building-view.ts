// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type ComputeNode } from 'three/webgpu';
import { Fn, If, int, instanceIndex, storage, vec4, ivec4, select } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { intMax, intMin } from '../../engine/simulation/integer-nodes.ts';
import type { PalettePipeline } from '../../engine/indexed/pipeline.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { combatTypes } from '../data/combat.ts';
import { WALLS } from '../data/overlays.ts';
import { BODY_SHAPE, facingTo32 } from '../coord.ts';
import type { GpuGround } from './ground.ts';
import type { EconomyRuntime } from './economy-runtime.ts';
import { BUILDING_WORDS } from './economy-runtime.ts';
import type { GpuTiberium } from './tiberium-gpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { HBASE,HWORDS,HMODE,HCLIENT,HSTAGE } from './harvest-cpu.ts';

/** BDATA.CPP One_Time and BUILDING.CPP Draw_It. Values are ticks per animation frame. */
const IDLE:Record<string,[number,number]>={NUKE:[4,15],NUK2:[4,15],AFLD:[16,3],PYLE:[10,3],FACT:[4,3],EYE:[16,4],HQ:[16,4],HOSP:[4,3],PROC:[6,4]};
export class BuildingView {
  private readonly attributes:StorageBufferAttribute[]=[];
  private readonly passes:ComputeNode[]=[];
  readonly bibs:StorageBufferAttribute;
  private mapVersion=-1;
  constructor(readonly economy:EconomyRuntime,ground:GpuGround,pipeline:PalettePipeline,ore:GpuTiberium){
    const {battle,scene:world}=economy,{scene}=world,{layout}=ground,{width,height}=battle.setup.grid,cells=width*height;
    const keep=(a:Int32Array)=>{const b=new StorageBufferAttribute(a,1);this.attributes.push(b);return b;};
    const rects:number[]=[],values:number[]=[];
    const frames=(name:string)=>{const list=scene.animation!.frames.get(name)??[],at=rects.length/4;for(const r of list)rects.push(r.x,r.y,r.width,r.height);return[at,list.length];};
    for(const [id,t] of MOVEMENT.entries()){
      const b=BUILDINGS.get(t.name),normal=frames(t.name),make=frames(`${t.name}MAKE`),idle=IDLE[t.name]??[1,1];
      values.push(...normal,...make,...idle,b?.damageOffset??0,Number(b?.simpleDamage),Number(b?.turret),t.strength,
        b?.width??1,b?.height??1,Number(combatTypes[id].turret));
    }
    const weap2=frames('WEAP2')[0],wrench=frames('SELECT')[0]+2,ti=Array.from({length:12},(_,i)=>frames(`TI${i+1}`)[0]);
    const wake=frames('WAKE')[0];
    const bibStarts=[frames('BIB1')[0],frames('BIB2')[0],frames('BIB3')[0]];
    const tiBase=values.length;values.push(...ti);
    const bibBase=values.length;values.push(...bibStarts);
    const facingBase=values.length;values.push(...Array.from({length:256},(_,d)=>BODY_SHAPE[facingTo32(d)]));
    const bindingsBase=values.length;values.push(...layout.bindings);
    const rectBase=values.length;values.push(...rects);
    const data=storage(keep(Int32Array.from(values)),'int',values.length).toReadOnly();
    const rectangle=(index:import('three/webgpu').Node<'int'>)=>{const at=index.mul(4).add(rectBase);return ivec4(data.element(at),data.element(at.add(1)),data.element(at.add(2)),data.element(at.add(3)));};
    const sprites=storage(pipeline.spriteBuffer,'vec4',pipeline.spriteBuffer.count);
    const units=storage(battle.units,'int',battle.units.count).toReadOnly(),combat=storage(battle.state,'int',battle.state.count).toReadOnly();
    const visual=storage(economy.visuals,'int',economy.visuals.count).toReadOnly();
    const order=storage(ground.order.order,'uint',ground.order.order.count).toReadOnly();
    const clock=storage(battle.movement.control,'int',2).toReadOnly();
    const mining=storage(economy.miningState,'int',economy.miningState.count).toReadOnly();
    this.bibs=keep(new Int32Array(cells*2).fill(-1));
    const bibs=storage(this.bibs,'int',cells*2).toReadOnly();
    const amount=storage(ore.amount,'int',cells).toReadOnly(),variants=storage(ore.variants,'int',cells).toReadOnly();
    this.passes.push(Fn(()=>{
      const cell=int(instanceIndex),oreIndex=cell.add(world.oreStart),bibIndex=cell.add(world.bibStart);
      sprites.element(oreIndex.mul(3)).assign(vec4(0));sprites.element(bibIndex.mul(3)).assign(vec4(0));
      If(amount.element(cell).greaterThanEqual(0),()=>{
        const region=rectangle(data.element(variants.element(cell).add(tiBase)).add(amount.element(cell)));
        sprites.element(oreIndex.mul(3)).assign(vec4(cell.mod(width).mul(24),cell.div(width).mul(24),region.z,region.w));
        sprites.element(oreIndex.mul(3).add(1)).assign(vec4(region.x,region.y,scene.plainRemap,0));
      });
      If(bibs.element(cell.mul(2)).greaterThanEqual(0),()=>{
        const region=rectangle(data.element(bibs.element(cell.mul(2)).add(bibBase)).add(bibs.element(cell.mul(2).add(1))));
        sprites.element(bibIndex.mul(3)).assign(vec4(cell.mod(width).mul(24),cell.div(width).mul(24),region.z,region.w));
        sprites.element(bibIndex.mul(3).add(1)).assign(vec4(region.x,region.y,scene.plainRemap,0));
      });
    })().compute(cells));
    this.passes.push(Fn(()=>{
      const index=int(instanceIndex);
      If(index.greaterThanEqual(layout.first),()=>{
        const relative=index.sub(layout.first),id=data.element(int(order.element(relative.div(layout.slots))).mul(5).add(bindingsBase));
        If(id.greaterThanEqual(0),()=>{
          const at=id.mul(U.WORDS),type=units.element(at.add(U.UTYPE)),row=type.mul(13),part=relative.mod(layout.slots);
          const atlas=sprites.element(index.mul(3).add(1)).toVar();
          If(units.element(at.add(U.UHEALTH)).greaterThan(0),()=>{
            const remaps=world.remaps??[{unit:0,building:0},{unit:1,building:1}];
            for(const [owner,remap] of remaps.entries())If(units.element(at.add(U.UOWNER)).equal(int(owner)),()=>{
              atlas.z.assign(select(units.element(at.add(U.UDOMAIN)).equal(int(2)),remap.building,remap.unit));
            });
            sprites.element(index.mul(3).add(1)).assign(atlas);
          });
          If(units.element(at.add(U.UDOMAIN)).equal(0).and(part.greaterThan(select(data.element(row.add(12)).notEqual(0),int(1),int(0)))),()=>{sprites.element(index.mul(3)).assign(vec4(0));});
          // Ported from UNIT.CPP Draw_It: the gunboat frame includes its turret and damage state.
          If(units.element(at.add(U.UHEALTH)).greaterThan(0).and(type.equal(movementType('BOAT')).or(type.equal(movementType('LST')))),()=>{
            const x=units.element(at).mul(24).add(128).div(256).toVar(),y=units.element(at.add(1)).mul(24).add(128).div(256).toVar();
            const shape=int(-1).toVar(),remap=atlas.z.toVar(),shadow=int(1).toVar();
            If(type.equal(movementType('LST')),()=>{If(part.equal(0),()=>{shape.assign(data.element(row));});}).Else(()=>{
              const east=units.element(at.add(U.UFACE)).greaterThanEqual(16).and(units.element(at.add(U.UFACE)).lessThan(112));
              If(part.equal(0),()=>{shape.assign(int(wake).add(select(east,int(0),int(6))).add(clock.element(0).div(2).mod(6)));x.addAssign(select(east,int(-1),int(3)));y.addAssign(3);remap.assign(scene.plainRemap);shadow.assign(0);});
              If(part.equal(1),()=>{
                const turret=data.element(combat.element(id.mul(C.CWORDS).add(C.CTURRET)).add(facingBase));
                shape.assign(data.element(row).add(turret).add(select(east,int(96),int(0))));
                If(units.element(at.add(U.UHEALTH)).mul(2).lessThan(data.element(row.add(9))),()=>{shape.addAssign(32);});
                If(units.element(at.add(U.UHEALTH)).mul(4).lessThan(data.element(row.add(9))),()=>{shape.addAssign(32);});
              });
            });
            sprites.element(index.mul(3)).assign(vec4(0));
            If(shape.greaterThanEqual(0),()=>{const region=rectangle(shape);sprites.element(index.mul(3)).assign(vec4(x.sub(region.z.div(2)),y.sub(region.w.div(2)),region.z,region.w));sprites.element(index.mul(3).add(1)).assign(vec4(region.x,region.y,remap,shadow));});
          });
          If(type.equal(movementType('HARV')).and(part.equal(0)).and(mining.element(id.mul(HWORDS).add(HBASE+HMODE)).equal(1)).and(units.element(at.add(U.UDEST)).lessThan(0)),()=>{
            const face=data.element(units.element(at.add(U.UFACE)).add(facingBase)),stage=mining.element(id.mul(HWORDS).add(HBASE+HSTAGE)).div(2).mod(6);
            const phase=select(stage.lessThan(4),stage,int(6).sub(stage));
            const region=rectangle(data.element(row).add(32).add(face.add(2).div(4).mul(4)).add(phase));
            const x=units.element(at).mul(24).add(128).div(256),y=units.element(at.add(1)).mul(24).add(128).div(256);
            sprites.element(index.mul(3)).assign(vec4(x.sub(region.z.div(2)),y.sub(region.w.div(2)),region.z,region.w));
            sprites.element(index.mul(3).add(1)).assign(vec4(region.x,region.y,atlas.z,1));
          });
          If(units.element(at.add(U.UDOMAIN)).equal(2).and(units.element(at.add(U.UHEALTH)).greaterThan(0)),()=>{
            const meta=id.mul(BUILDING_WORDS),mode=visual.element(meta),age=clock.element(0).sub(visual.element(meta.add(1)));
            const hp=units.element(at.add(U.UHEALTH)),damaged=hp.mul(2).lessThan(data.element(row.add(9)));
            const frame=clock.element(0).div(data.element(row.add(5))).mod(data.element(row.add(4))).toVar();
            const base=data.element(row).toVar();
            If(type.equal(movementType('PROC')),()=>{
              const client=mining.element(id.mul(HWORDS).add(HBASE+HCLIENT)).sub(1).toVar();
              If(client.greaterThanEqual(0),()=>{
                const h=client.mul(HWORDS).add(HBASE),phase=mining.element(h.add(HMODE)),age=mining.element(h.add(HSTAGE));
                If(phase.greaterThanEqual(3).and(phase.lessThanEqual(6)),()=>{
                  If(phase.equal(3),()=>{frame.assign(age.div(4).mod(6).add(6));})
                    .ElseIf(phase.equal(4),()=>{frame.assign(intMin(int(6),age.div(4)).add(12));})
                    .ElseIf(phase.equal(5),()=>{frame.assign(age.div(4).mod(5).add(19));})
                    .Else(()=>{frame.assign(intMin(int(5),age.div(4)).add(24));});
                });
              });
            });
            If(type.equal(movementType('FACT')).and(visual.element(meta.add(4)).bitAnd(4).notEqual(0)),()=>{frame.assign(clock.element(0).div(3).mod(20).add(4));});
            If(type.equal(movementType('TMPL')).and(visual.element(meta.add(4)).shiftRight(3).greaterThan(0)),()=>{frame.assign(visual.element(meta.add(4)).shiftRight(3).sub(1));});
            If(type.equal(movementType('HPAD')).and(units.element(at.add(U.UDOOR)).notEqual(0)),()=>{frame.assign(clock.element(0).div(4).mod(7));});
            If(type.equal(movementType('OBLI')),()=>{frame.assign(intMin(int(3),combat.element(id.mul(C.CWORDS).add(C.CCHARGE)).div(15)));});
            If(data.element(row.add(8)).notEqual(0),()=>{
              frame.assign(data.element(units.element(at.add(U.UFACE)).add(facingBase)));
              If(type.equal(movementType('SAM')),()=>{
                const state=combat.element(id.mul(C.CWORDS).add(C.CSAM)),age=combat.element(id.mul(C.CWORDS).add(C.CCHARGE));
                If(state.equal(0),()=>{frame.assign(0);}).ElseIf(state.equal(1),()=>{frame.assign(intMin(int(15),age.div(2)));})
                  .ElseIf(state.equal(7),()=>{frame.assign(intMin(int(63),age.div(2).add(48)));}).Else(()=>{frame.addAssign(16);});
              }).ElseIf(combat.element(id.mul(C.CWORDS).add(C.CLAST_FIRE)).equal(clock.element(0)),()=>{frame.addAssign(32);});
              If(damaged,()=>{frame.addAssign(64);});
            }).Else(()=>{
              If(type.equal(movementType('SILO')),()=>{frame.assign(visual.element(meta.add(2)));If(damaged,()=>{frame.addAssign(5);});})
              .ElseIf(damaged,()=>{If(data.element(row.add(7)).notEqual(0),()=>{frame.assign(data.element(row.add(1)).sub(2));}).Else(()=>{frame.addAssign(data.element(row.add(6)));});});
              If(hp.lessThanEqual(1),()=>{frame.assign(data.element(row.add(1)).sub(1));});
            });
            If(mode.notEqual(0).and(data.element(row.add(3)).greaterThan(0)),()=>{
              base.assign(data.element(row.add(2)));frame.assign(intMin(age.div(intMax(int(75).div(data.element(row.add(3))),int(1))),data.element(row.add(3)).sub(1)));
              If(mode.equal(2),()=>{frame.assign(data.element(row.add(3)).sub(1).sub(frame));});
            });
            If(type.equal(movementType('FIX')).and(units.element(at.add(U.UDOOR)).notEqual(0)),()=>{frame.assign(clock.element(0).div(2).mod(7));If(damaged,()=>{frame.addAssign(7);});});
            for(const name of Object.keys(WALLS))If(type.equal(movementType(name)),()=>{frame.assign(combat.element(id.mul(C.CWORDS).add(C.CWALL)).mul(16).add(visual.element(meta.add(2))));});
            If(part.equal(1).and(type.equal(movementType('WEAP'))).and(mode.equal(0)),()=>{base.assign(weap2);frame.assign(intMin(int(9),units.element(at.add(U.UDOOR))).add(select(damaged,int(10),int(0))));});
            const visible=hp.greaterThan(0).and(part.equal(0).or(part.equal(1).and(type.equal(movementType('WEAP'))).and(mode.equal(0))));
            If(visible,()=>{
              const region=rectangle(base.add(frame));
              const x=units.element(at).mul(24).add(128).div(256),y=units.element(at.add(1)).mul(24).add(128).div(256);
              sprites.element(index.mul(3)).assign(vec4(x.sub(region.z.div(2)),y.sub(region.w.div(2)),region.z,region.w));
              sprites.element(index.mul(3).add(1)).assign(vec4(region.x,region.y,atlas.z,1));
              sprites.element(index.mul(3).add(2)).assign(vec4(0));
            }).ElseIf(hp.greaterThan(0).or(part.notEqual(0)),()=>{sprites.element(index.mul(3)).assign(vec4(0));});
            If(part.equal(2).and(mode.equal(0)).and(visual.element(meta.add(4)).bitAnd(2).notEqual(0)),()=>{
              const region=rectangle(int(wrench)),x=units.element(at).mul(24).add(128).div(256),y=units.element(at.add(1)).mul(24).add(128).div(256);
              sprites.element(index.mul(3)).assign(vec4(x.sub(region.z.div(2)),y.sub(region.w.div(2)),region.z,region.w));
              sprites.element(index.mul(3).add(1)).assign(vec4(region.x,region.y,scene.plainRemap,0));
              sprites.element(index.mul(3).add(2)).assign(vec4(0));
            });
          });
          If(units.element(at.add(U.UATTACHED)).notEqual(0),()=>{sprites.element(index.mul(3)).assign(vec4(0));});
        });
      });
    })().compute(layout.count));
  }
  step(){
    // SMUDGE.CPP Disown: the foundation remains even if a building is born and removed
    // between two renders. Capture placement changes on every logic tick.
    const bibs=this.bibs.array as Int32Array;
    if(this.mapVersion!==this.economy.placementVersion)for(const b of this.economy.buildings.values()){
      const shape=BUILDINGS.get(b.type)!;if(!shape.bib)continue;
      for(let y=0;y<2;y++)for(let x=0;x<shape.width;x++){
        const at=(b.cell+(shape.height-1+y)*this.economy.placement.width+x)*2;
        if(bibs[at]!==4-shape.width||bibs[at+1]!==y*shape.width+x){bibs.set([4-shape.width,y*shape.width+x],at);this.bibs.addUpdateRange(at,2);this.bibs.needsUpdate=true;}
      }
    }
    this.mapVersion=this.economy.placementVersion;
  }
  update(){this.step();this.economy.battle.renderer.compute(this.passes);}
  dispose(){for(const pass of this.passes)pass.dispose();releaseStorage(this.economy.battle.renderer,this.attributes);}
}
