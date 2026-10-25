import { createRenderer } from '../src/engine/renderer.ts';
import { CampaignAssets } from '../src/game/campaign/assets.ts';
import { readCampaignScenario } from '../src/game/campaign/scenario.ts';
import { campaignScene } from '../src/game/campaign/scene.ts';
import { CampaignRuntime } from '../src/game/campaign/runtime.ts';
import { movementMap } from '../src/game/simulation/map.ts';
import { startPreparedGame, type Game } from '../src/game/game.ts';
import { MOVE } from '../src/game/simulation/combat-state.ts';
import * as U from '../src/game/simulation/units-state.ts';

/** GDI 12's original crate and evacuation trigger, with the battle already cleared. */
export async function campaignRescue(){
  const canvas=document.createElement('canvas');canvas.style.cssText='width:640px;height:400px';document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>{throw new Error(message);}});
  if(!renderer)throw new Error('WebGPU is required');
  let game:Game|undefined;
  try{
    const assets=await CampaignAssets.open(),archives=['gdi/general.mix','general.mix'];
    const [ini,bin,files]=await Promise.all([assets.bytes('SCG12EA.INI',archives),assets.bytes('SCG12EA.BIN',archives),assets.mission('gdi','TEMPERATE')]);
    const mission=readCampaignScenario(new TextDecoder().decode(ini),bin);
    const moebius=mission.scenario.infantry.find(actor=>actor.type==='MOEBIUS')!;
    mission.scenario.infantry=[];mission.scenario.units=[];mission.scenario.buildings=[];mission.objectTriggers=[];mission.base=[];mission.teams=[];
    mission.triggers=mission.triggers.filter(trigger=>trigger.event==='Civ. Evac.');mission.cellTriggers.clear();
    const crate=mission.scenario.overlays.find(overlay=>overlay.type==='WCRATE')!.cell;
    const map=movementMap(files,mission.scenario);
    const offset=[1,-1,64,-64].find(step=>[crate-step,crate,crate+step,crate+step*2].every(cell=>map.passable[cell]));
    if(offset===undefined)throw new Error('No approach to the original GDI 12 crate');
    mission.scenario.infantry=[{...moebius,cell:crate-offset,spot:0}];
    mission.scenario.units=[{type:'TRAN',house:'GoodGuy',cell:crate+offset*2,strength:256,facing:0,mission:'Guard'}];
    mission.objectTriggers=['NONE','NONE'];
    const world=campaignScene(files,mission,1995,32);
    let runtime!:CampaignRuntime,target=0,reached:(()=>void)|undefined,winner:number|undefined;
    const advance=async(frame:number)=>{target=frame;const done=new Promise<void>(resolve=>{reached=resolve;});game!.setPaused(false);await done;await runtime.saveState();};
    const start=async()=>{
      game=await startPreparedGame(renderer,canvas,files,{kind:'combat',scene:world.scene,setup:world.setup,economy:world,decalStart:world.decalStart},{
        createEconomy:battle=>runtime=new CampaignRuntime(battle,world,mission),
        onProgress:message=>{canvas.dataset.status=message;},
        onStats:frame=>{if(frame===target){game!.setPaused(true);reached?.();}},
        onOutcome:result=>{winner=result;reached?.();},
      });game.setPaused(true);game.setSimulationSpeed(100);
    };
    await start();await advance(5);
    const credits=runtime.houses[0].economy.credits;
    // Unit INI entries precede infantry: transport 0, Moebius 1.
    runtime.lifecycle.order(1,MOVE,-1,crate);await advance(120);
    if(runtime.houses[0].economy.credits!==credits+2000||!runtime.saveCampaign().collectedCrates.includes(crate))throw new Error('The campaign wood crate did not refund exactly 2000 credits');
    const saved=await game!.saveState(),rules=structuredClone(runtime.saveCampaign());
    game!.dispose();await start();game!.loadState(saved);runtime.loadCampaign(rules);
    runtime.lifecycle.order(1,MOVE,-1,crate-offset);await advance(200);runtime.lifecycle.order(1,MOVE,-1,crate);await advance(300);
    if(runtime.houses[0].economy.credits!==credits+2000)throw new Error('A collected crate reappeared after loading');
    const pending=runtime.battle.movement.pending;pending.array[2]=5;pending.array[3]=0;pending.addUpdateRange(2,2);pending.needsUpdate=true;
    await advance(1600);
    const units=new Int32Array(await renderer.three.getArrayBufferAsync(runtime.battle.units));
    if(winner!==0||units[U.UHEALTH]!==0||units[U.WORDS+U.UHEALTH]!==0)throw new Error(`The original evacuation did not finish: ${JSON.stringify({winner,frame:runtime.frame,transport:units[U.UCELL],passenger:units[U.WORDS+U.UCELL],attached:units[U.WORDS+U.UATTACHED]})}`);
    return {crateCredits:2000,winner};
  }finally{game?.dispose();renderer.dispose();canvas.remove();}
}
