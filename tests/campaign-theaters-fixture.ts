import { createRenderer } from '../src/engine/renderer.ts';
import { CampaignAssets } from '../src/game/campaign/assets.ts';
import { readCampaignScenario } from '../src/game/campaign/scenario.ts';
import { campaignScene } from '../src/game/campaign/scene.ts';
import { CampaignRuntime } from '../src/game/campaign/runtime.ts';
import { startPreparedGame,type Game } from '../src/game/game.ts';

/** Exercise the actual radar and sidebar, which data-only scenario checks do not create. */
export async function campaignTheaters(){
  const canvas=document.createElement('canvas');canvas.style.cssText='width:640px;height:400px';document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>{throw new Error(message);}});
  if(!renderer)throw new Error('WebGPU is required');
  let game:Game|undefined;
  try{
    const assets=await CampaignAssets.open(),completed:string[]=[];
    for(const [side,name] of [['gdi','SCG08EA'],['nod','SCB13EA']] as const){
      const archives=[`${side}/general.mix`,'general.mix'];
      const [ini,bin]=await Promise.all([assets.bytes(`${name}.INI`,archives),assets.bytes(`${name}.BIN`,archives)]);
      const mission=readCampaignScenario(new TextDecoder().decode(ini),bin);mission.buildLevel=Number(name.slice(3,5));
      const files=await assets.mission(side,mission.scenario.theater),world=campaignScene(files,mission);
      let done!:()=>void;const reached=new Promise<void>(resolve=>{done=resolve;});
      game=await startPreparedGame(renderer,canvas,files,{kind:'combat',scene:world.scene,setup:world.setup,economy:world,decalStart:world.decalStart},{
        createEconomy:battle=>new CampaignRuntime(battle,world,mission),
        onStats:frame=>{if(frame===3){game!.setPaused(true);done();}},
      });
      await reached;completed.push(mission.scenario.theater.toUpperCase());game.dispose();game=undefined;
    }
    return completed;
  }finally{game?.dispose();renderer.dispose();canvas.remove();}
}
