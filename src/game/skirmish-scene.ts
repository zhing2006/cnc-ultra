import { multiplayerStarts } from './multiplayer-starts.ts';
import type { MixSet } from './formats/mix.ts';
import { readScenario } from './formats/scenario.ts';
import { buildScene } from './scene.ts';
import { initialCellImages } from './map-visuals.ts';
import { BUILDINGS } from './data/buildings.ts';
import { PRODUCTION_TYPES } from './data/production.ts';
import { MOVEMENT, movementType } from './data/movement.ts';
import { animations, bullets } from './data/combat.ts';
import { movementMap } from './simulation/map.ts';
import { placementOffsets } from './simulation/building-rules.ts';
import { initialUnits, WORDS, UX, UY, type UnitPlacement } from './simulation/units-state.ts';
import { gridEdges } from '../engine/simulation/state.ts';
import type { CombatSetup } from './simulation/combat-state.ts';
import type { TiberiumSetup } from './simulation/tiberium-cpu.ts';
import type { EconomySetup, InitialBuilding } from './simulation/economy-setup.ts';

export interface SkirmishOptions { seed:number; players?:number; starts?:readonly number[]; credits:number; capacity?:number }
/** Runtime-decoded original map with MCV openings. The caller chooses participants and seed. */
export function skirmishScene(mix:MixSet,options:SkirmishOptions) {
  const capacity=options.capacity??512;
  const scenario=readScenario(new TextDecoder('latin1').decode(mix.require('SCM01EA.INI')),mix.require('SCM01EA.BIN'));
  scenario.units=[];scenario.infantry=[];scenario.buildings=[];scenario.aircraft=[];
  const map=movementMap(mix,scenario),{width,height}=map.grid,cells=width*height;
  const starts=options.starts??multiplayerStarts(scenario.waypoints,options.players??2,width,options.seed);
  const home=scenario.waypoints.get(starts[0])??scenario.waypoints.values().next().value!;
  scenario.waypoints.set(26,home);
  const images=initialCellImages(scenario);
  const clearScenario={...scenario,overlays:scenario.overlays.filter(overlay=>!/^TI\d+$/.test(overlay.type))};
  const basePassable=map.passable.slice(),baseLand=movementMap(mix,clearScenario).land;
  const playable=new Int32Array(cells),buildable=new Int32Array(cells);
  for(let y=scenario.y;y<scenario.y+scenario.height;y++)for(let x=scenario.x;x<scenario.x+scenario.width;x++){
    const cell=y*width+x;playable[cell]=1;buildable[cell]=Number(basePassable[cell]!==0&&(baseLand[cell]===0||baseLand[cell]===1||baseLand[cell]===5));
  }
  const tiberium:TiberiumSetup={width,height,seed:options.seed,amount:new Int32Array(cells).fill(-1),
    variants:new Int32Array(cells),clear:Int32Array.from(buildable,(value,cell)=>Number(!!value&&(baseLand[cell]===0||baseLand[cell]===5))),blossom:new Int32Array(cells),playable};
  for(const overlay of images.overlays)if(/^TI\d+$/.test(overlay.type)){tiberium.amount[overlay.cell]=overlay.frame;tiberium.variants[overlay.cell]=Number(overlay.type.slice(2))-1;}
  for(const tree of scenario.terrain)if(tree.type==='SPLIT2'||tree.type==='SPLIT3')tiberium.blossom[tree.cell+width]=1;
  scenario.overlays=scenario.overlays.filter(overlay=>!/^TI\d+$/.test(overlay.type));
  const seeds:UnitPlacement[]=Array.from({length:capacity},()=>({cell:0,type:movementType('MTNK'),health:0}));
  const buildings:InitialBuilding[]=[],used=new Uint8Array(cells);
  let next=0;
  const add=(name:string,cell:number,owner=0)=>{const id=next++;seeds[id]={cell,type:movementType(name),owner,facing:0};return id;};
  const find=(home:number,name?:string)=>{
    const candidates=Array.from(playable.keys()).filter(c=>buildable[c]&&tiberium.amount[c]<0).sort((a,b)=>{
      const score=(c:number)=>(c%width-home%width)**2+(Math.trunc(c/width)-Math.trunc(home/width))**2;
      return score(a)-score(b)||a-b;
    });
    const offsets=name?placementOffsets(name):[[0,0]];
    const cell=candidates.find(c=>offsets.every(([dx,dy])=>{
      const x=c%width+dx,y=Math.trunc(c/width)+dy,p=y*width+x;
      return x>=scenario.x&&x<scenario.x+scenario.width&&y>=scenario.y&&y<scenario.y+scenario.height&&buildable[p]&&tiberium.amount[p]<0&&!used[p];
    }));
    if(cell===undefined)throw new Error(`No room for starting ${name??'unit'}`);
    for(const [dx,dy] of offsets){const p=cell+dy*width+dx;used[p]=1;if(name)for(const d of [-width-1,-width,1-width,-1,1,width-1,width,width+1])if(p+d>=0&&p+d<cells)used[p+d]=1;}
    return cell;
  };
  const mcvs=starts.map((waypoint,owner)=>add('MCV',find(scenario.waypoints.get(waypoint)??home,'FACT')+width+1,owner));
  const mcv=mcvs[0];
  // Reserve an aircraft slot so its rendering and selection kernels exist before the first production.
  seeds[capacity-1]={cell:0,type:movementType('C17'),health:0,owner:1};
  const passable=basePassable.slice();
  for(const b of buildings)for(const [dx,dy] of BUILDINGS.get(b.type)!.occupy)passable[b.cell+dy*width+dx]=0;
  const setup:CombatSetup={grid:gridEdges(width,height,passable,true),bounds:{x:scenario.x,y:scenario.y,width:scenario.width,height:scenario.height},land:map.land.slice(),passable,units:seeds,seed:options.seed,dynamicTypes:true,multiplayer:true};
  const extra=new Set<string>([...MOVEMENT.map(t=>t.name),...bullets.filter(b=>!b.invisible).map(b=>b.name),...animations.map(a=>a.name),
    ...PRODUCTION_TYPES.filter(t=>t.category==='building').map(t=>`${t.name}MAKE`),'WEAP2','RROTOR','LROTOR','BIB1','BIB2','BIB3','SQUISH','SELECT']);
  for(let i=1;i<=12;i++)extra.add(`TI${i}`);
  for(let i=1;i<=6;i++){extra.add(`CR${i}`);extra.add(`SC${i}`);}
  const scene=buildScene(mix,scenario,'normal',true,[...extra]);
  const first=scene.objects[0]?.first??scene.sprites.length;
  const blank={x:0,y:0,region:{x:0,y:0,width:0,height:0},remap:scene.plainRemap,shadow:false};
  scene.sprites.splice(first,0,...Array.from({length:cells*3},()=>({...blank})));
  for(const object of scene.objects)object.first+=cells*3;
  const initial=initialUnits(setup),region=scene.animation!.frames.get('MTNK')![0];
  for(let id=0;id<capacity;id++){
    const first=scene.sprites.length;
    for(let part=0;part<4;part++)scene.sprites.push({...blank,region,remap:0,shadow:true});
    const type=MOVEMENT[seeds[id].type],b=BUILDINGS.get(type.name),offset=b?type.name==='FIX'?-384:type.name==='PYLE'||type.name==='PROC'?0:Math.trunc(b.height*256/3):type.infantry?48:128;
    scene.objects.push({key:`live:${id}`,first,count:4,sortX:initial[id*WORDS+UX]+(type.name==='FIX'?-384:0),sortY:initial[id*WORDS+UY]+offset});
  }
  const ordered=scene.objects.map((object,index)=>({object,index,sprites:scene.sprites.slice(object.first,object.first+object.count)}))
    .sort((a,b)=>a.object.sortY-b.object.sortY||a.object.sortX-b.object.sortX||a.index-b.index);
  scene.sprites.length=first+cells*3;scene.objects.length=0;
  for(const item of ordered){item.object.first=scene.sprites.length;scene.sprites.push(...item.sprites);scene.objects.push(item.object);}
  scene.home=buildings.length?Math.max(scenario.y,Math.min(...buildings.map(b=>Math.trunc(b.cell/width)))-2)*width+
    Math.max(scenario.x,Math.min(...buildings.map(b=>b.cell%width))-2):seeds[mcv].cell-width-1;
  return {scene,setup,passable,basePassable,baseLand,buildable,playable,tiberium,buildings,mcv,mcvs,
    houses:starts.length>1?[{faction:1,credits:options.credits},{faction:2,credits:options.credits}] as const:undefined,
    oreStart:first,bibStart:first+cells,decalStart:first+cells*2,credits:options.credits} satisfies EconomySetup & {mcv:number;mcvs:number[]};
}
