import { createRenderer } from '../src/engine/renderer.ts';
import { CampaignAssets } from '../src/game/campaign/assets.ts';
import { readCampaignScenario } from '../src/game/campaign/scenario.ts';
import { campaignScene } from '../src/game/campaign/scene.ts';
import { CampaignRuntime } from '../src/game/campaign/runtime.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { movementType } from '../src/game/data/movement.ts';

/** GDI 5's actual base and reserve teams rebuild a lost barracks and resume production. */
export async function campaignAI(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>{throw new Error(message);}});
  if(!renderer)throw new Error('WebGPU is required');
  const assets=await CampaignAssets.open(),archives=['gdi/general.mix','general.mix'];
  let battle:GpuCombat|undefined,runtime:CampaignRuntime|undefined;
  try{
    const [ini,bin,files]=await Promise.all([assets.bytes('SCG05EA.INI',archives),assets.bytes('SCG05EA.BIN',archives),assets.mission('gdi','TEMPERATE')]);
    const mission=readCampaignScenario(new TextDecoder().decode(ini),bin),node=mission.base.find(node=>node.type==='HAND')!;
    // The remaining original base has already lost its barracks and field army.
    mission.scenario.units=[];mission.scenario.infantry=[];
    mission.scenario.buildings=mission.scenario.buildings.filter(building=>building.house==='BadGuy'&&building.type!=='HAND');
    mission.teams=mission.teams.filter(team=>team.prebuilt);
    mission.triggers=mission.triggers.filter(trigger=>trigger.action==='Production'||trigger.action==='Create Team'&&mission.teams.some(team=>team.name===trigger.team));
    mission.objectTriggers=[];mission.cellTriggers.clear();
    const world=campaignScene(files,mission,1995,48);
    battle=new GpuCombat(renderer.three,world.setup);runtime=new CampaignRuntime(battle,world,mission);
    await battle.prepareForPlay();await runtime.prepareForPlay();
    let rebuilt=0,mustered=false,infantry=0;
    const initial=runtime.houses[1].economy.money;
    for(let tick=1;tick<=4500;tick++){
      if(!runtime.beginTick())throw new Error('Campaign production lost its completed report');
      battle.step();await runtime.endTick();
      if(!rebuilt&&[...runtime.buildings.values()].some(building=>building.type==='HAND'&&building.owner===1&&building.cell===node.cell&&building.active))rebuilt=tick;
      if(tick%30===0){
        const state=runtime.saveCampaign();mustered ||= state.teams.some(team=>team.moving&&team.ids.length===5);
        infantry=runtime.inventory[movementType('E1')+runtime.inventory.length/4]+runtime.inventory[movementType('E3')+runtime.inventory.length/4];
        if(rebuilt&&mustered&&infantry>=5)break;
      }
    }
    if(!rebuilt||!mustered||infantry<5)throw new Error(`The original base did not rebuild and form an attack team: ${JSON.stringify({rebuilt,mustered,infantry,money:runtime.houses[1].economy.money,state:runtime.saveCampaign()})}`);
    if(runtime.houses[1].economy.money>=initial)throw new Error('Computer production bypassed the house economy');
    const attacker=world.setup.units.length-1;
    const attackCell=world.passable.findIndex((open,cell)=>!!open&&!!world.playable[cell]);
    runtime.lifecycle.create(attacker,{type:movementType('MTNK'),cell:attackCell,owner:0});
    for(let tick=0;tick<3;tick++){runtime.beginTick();battle.step();await runtime.endTick();}
    runtime.onBaseAttacked?.(1,attacker);
    for(let tick=0;tick<3;tick++){runtime.beginTick();battle.step();await runtime.endTick();}
    const suspended=runtime.saveCampaign().teams.filter(team=>mission.teams.find(type=>type.name===team.name)!.priority<20);
    if(!suspended.length||suspended.some(team=>team.ids.length||(team.suspendedUntil??0)<=battle!.frame))throw new Error(`Base defense failed to suspend teams: ${JSON.stringify({frame:battle.frame,teams:suspended,attackCell})}`);
    return {rebuilt,mustered,infantry};
  }finally{runtime?.dispose();battle?.dispose();renderer.dispose();canvas.remove();}
}
