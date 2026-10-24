import type { UnitsSetup, UnitCommand } from '../src/game/simulation/units-state.ts';

export interface UnitScenario {
  label: string;
  setup: UnitsSetup;
  targets: number[];
  ticks: number;
  interval?: number;
  settleAt?: number;
}
interface Rectangle { x:number; y:number; width:number; height:number }
interface PackedScenario extends UnitScenario { ids:number[] }
interface World { setup:UnitsSetup; cases:PackedScenario[]; commands:UnitCommand[]; free:Rectangle[] }

/** Independent rooms share a GPU program, with an impassable border between scenarios.
 * Standalone CPU rule tests retain the original fixtures and random seeds. These rooms
 * test CPU/GPU agreement and completion with one deterministic seed per combined world.
 */
export function packUnitScenarios(scenarios:readonly UnitScenario[]) {
  const width=64,worlds:World[]=[];
  for(const scenario of [...scenarios].sort((a,b)=>b.setup.grid.height-a.setup.grid.height || b.setup.grid.width-a.setup.grid.width)) {
    const w=scenario.setup.grid.width+2,h=scenario.setup.grid.height+2;
    let chosen: { world:World; rectangle:number; waste:number }|undefined;
    for(const world of worlds)world.free.forEach((rect,rectangle)=>{
      if(rect.width>=w&&rect.height>=h){
        const waste=rect.width*rect.height-w*h;
        if(!chosen||waste<chosen.waste)chosen={world,rectangle,waste};
      }
    });
    if(!chosen){
      const world:World={
        setup:{grid:{width,height:width,edges:new Uint32Array(width*width)},land:new Uint8Array(width*width),
          passable:new Uint8Array(width*width),seed:0x1995,units:[]},
        cases:[],commands:[],free:[{x:0,y:0,width,height:width}],
      };
      worlds.push(world);chosen={world,rectangle:0,waste:0};
    }
    const {world,rectangle}=chosen,rect=world.free.splice(rectangle,1)[0];
    if(w>rect.width||h>rect.height)throw new Error(`Scenario does not fit: ${scenario.label}`);
    if(rect.width>w)world.free.push({x:rect.x+w,y:rect.y,width:rect.width-w,height:h});
    if(rect.height>h)world.free.push({x:rect.x,y:rect.y+h,width:rect.width,height:rect.height-h});
    const remap=(cell:number)=>cell<0?cell:(rect.y+1+Math.floor(cell/scenario.setup.grid.width))*width+rect.x+1+cell%scenario.setup.grid.width;
    for(let cell=0;cell<scenario.setup.grid.edges.length;cell++){
      const target=remap(cell);
      world.setup.grid.edges[target]=scenario.setup.grid.edges[cell];
      world.setup.land[target]=scenario.setup.land[cell];
      world.setup.passable![target]=scenario.setup.passable?.[cell]??(scenario.setup.grid.edges[cell]?1:0);
    }
    const first=world.setup.units.length,ids=scenario.setup.units.map((_,id)=>first+id);
    world.setup.units=[...world.setup.units,...scenario.setup.units.map(unit=>({...unit,cell:remap(unit.cell)}))];
    world.cases.push({...scenario,ids});
    world.commands.push(...scenario.targets.map((target,id):UnitCommand=>({frame:1,kind:'move',target:remap(target),ids:[ids[id]]})));
  }
  return worlds;
}
