import { readFileSync } from 'node:fs';
import { randomWord } from '../engine/simulation/fixed.ts';
import { expect, it } from 'vitest';
import { DATA_FILES } from './data-files.ts';
import { MixFile, MixSet } from './formats/mix.ts';
import { multiplayerStarts } from './multiplayer-starts.ts';
import { skirmishScene } from './skirmish-scene.ts';
it('uses the four available slots even when only two houses participate',()=>{
  // GLOBALS.CPP MPlayerMax=4; Create_Units samples that slot set, not the house count.
  const waypoints=new Map([[0,21],[1,38],[2,361],[3,378],[26,210]]);
  let adjacent=false;
  for(let seed=0;seed<64;seed++){
    const result=multiplayerStarts(waypoints,2,20,seed),a=waypoints.get(result[0])!,b=waypoints.get(result[1])!;
    expect(result[0]).not.toBe(result[1]);expect(result.every(id=>id>=0&&id<4)).toBe(true);
    if(a%20===b%20||Math.trunc(a/20)===Math.trunc(b/20))adjacent=true;
  }
  expect(adjacent).toBe(true);
});
it('uses the cell-distance rounding when ranking equally distant waypoints',()=>{
  // FUNCTION.H Distance(CELL,CELL): (3,3) and (4,0) both measure four cells.
  // Furthest_Cell's >= tie picks the later (4,0) candidate after an origin start.
  const waypoints=new Map([[0,0],[1,3*20+3],[2,4]]);
  let seed=0;while(randomWord(seed,0,0,500)%3!==0)seed++;
  const order=[0,2,1],expected=Array.from({length:3},(_,owner)=>order.splice(randomWord(seed,0,owner,501)%order.length,1)[0]);
  expect(multiplayerStarts(waypoints,3,20,seed)).toEqual(expected);
});
const mix=new MixSet([...DATA_FILES,'tempicnh.mix','updatec.mix'].map(name=>new MixFile(readFileSync(new URL(`../../assets/dev/${name}`,import.meta.url)))));
it('selects repeatable multiplayer openings from the simulation seed',()=>{
  const opening=(seed:number)=>{
    const scene=skirmishScene(mix,{seed,credits:10000,capacity:8});
    return scene.mcvs.map(id=>scene.setup.units[id].cell);
  };
  const first=opening(1995);
  expect(first).toHaveLength(2);expect(new Set(first).size).toBe(2);
  expect(opening(1995)).toEqual(first);
  expect(new Set([first,...[1996,1997,1998].map(opening)].map(value=>JSON.stringify(value))).size).toBeGreaterThan(1);
});
