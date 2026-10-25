// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { DataTexture,NearestFilter,RedFormat,UnsignedByteType,RenderTarget,MeshBasicNodeMaterial,QuadMesh,
  StorageBufferAttribute,Vector2,Vector4,type ComputeNode,type Node } from 'three/webgpu';
import { Fn,If,int,uint,float,ivec2,storage,textureLoad,uniform,uniformArray,screenCoordinate,vec4,instanceIndex,atomicStore,atomicMin,mix,select } from 'three/tsl';
import { loop as Loop } from '../engine/simulation/loop.ts';
import { releaseStorage } from '../engine/simulation/resources.ts';
import type { EconomyRuntime } from './simulation/economy-runtime.ts';
import type { GpuTiberium } from './simulation/tiberium-gpu.ts';
import type { MixSet } from './formats/mix.ts';
import { decodeFont } from './formats/font.ts';
import { SightView } from './simulation/sight-view.ts';
import * as U from './simulation/units-state.ts';

/** LIB/FADING.ASM, Build_Fading_Table. Equal distances prefer the last index; exact matches stop. */
function brighten(palette:Uint8Array){
  const table=new Uint8Array(256);
  for(let i=1;i<256;i++){
    const ideal=[0,1,2].map(c=>{const v=palette[i*4+c]>>2,target=palette[15*4+c]>>2;return v-(((v-target)*24)>>8);});
    let best=0x7fffffff,index=15;
    for(let j=1;j<256;j++)if(j!==i){const d=ideal.reduce((sum,v,c)=>sum+((palette[j*4+c]>>2)-v)**2,0);if(d<=best){best=d;index=j;if(!d)break;}}
    table[i]=index;
  }return table;
}

/** RADAR.CPP Plot_Radar_Pixel/Render_Overlay/Render_Terrain/Render_Infantry and Zoom_Mode. */
export class Radar {
  readonly target=new RenderTarget(128,128,{format:RedFormat,type:UnsignedByteType,depthBuffer:false,minFilter:NearestFilter,magFilter:NearestFilter,generateMipmaps:false});
  readonly density:RenderTarget;
  readonly densityEnabled=uniform(0,'int');
  readonly densityDraw:(pixel:Node<'vec2'>,color:Node<'vec4'>)=>Node<'vec4'>;
  readonly origin=uniform(new Vector2());
  readonly size=uniform(new Vector2());
  readonly cellOrigin=uniform(new Vector2());
  readonly factor=uniform(2,'int');
  private readonly cellStep=uniform(1,'int');
  private mapVersion=-1;
  private airFrame=-1;
  private readonly groundCells:StorageBufferAttribute;
  private readonly inset=uniform(new Vector2());
  private readonly cellSize=uniform(new Vector2());
  private zoomed=false;
  private readonly textures:DataTexture[]=[];
  private readonly owners:StorageBufferAttribute;
  private readonly aircraft:StorageBufferAttribute;
  private readonly kernels:ComputeNode[];
  private readonly mapPass:QuadMesh;
  private readonly densityPass:QuadMesh;
  private readonly sightView:SightView;
  private readonly ownsSightView:boolean;
  constructor(readonly economy:EconomyRuntime,ore:GpuTiberium,data:MixSet,perspective?:SightView){
    this.sightView=perspective??new SightView(economy.battle.sight);
    this.ownsSightView=!perspective;
    const {battle,scene:world}=economy,{scene}=world,tiles=scene.setup.tiles,atlas=scene.setup.spriteAtlas,{width,height}=battle.setup.grid,cells=width*height;
    this.density=new RenderTarget(width,height,{format:RedFormat,type:UnsignedByteType,depthBuffer:false,minFilter:NearestFilter,magFilter:NearestFilter,generateMipmaps:false});
    const texture=(pixels:Uint8Array,width:number,height:number)=>{const t=new DataTexture(pixels,width,height,RedFormat,UnsignedByteType);t.minFilter=t.magFilter=NearestFilter;t.generateMipmaps=false;t.needsUpdate=true;this.textures.push(t);return t;};
    const terrainWidth=width*3,terrainHeight=height*3,terrainPixels=new Uint8Array(terrainWidth*terrainHeight),bright=brighten(scene.setup.palette);
    this.groundCells=new StorageBufferAttribute(tiles.cells.slice(),1);
    const groundCells=storage(this.groundCells,'uint',cells).toReadOnly();
    for(const object of scene.objects)if(object.key.startsWith('terrain:'))for(const sprite of scene.sprites.slice(object.first,object.first+object.count)){
      for(let y=Math.ceil(sprite.y/8);y<(sprite.y+sprite.region.height)/8;y++)for(let x=Math.ceil(sprite.x/8);x<(sprite.x+sprite.region.width)/8;x++){
        if(x<0||x>=terrainWidth||y<0||y>=terrainHeight)continue;
        const ink=atlas.pixels[(sprite.region.y+y*8-sprite.y)*atlas.width+sprite.region.x+x*8-sprite.x];if(ink)terrainPixels[y*terrainWidth+x]=bright[ink];
      }
    }
    const ground=texture(tiles.atlas.pixels,tiles.atlas.width,tiles.atlas.height),terrain=texture(terrainPixels,terrainWidth,terrainHeight),sprites=texture(atlas.pixels,atlas.width,atlas.height),green=texture(data.require('TGREEN.MRF'),256,1);
    const regions=uniformArray<'ivec4'>(Array.from({length:12},(_,i)=>scene.animation!.frames.get(`TI${i+1}`)!).flat().map(r=>new Vector4(r.x,r.y,r.width,r.height)),'ivec4');
    this.owners=new StorageBufferAttribute(new Int32Array(cells).fill(-1),1);this.aircraft=new StorageBufferAttribute(new Uint32Array(cells).fill(0xffffffff),1);
    const owner=storage(this.owners,'int',cells).toReadOnly(),air=storage(this.aircraft,'uint',cells).toAtomic();
    const u=storage(battle.units,'int',battle.units.count).toReadOnly(),mapped={element:this.sightView.mappedAt};
    const amount=storage(ore.amount,'int',cells).toReadOnly(),variant=storage(ore.variants,'int',cells).toReadOnly(),occupancy=storage(battle.movement.occupancy,'uint',cells*5).toReadOnly();
    this.kernels=[Fn(()=>{atomicStore(air.element(instanceIndex),uint(0xffffffff));})().compute(cells),Fn(()=>{
      const id=int(instanceIndex),at=id.mul(U.WORDS);
      If(u.element(at.add(U.UDOMAIN)).equal(1).and(u.element(at.add(U.UHEALTH)).greaterThan(0)).and(u.element(at.add(U.UATTACHED)).equal(0)),()=>{atomicMin(air.element(u.element(at.add(U.UCELL))),uint(id));});
    })().compute(battle.setup.units.length)];
    const airRead=storage(this.aircraft,'uint',cells).toReadOnly();
    const material=new MeshBasicNodeMaterial();
    material.fragmentNode=Fn(()=>{
      const pixel=ivec2(screenCoordinate.xy).sub(ivec2(this.inset)),cellxy=pixel.div(this.factor).mul(this.cellStep).add(ivec2(this.cellOrigin));
      const cell=cellxy.y.mul(width).add(cellxy.x),sub=pixel.mod(this.factor),ink=int(0).toVar();
      If(pixel.x.greaterThanEqual(0).and(pixel.y.greaterThanEqual(0)).and(pixel.x.lessThan(int(this.cellSize.x).mul(this.factor))).and(pixel.y.lessThan(int(this.cellSize.y).mul(this.factor))),()=>{
        If(mapped.element(cell).notEqual(0),()=>{
          const tile=int(groundCells.element(cell));
          If(tile.notEqual(-1),()=>{const origin=ivec2(tile.mod(tiles.atlas.width/24),tile.div(tiles.atlas.width/24)).mul(24);ink.assign(int(textureLoad(ground,origin.add(sub.mul(24).div(this.factor))).r.mul(255).round()));});
          If(amount.element(cell).greaterThanEqual(0),()=>{
            const region=regions.element(variant.element(cell).mul(12).add(amount.element(cell)));
            const sample=sub.mul(3).div(this.factor).mul(8);
            const value=int(textureLoad(sprites,region.xy.add(sample)).r.mul(255).round());
            If(value.notEqual(0),()=>{ink.assign(int(textureLoad(green,ivec2(value,0)).r.mul(255).round()));});
          });
          const tree=int(textureLoad(terrain,cellxy.mul(3).add(sub.mul(3).div(this.factor))).r.mul(255).round());If(tree.notEqual(0),()=>{ink.assign(tree);});
          If(owner.element(cell).greaterThanEqual(0),()=>{ink.assign(select(u.element(owner.element(cell).mul(U.WORDS).add(U.UOWNER)).equal(0),int(180),int(123)));});
          Loop(5,({i})=>{
            const id=int(occupancy.element(cell.mul(5).add(i))).sub(1),at=id.mul(U.WORDS);
            If(id.greaterThanEqual(0),()=>{
              If(u.element(at.add(U.UDOMAIN)).notEqual(2).and(u.element(at.add(U.UCLOAK)).notEqual(2).or(this.sightView.perspective.equal(-1)).or(u.element(at.add(U.UOWNER)).equal(this.sightView.perspective))),()=>{
                const infantry=u.element(at.add(U.UKIND)).notEqual(0),sx=u.element(at).mod(256).div(86),sy=u.element(at.add(1)).mod(256).div(86);
                const tiny=this.factor.lessThan(3).and(sub.x.equal(0)).and(sub.y.equal(0));
                const detailed=this.factor.greaterThanEqual(3).and(sub.x.equal(sx.mul(this.factor.div(3)))).and(sub.y.equal(sy.mul(this.factor.div(3))));
                If(infantry.not().or(tiny).or(detailed),()=>{ink.assign(select(u.element(at.add(U.UOWNER)).equal(0),int(176),int(127)));});
              });
            });
          });
          const plane=airRead.element(cell);If(plane.notEqual(uint(0xffffffff)),()=>{ink.assign(select(u.element(int(plane).mul(U.WORDS).add(U.UOWNER)).equal(0),int(176),int(127)));});
        });
        const left=int(this.origin.x).div(24),top=int(this.origin.y).div(24),right=int(this.origin.x.add(this.size.x)).div(24),bottom=int(this.origin.y.add(this.size.y)).div(24);
        If(cellxy.x.greaterThanEqual(left).and(cellxy.x.lessThanEqual(right)).and(cellxy.y.greaterThanEqual(top)).and(cellxy.y.lessThanEqual(bottom))
          .and(cellxy.x.equal(left).or(cellxy.x.equal(right)).or(cellxy.y.equal(top)).or(cellxy.y.equal(bottom))),()=>{ink.assign(15);});
      });
      return vec4(float(ink).div(255),0,0,1);
    })();this.mapPass=new QuadMesh(material);
    const densityMaterial=new MeshBasicNodeMaterial();densityMaterial.fragmentNode=Fn(()=>{
      const p=ivec2(screenCoordinate.xy),value=amount.element(p.y.mul(width).add(p.x)).add(1);return vec4(float(value).div(255),0,0,1);
    })();this.densityPass=new QuadMesh(densityMaterial);
    const font=decodeFont(data.require('6POINT.FNT')),labels=new Uint8Array(144*12);
    for(let n=0;n<12;n++){
      const text=String(n),width=[...text].reduce((sum,ch)=>sum+font.glyphs[ch.charCodeAt(0)].width+1,0)-1;let x=n*12+Math.trunc((12-width)/2);
      for(const ch of text){const glyph=font.glyphs[ch.charCodeAt(0)];for(let y=0;y<Math.min(12,glyph.height);y++)for(let xx=0;xx<glyph.width;xx++)if(glyph.pixels[y*glyph.width+xx])labels[y*144+x+xx]=255;x+=glyph.width+1;}
    }
    const digits=texture(labels,144,12);
    this.densityDraw=(pixel,color)=>Fn(()=>{
      const out=color.toVar(),p=ivec2(pixel),cell=p.div(24);
      If(this.densityEnabled.notEqual(0).and(p.x.greaterThanEqual(0)).and(p.y.greaterThanEqual(0)).and(p.x.lessThan(width*24)).and(p.y.lessThan(height*24)),()=>{
        const value=int(textureLoad(this.density.texture,cell).r.mul(255).round());
        If(value.greaterThan(0),()=>{
          out.assign(mix(out,vec4(0.1,float(value).div(12),0.15,1),0.35));
          const local=p.mod(24).sub(ivec2(6,7));
          If(local.x.greaterThanEqual(0).and(local.x.lessThan(12)).and(local.y.greaterThanEqual(0)).and(local.y.lessThan(12)),()=>{
            If(textureLoad(digits,ivec2(value.sub(1).mul(12).add(local.x),local.y)).r.greaterThan(0),()=>{out.assign(vec4(1));});
          });
        });
      });return out;
    })();
  }
  toggle(){this.zoomed=!this.zoomed;}
  cellAt(x:number,y:number){
    x-=this.inset.value.x;y-=this.inset.value.y;
    if(x<0||y<0||x>=this.cellSize.value.x*this.factor.value||y>=this.cellSize.value.y*this.factor.value)return undefined;
    return (Math.trunc(y/this.factor.value)*this.cellStep.value+this.cellOrigin.value.y)*this.economy.placement.width+Math.trunc(x/this.factor.value)*this.cellStep.value+this.cellOrigin.value.x;
  }
  update(x:number,y:number,width:number,height:number){
    this.sightView.update(this.economy.battle.frame);
    this.origin.value.set(x,y);this.size.value.set(width,height);
    const grid=this.economy.battle.setup.grid,map=this.economy.battle.setup.bounds??{x:0,y:0,width:grid.width,height:grid.height};
    const step=this.zoomed?1:Math.max(1,Math.ceil(Math.max(map.width,map.height)/128)),factor=this.zoomed?6:Math.max(1,Math.min(Math.trunc(128/map.width),Math.trunc(128/map.height)));
    const w=this.zoomed?Math.min(map.width,21):map.width,h=this.zoomed?Math.min(map.height,21):map.height;
    const left=this.zoomed?Math.max(map.x,Math.min(map.x+map.width-w,Math.trunc((x+width/2)/24)-Math.trunc(w/2))):map.x;
    const top=this.zoomed?Math.max(map.y,Math.min(map.y+map.height-h,Math.trunc((y+height/2)/24)-Math.trunc(h/2))):map.y;
    this.factor.value=factor;this.cellStep.value=step;this.cellSize.value.set(Math.ceil(w/step),Math.ceil(h/step));this.cellOrigin.value.set(left,top);this.inset.value.set(Math.trunc((128-Math.ceil(w/step)*factor)/2),Math.trunc((128-Math.ceil(h/step)*factor)/2));
    if(this.mapVersion!==this.economy.placementVersion){(this.owners.array as Int32Array).set(this.economy.placement.occupied as Int32Array);this.owners.needsUpdate=true;this.mapVersion=this.economy.placementVersion;}
    const renderer=this.economy.battle.renderer,previous=renderer.getRenderTarget();if(this.airFrame!==this.economy.battle.frame){renderer.compute(this.kernels);this.airFrame=this.economy.battle.frame;}
    renderer.setRenderTarget(this.target);this.mapPass.render(renderer);renderer.setRenderTarget(this.density);this.densityPass.render(renderer);renderer.setRenderTarget(previous);
  }
  dispose(){if(this.ownsSightView)this.sightView.dispose();this.target.dispose();this.density.dispose();for(const material of [this.mapPass.material,this.densityPass.material].flat())material.dispose();for(const t of this.textures)t.dispose();for(const k of this.kernels)k.dispose();releaseStorage(this.economy.battle.renderer,[this.owners,this.aircraft,this.groundCells]);}
}
