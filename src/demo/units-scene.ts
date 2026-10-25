import type { MixSet } from '../game/formats/mix.ts';
import { readScenario } from '../game/formats/scenario.ts';
import { buildScene } from '../game/scene.ts';
import { movementType } from '../game/data/movement.ts';
import { movementMap } from '../game/simulation/map.ts';
import type { UnitPlacement, UnitsSetup } from '../game/simulation/units-state.ts';
import { animations,bullets } from '../game/data/combat.ts';

/** A controlled mixed army on the original terrain, with both tight and open routes nearby. */
export function unitsScene(mix:MixSet,includeAircraft=true,combat=false){
  const scenario=readScenario(new TextDecoder('latin1').decode(mix.require('SCG08EB.INI')),mix.require('SCG08EB.BIN'));
  scenario.units=[];scenario.infantry=[];
  const {grid,land,passable}=movementMap(mix,scenario),home=scenario.waypoints.get(26)!;
  const hx=home%grid.width,hy=Math.floor(home/grid.width);
  const candidates=Array.from(passable.keys()).filter(c=>passable[c]&&(c%grid.width+Math.floor(c/grid.width))%2===0)
    .sort((a,b)=>((a%grid.width-hx)**2+(Math.floor(a/grid.width)-hy)**2)-((b%grid.width-hx)**2+(Math.floor(b/grid.width)-hy)**2)||a-b);
  const placements:UnitPlacement[]=[];
  const vehicles=['MTNK','HTNK','LTNK','JEEP','BGGY','BIKE','FTNK','STNK','ARTY','MSAM','MLRS','APC','HARV','MCV'];
  for(const name of [...vehicles,...vehicles]){
    const cell=candidates.shift()!;
    scenario.units.push({cell,type:name,house:'GoodGuy',strength:256,facing:128,mission:'Guard'});
    placements.push({cell,type:movementType(name),facing:128});
  }
  if(combat)for(let i=0;i<2;i++){
    const index=candidates.findIndex(c=>c%grid.width>hx+10),cell=candidates.splice(index<0?candidates.length-1:index,1)[0];
    scenario.units.push({cell,type:'MTNK',house:'BadGuy',strength:256,facing:192,mission:'Guard'});
    placements.push({cell,type:movementType('MTNK'),facing:192,owner:1});
  }
  for(const name of ['E1','E2','E3','E4','E5','E6','RMBO']){
    const cell=candidates.shift()!;
    for(let slot=0;slot<5;slot++){
      scenario.infantry.push({cell,spot:slot,type:name,house:'GoodGuy',strength:256,facing:128,mission:'Guard'});
      placements.push({cell,type:movementType(name),facing:128,slot});
    }
  }
  scenario.aircraft=[];
  for(const name of includeAircraft?['ORCA','HELI','TRAN']:[]){
    const cell=candidates.shift()!;
    scenario.aircraft.push({cell,type:name,house:'GoodGuy',strength:256,facing:32,mission:'Guard'});
    placements.push({cell,type:movementType(name),facing:32});
  }
  const extra=combat?[...bullets.filter(b=>!b.invisible).map(b=>b.name),...animations.map(a=>a.name),...Array.from({length:6},(_,i)=>`CR${i+1}`),...Array.from({length:6},(_,i)=>`SC${i+1}`),'SQUISH']:[];
  const scene=buildScene(mix,scenario,'normal',true,['RROTOR','LROTOR',...extra]);
  const decalStart=scene.objects[0]?.first??scene.sprites.length;
  if(combat){
    scene.sprites.splice(decalStart,0,...Array.from({length:grid.edges.length},()=>({x:0,y:0,region:{x:0,y:0,width:0,height:0},remap:scene.plainRemap,shadow:false})));
    for(const object of scene.objects)object.first+=grid.edges.length;
  }
  const setup:UnitsSetup={grid,bounds:{x:scenario.x,y:scenario.y,width:scenario.width,height:scenario.height},land,passable,units:placements,seed:0x1995};
  return {scene,setup,passable,decalStart};
}
