import type { MixSet } from '../formats/mix.ts';
import { readScenario } from '../formats/scenario.ts';
import { buildScene } from '../scene.ts';
import { movementType } from '../data/movement.ts';
import { movementMap } from './map.ts';
import type { UnitPlacement, UnitsSetup } from './units-state.ts';

/** A controlled mixed army on the original terrain, with both tight and open routes nearby. */
export function unitsScene(mix:MixSet){
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
  for(const name of ['E1','E2','E3','E4','E5','E6','RMBO']){
    const cell=candidates.shift()!;
    for(let slot=0;slot<5;slot++){
      scenario.infantry.push({cell,spot:slot,type:name,house:'GoodGuy',strength:256,facing:128,mission:'Guard'});
      placements.push({cell,type:movementType(name),facing:128,slot});
    }
  }
  const scene=buildScene(mix,scenario,'normal',true);
  const setup:UnitsSetup={grid,land,passable,units:placements,seed:0x1995};
  return {scene,setup,passable};
}
