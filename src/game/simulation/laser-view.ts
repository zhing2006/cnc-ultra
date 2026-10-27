// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute,RenderTarget,RedFormat,RGBAFormat,UnsignedByteType,NearestFilter,DataTexture,MeshBasicNodeMaterial,QuadMesh,Vector2,type ComputeNode,type Node } from 'three/webgpu';
import { Fn,If,int,uint,float,ivec2,storage,uniform,screenCoordinate,textureLoad,vec4,abs,select,instanceIndex } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { intMin,intMax } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { GpuPrefixSum } from '../../engine/simulation/prefix-sum.ts';
import { movementType } from '../data/movement.ts';
import type { GpuCombat } from './combat-gpu.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';

/** BUILDING.CPP Fire_At: two dark red lines around the bright central beam. */
export class LaserView {
  readonly draw:(pixel:Node<'vec2'>,color:Node<'vec4'>)=>Node<'vec4'>;
  private readonly target=new RenderTarget(1,1,{format:RedFormat,type:UnsignedByteType,depthBuffer:false,minFilter:NearestFilter,magFilter:NearestFilter,generateMipmaps:false});
  private readonly origin=uniform(new Vector2());
  private readonly sampleStep=uniform(1,'int');
  private readonly lines:StorageBufferAttribute;
  private readonly collect:ComputeNode[];
  private readonly prefix:GpuPrefixSum;
  private readonly raw:StorageBufferAttribute;
  private readonly flags:StorageBufferAttribute;
  private readonly pass:QuadMesh;
  private readonly palette:DataTexture;
  private frame=-1;
  constructor(readonly battle:GpuCombat,palette:Uint8Array){
    const count=battle.setup.units.length;
    this.lines=new StorageBufferAttribute(new Int32Array(1+count*4),1);
    const output=storage(this.lines,'int',this.lines.count),u=storage(battle.units,'int',battle.units.count).toReadOnly(),c=storage(battle.state,'int',battle.state.count).toReadOnly(),p=storage(battle.projectiles,'int',battle.projectiles.count).toReadOnly(),clock=storage(battle.movement.control,'int',2).toReadOnly();
    this.raw=new StorageBufferAttribute(new Int32Array(count*4),1);this.flags=new StorageBufferAttribute(new Uint32Array(count),1);
    const raw=storage(this.raw,'int',this.raw.count),flags=storage(this.flags,'uint',count);
    const gather=Fn(()=>{
      const id=int(instanceIndex);flags.element(id).assign(uint(0));
        const state=id.mul(C.CWORDS);
        If(u.element(id.mul(U.WORDS).add(U.UTYPE)).equal(movementType('OBLI')).and(c.element(state.add(C.CLAST_FIRE)).equal(clock.element(0))),()=>{
          const slot=c.element(state.add(C.CCURSOR)).add(C.SHOTS_PER_UNIT-1).mod(C.SHOTS_PER_UNIT),shot=id.mul(C.SHOTS_PER_UNIT).add(slot).mul(C.BWORDS),dest=id.mul(4);
          for(const [i,field] of [C.BFIRE_X,C.BFIRE_Y,C.BTO_X,C.BTO_Y].entries())raw.element(dest.add(i)).assign(p.element(shot.add(field)).mul(24).add(128).div(256));
          flags.element(id).assign(uint(1));
        });
    })().compute(count);
    this.prefix=new GpuPrefixSum(battle.renderer,this.flags,count);
    const prefix=storage(this.prefix.output,'uint',this.prefix.output.count).toReadOnly();
    const pack=Fn(()=>{
      const id=int(instanceIndex);If(id.equal(0),()=>{output.element(0).assign(int(prefix.element(count)));});
      If(flags.element(id).notEqual(0),()=>{const offset=int(prefix.element(id)).toVar(),to=offset.mul(4).add(1);for(let i=0;i<4;i++)output.element(to.add(i)).assign(raw.element(id.mul(4).add(i)));});
    })().compute(count);
    this.collect=[gather,...this.prefix.kernels,pack];
    const input=storage(this.lines,'int',this.lines.count).toReadOnly(),material=new MeshBasicNodeMaterial();
    material.fragmentNode=Fn(()=>{
      const xy=ivec2(screenCoordinate.xy.mul(float(this.sampleStep))).add(ivec2(this.origin)),ink=int(0).toVar();
      Loop({start:0,end:input.element(0),type:'int'},({i})=>{
        const at=i.mul(4).add(1),x0=input.element(at),y0=input.element(at.add(1)),x1=input.element(at.add(2)),y1=input.element(at.add(3));
        for(const offset of [-1,1,0]){
          const start=x0.add(offset),dx=x1.sub(start),dy=y1.sub(y0),ax=abs(dx),ay=abs(dy);
          const hit=int(0).toVar();
          If(ax.greaterThanEqual(ay),()=>{
            const expected=y0.add(select(dy.lessThan(0),int(-1),int(1)).mul(abs(xy.x.sub(start)).mul(ay).add(ax.div(2)).div(intMax(int(1),ax))));
            hit.assign(int(xy.x.greaterThanEqual(intMin(start,x1)).and(xy.x.lessThanEqual(intMax(start,x1))).and(xy.y.equal(expected))));
          }).Else(()=>{
            const expected=start.add(select(dx.lessThan(0),int(-1),int(1)).mul(abs(xy.y.sub(y0)).mul(ax).add(ay.div(2)).div(intMax(int(1),ay))));
            hit.assign(int(xy.y.greaterThanEqual(intMin(y0,y1)).and(xy.y.lessThanEqual(intMax(y0,y1))).and(xy.x.equal(expected))));
          });
          If(hit.notEqual(0),()=>{ink.assign(offset?125:127);});
        }
      });return vec4(float(ink).div(255),0,0,1);
    })();this.pass=new QuadMesh(material);
    this.palette=new DataTexture(palette,256,1,RGBAFormat,UnsignedByteType);this.palette.minFilter=this.palette.magFilter=NearestFilter;this.palette.generateMipmaps=false;this.palette.needsUpdate=true;
    this.draw=(pixel,color)=>Fn(()=>{const ink=int(textureLoad(this.target.texture,ivec2(pixel.sub(this.origin)).div(this.sampleStep)).r.mul(255).round()),out=color.toVar();If(ink.notEqual(0),()=>{out.assign(textureLoad(this.palette,ivec2(ink,0)));});return out;})();
  }
  update(x:number,y:number,width:number,height:number,sampleStep=1){
    this.sampleStep.value=sampleStep;width=Math.ceil(width/sampleStep);height=Math.ceil(height/sampleStep);
    this.origin.value.set(x,y);if(this.target.width!==width||this.target.height!==height)this.target.setSize(width,height);
    const renderer=this.battle.renderer;if(this.frame!==this.battle.frame){renderer.compute(this.collect);this.frame=this.battle.frame;}
    const previous=renderer.getRenderTarget();renderer.setRenderTarget(this.target);this.pass.render(renderer);renderer.setRenderTarget(previous);
  }
  dispose(){for(const pass of this.collect)if(!this.prefix.kernels.includes(pass))pass.dispose();this.prefix.dispose();for(const material of [this.pass.material].flat())material.dispose();this.target.dispose();this.palette.dispose();releaseStorage(this.battle.renderer,[this.lines,this.raw,this.flags]);}
}
