import { expect,it,vi } from 'vitest';
import { CampaignMusic } from './music.ts';
import type { CampaignAudio } from './audio.ts';
import type { CampaignAssets } from './assets.ts';

it('continues the playlist after restating a mission',async()=>{
  const play=vi.fn(async(_name:string)=>new EventTarget());
  const music=new CampaignMusic({play,stop(){}} as unknown as CampaignAudio,
    {source:async()=>({})} as unknown as CampaignAssets,error=>{throw error;});
  await music.start('AOI');await music.play('NOMERCY');music.stop();await music.start();
  expect(play.mock.calls.at(-1)?.[0]).toBe('OTP');
});
it('waits for the original fade before starting a manually queued track',async()=>{
  let finish!:()=>void;const faded=new Promise<void>(resolve=>{finish=resolve;});
  const play=vi.fn(async(_name:string)=>new EventTarget());
  const music=new CampaignMusic({play,stop(){},fadeMusic:()=>faded} as unknown as CampaignAudio,
    {source:async()=>({})} as unknown as CampaignAssets,error=>{throw error;});
  await music.start('AOI');const queued=music.queue('NOMERCY');
  expect(play.mock.calls.map(call=>call[0])).toEqual(['AOI']);finish();await queued;
  expect(play.mock.calls.map(call=>call[0])).toEqual(['AOI','NOMERCY']);
});
