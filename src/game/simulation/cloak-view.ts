import { Fn, If, int, instanceIndex, select, storage, vec4 } from 'three/tsl';
import type { PalettePipeline } from '../../engine/indexed/pipeline.ts';
import { movementType } from '../data/movement.ts';
import type { GpuCombat } from './combat-gpu.ts';
import type { GpuGround } from './ground.ts';
import type { SightView } from './sight-view.ts';
import * as U from './units-state.ts';

/** TECHNO.CPP Visual_Character/Techno_Draw_Object. Only sprite projection depends on the viewer. */
export class CloakView {
  private readonly pass;
  constructor(private readonly battle:GpuCombat,ground:GpuGround,pipeline:PalettePipeline,view:SightView){
    const u=storage(battle.units,'int',battle.units.count).toReadOnly(),meta=storage(ground.bindings,'int',ground.bindings.count).toReadOnly();
    const order=storage(ground.order.order,'uint',ground.order.order.count).toReadOnly(),sprites=storage(pipeline.spriteBuffer,'vec4',pipeline.spriteBuffer.count),layout=ground.layout;
    this.pass=Fn(()=>{
      const object=int(instanceIndex),id=meta.element(int(order.element(object)).mul(5));
      If(id.greaterThanEqual(0),()=>{
        const at=id.mul(U.WORDS);
        If(u.element(at.add(U.UTYPE)).equal(movementType('STNK')).and(u.element(at.add(U.UHEALTH)).greaterThan(0)),()=>{
          const base=object.mul(layout.slots).add(layout.first).mul(3),body=sprites.element(base).toVar(),info=sprites.element(base.add(1)).toVar(),effect=sprites.element(base.add(2)).toVar();
          const mode=u.element(at.add(U.UCLOAK)),stage=u.element(at.add(U.UCLOAK_STAGE)),progress=int(select(mode.equal(3),int(38).sub(stage),stage)).toVar(),fraction=progress.mul(256).div(38),visual=int(0).toVar();
          If(mode.equal(2),()=>{visual.assign(5);}).ElseIf(mode.notEqual(0).and(progress.greaterThan(0)),()=>{visual.assign(select(fraction.lessThan(64),int(1),select(fraction.lessThan(128),int(2),select(fraction.lessThan(192),int(3),select(fraction.lessThan(255),int(4),int(5))))));});
          If(view.perspective.equal(-1).or(view.perspective.equal(u.element(at.add(U.UOWNER)))).and(visual.greaterThan(3)),()=>{visual.assign(3);});
          for(let part=0;part<3;part++)sprites.element(base.add(part*3)).assign(vec4(0));
          const put=(part:number,kind:'body'|'filter'|'ripple')=>{
            sprites.element(base.add(part*3)).assign(body);sprites.element(base.add(part*3+1)).assign(kind==='body'?info:vec4(info.xyz,0));
            sprites.element(base.add(part*3+2)).assign(kind==='body'?effect:kind==='filter'?vec4(2,0,0,0):vec4(0,1,0,0));
          };
          If(visual.lessThanEqual(2),()=>{put(0,'body');});
          If(visual.equal(1),()=>{put(1,'ripple');});
          If(visual.equal(2),()=>{put(1,'filter');put(2,'ripple');});
          If(visual.equal(3),()=>{put(0,'filter');put(1,'ripple');});
          If(visual.equal(4),()=>{put(0,'ripple');});
        });
      });
    })().compute(ground.order.order.count);
  }
  update(){this.battle.renderer.compute(this.pass);}
  dispose(){this.pass.dispose();}
}
