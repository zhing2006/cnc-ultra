import { DataTexture,NearestFilter,RGBAFormat,RedFormat,UnsignedByteType,RenderTarget,MeshBasicNodeMaterial,QuadMesh,Vector2,type Node } from 'three/webgpu';
import { Fn,If,int,uint,float,ivec2,storage,textureLoad,uniform,screenCoordinate,vec4,mix } from 'three/tsl';
import { loop as Loop } from '../engine/simulation/loop.ts';
import { placementOffsets } from './simulation/building-rules.ts';
import type { EconomyRuntime } from './simulation/economy-runtime.ts';
import type { GpuTiberium } from './simulation/tiberium-gpu.ts';

/** The placement outline uses live occupancy and ore, without copying either map to the CPU. */
export class ConstructionPreview {
  readonly target:RenderTarget;
  readonly draw:(pixel:Node<'vec2'>,color:Node<'vec4'>)=>Node<'vec4'>;
  private readonly origin=uniform(new Vector2(-10,-10));
  private readonly mask=uniform(0,'uint');
  private readonly map:DataTexture;
  private readonly pass:QuadMesh;
  private mapVersion=-1;
  constructor(readonly economy:EconomyRuntime,ore:GpuTiberium){
    const {width,height}=economy.battle.setup.grid,cells=width*height;
    this.target=new RenderTarget(width,height,{format:RedFormat,type:UnsignedByteType,depthBuffer:false,minFilter:NearestFilter,magFilter:NearestFilter,generateMipmaps:false});
    this.map=new DataTexture(new Uint8Array(cells*4),width,height,RGBAFormat,UnsignedByteType);this.map.minFilter=this.map.magFilter=NearestFilter;this.map.generateMipmaps=false;
    const amount=storage(ore.amount,'int',cells).toReadOnly(),occupied=storage(economy.battle.movement.occupancy,'uint',cells*5).toReadOnly();
    const material=new MeshBasicNodeMaterial();
    material.fragmentNode=Fn(()=>{
      const p=ivec2(screenCoordinate.xy),offset=p.sub(ivec2(this.origin)),ink=int(0).toVar();
      If(offset.x.greaterThanEqual(0).and(offset.x.lessThan(4)).and(offset.y.greaterThanEqual(0)).and(offset.y.lessThan(4)),()=>{
        If(this.mask.bitAnd(uint(1).shiftLeft(uint(offset.y.mul(4).add(offset.x)))).notEqual(uint(0)),()=>{
          const valid=int(1).toVar(),adjacent=int(0).toVar();
          Loop(16,({i})=>{
            If(this.mask.bitAnd(uint(1).shiftLeft(uint(i))).notEqual(uint(0)),()=>{
              const cellxy=ivec2(this.origin).add(ivec2(i.mod(4),i.div(4))),cell=cellxy.y.mul(width).add(cellxy.x);
              If(cellxy.x.lessThan(0).or(cellxy.y.lessThan(0)).or(cellxy.x.greaterThanEqual(width)).or(cellxy.y.greaterThanEqual(height)),()=>{valid.assign(0);}).Else(()=>{
                const map=textureLoad(this.map,cellxy);
                If(map.r.equal(0).or(map.b.greaterThan(0)).or(amount.element(cell).greaterThanEqual(0)),()=>{valid.assign(0);});
                Loop(5,({i:spot})=>{If(occupied.element(cell.mul(5).add(spot)).notEqual(uint(0)),()=>{valid.assign(0);});});
                for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++)if(x||y){
                  const q=cellxy.add(ivec2(x,y));If(q.x.greaterThanEqual(0).and(q.y.greaterThanEqual(0)).and(q.x.lessThan(width)).and(q.y.lessThan(height)),()=>{If(textureLoad(this.map,q).g.greaterThan(0),()=>{adjacent.assign(1);});});
                }
              });
            });
          });
          ink.assign(2);If(valid.notEqual(0).and(adjacent.notEqual(0)),()=>{ink.assign(1);});
        });
      });return vec4(float(ink).div(255),0,0,1);
    })();this.pass=new QuadMesh(material);
    this.draw=(pixel,color)=>Fn(()=>{
      const p=ivec2(pixel),out=color.toVar();
      If(p.x.greaterThanEqual(0).and(p.y.greaterThanEqual(0)).and(p.x.lessThan(width*24)).and(p.y.lessThan(height*24)),()=>{
        const value=int(textureLoad(this.target.texture,p.div(24)).r.mul(255).round());
        If(value.notEqual(0),()=>{
          const ink=vec4(0.85,0.12,0.08,1).toVar();If(value.equal(1),()=>{ink.assign(vec4(0.2,0.9,0.2,1));});
          out.assign(mix(out,ink,0.45));
          If(p.mod(24).x.equal(0).or(p.mod(24).y.equal(0)),()=>{out.assign(ink);});
        });
      });return out;
    })();
  }
  update(x:number,y:number){
    const name=this.economy.placing;
    this.origin.value.set(Math.floor(x/24),Math.floor(y/24));this.mask.value=name?placementOffsets(name).reduce((mask,[x,y])=>mask|(1<<(y*4+x)),0):0;
    const map=this.map.image.data as Uint8Array,{placement}=this.economy;
    if(this.mapVersion!==this.economy.placementVersion){
      for(let cell=0;cell<placement.width*placement.height;cell++){map[cell*4]=placement.buildable[cell]&&placement.playable[cell]?255:0;map[cell*4+1]=placement.owners[cell]===1?255:0;map[cell*4+2]=placement.bibs[cell]?255:0;}
      this.mapVersion=this.economy.placementVersion;this.map.needsUpdate=true;
    }
    const renderer=this.economy.battle.renderer,previous=renderer.getRenderTarget();renderer.setRenderTarget(this.target);this.pass.render(renderer);renderer.setRenderTarget(previous);
  }
  dispose(){this.map.dispose();this.target.dispose();for(const material of [this.pass.material].flat())material.dispose();}
}
