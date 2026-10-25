import { PalettePipeline } from '../src/engine/indexed/pipeline.ts';
import { GpuGround,groundLayout } from '../src/game/simulation/ground.ts';
import { CombatView,combatExtraSprites } from '../src/game/simulation/combat-view.ts';
import { AircraftView } from '../src/game/simulation/aircraft-view.ts';
import { BuildingView } from '../src/game/simulation/building-view.ts';
import { UnitsView } from '../src/game/simulation/units-view.ts';
import { GpuSelection } from '../src/game/simulation/selection.ts';
import { LaserView } from '../src/game/simulation/laser-view.ts';
import { Radar } from '../src/game/radar.ts';
import { Sidebar } from '../src/game/sidebar.ts';
import { ConstructionPreview } from '../src/game/construction-preview.ts';
import { buildingEffectCapacity } from '../src/game/simulation/building-effects-state.ts';
import { initialUnits,WORDS } from '../src/game/simulation/units-state.ts';
import type { EconomyRuntime } from '../src/game/simulation/economy-runtime.ts';
import type { GpuTiberium } from '../src/game/simulation/tiberium-gpu.ts';
import type { GpuAircraft } from '../src/game/simulation/aircraft-gpu.ts';
import type { GpuBuildingEffects } from '../src/game/simulation/building-effects-gpu.ts';
import type { MixSet } from '../src/game/formats/mix.ts';

/** Real drawing updates on the measured grid, without the final full-screen composition. */
export function economyDrawing(economy:EconomyRuntime,ore:GpuTiberium,air:GpuAircraft,effects:GpuBuildingEffects,files:MixSet){
  const {battle}=economy,{width,height}=battle.setup.grid,cells=width*height,count=battle.setup.units.length;
  const source=economy.scene.scene,blank={x:0,y:0,region:{x:0,y:0,width:0,height:0},remap:0,shadow:false};
  const scene={...source,setup:{...source.setup,tiles:{...source.setup.tiles,width,height,cells:new Uint32Array(cells)}},
    sprites:Array.from({length:cells*3},()=>({...blank})),objects:[] as typeof source.objects};
  const initial=initialUnits(battle.setup),region=source.animation!.frames.get('MTNK')![0];
  for(let id=0;id<count;id++){
    const first=scene.sprites.length;
    for(let part=0;part<4;part++)scene.sprites.push({...blank,region});
    scene.objects.push({key:`live:${id}`,first,count:4,sortX:initial[id*WORDS],sortY:initial[id*WORDS+1]+128});
  }
  economy.scene.scene=scene;economy.scene.oreStart=0;economy.scene.bibStart=cells;economy.scene.decalStart=cells*2;
  const layout=groundLayout(scene,initial,WORDS,true),renderer=battle.renderer,selection=new GpuSelection(renderer,battle.movement,battle.sight,true);
  const capacity=layout.count+combatExtraSprites(battle.setup,scene)+buildingEffectCapacity(count)+1;
  const pipeline=new PalettePipeline(renderer,{...scene.setup,spriteCapacity:capacity,dynamicSprites:{maxWidth:128,maxHeight:128}});
  const ground=new GpuGround(renderer,battle.movement,pipeline,layout,scene,{state:selection.state,offset:selection.flashOffset,clock:battle.movement.control});
  const combat=new CombatView(renderer,battle,ground,pipeline,scene,cells*2,true),aircraft=new AircraftView(air,ground,pipeline,scene);
  const buildings=new BuildingView(economy,ground,pipeline,ore),units=new UnitsView(renderer,battle.movement,battle.sight,selection,scene,files,true,
    {combat:battle.state,transport:economy.transportState,mining:economy.miningState,buildings:economy.visuals});
  const radar=new Radar(economy,ore,files),laser=new LaserView(battle,scene.setup.palette),preview=new ConstructionPreview(economy,ore);
  const sidebar=new Sidebar(economy,files,radar);
  effects.setView(pipeline,scene,combat.count);
  return {ground,selection,capacity,update(phase:(name:string)=>void=()=>{}){
    phase('combatHistory');combat.step();phase('groundSprites');ground.updateSprites(false);phase('combatDrawing');combat.update(false);phase('buildingDrawing');buildings.update();phase('aircraftDrawing');aircraft.update();phase('effectsDrawing');effects.update();
    phase('sidebar');sidebar.update();phase('spatialIndex');pipeline.updateGpuSprites(combat.count+buildingEffectCapacity(count));phase('unitOverlay');units.update();phase('radar');radar.update(0,0,1024,768);phase('laser');laser.update(0,0,1024,768);phase('constructionPreview');preview.update(-100,-100);
  },dispose(){sidebar.dispose();preview.dispose();laser.dispose();radar.dispose();units.dispose();buildings.dispose();aircraft.dispose();combat.dispose();ground.dispose();selection.dispose();pipeline.dispose();}};
}
