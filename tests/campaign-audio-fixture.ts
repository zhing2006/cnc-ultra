import { CampaignAudio } from '../src/game/campaign/audio.ts';
import { CampaignAssets } from '../src/game/campaign/assets.ts';

export async function streamedCampaignMusic(){
  const assets=await CampaignAssets.open(),context=new AudioContext();await context.resume();
  const createBuffer=context.createBuffer.bind(context),allocations:number[]=[];
  context.createBuffer=(channels,length,rate)=>{allocations.push(length);if(length>4096)throw new Error(`Unbounded main-thread music buffer: ${length}`);return createBuffer(channels,length,rate);};
  const errors:unknown[]=[],audio=new CampaignAudio(context,assets,error=>errors.push(error));
  let frames=0,running=true;const render=()=>{frames++;if(running)requestAnimationFrame(render);};requestAnimationFrame(render);
  try{
    if(!await audio.play('NOMERCY',false,true))throw new Error('Gold music is missing');
    await new Promise(resolve=>setTimeout(resolve,300));
    await audio.play('AOI',false,true);
    await new Promise(resolve=>setTimeout(resolve,200));
    await audio.fadeMusic();
    if(errors.length)throw errors[0];
    if(frames<2||allocations.length<2)throw new Error('Streaming music did not leave the main thread responsive');
    return {maximumFrames:Math.max(...allocations),buffers:allocations.length};
  }finally{running=false;audio.dispose();await context.close();}
}
