// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { randomWord } from '../engine/simulation/fixed.ts';
import { distance } from './coord.ts';

/** INI.CPP Create_Units / Sort_Cells / Furthest_Cell, with the simulation's seeded random streams. */
export function multiplayerStarts(waypoints:ReadonlyMap<number,number>,players:number,width:number,seed:number){
  const remaining=[...waypoints].filter(([id,cell])=>id>=0&&id<26&&cell>=0).sort((a,b)=>a[0]-b[0]);
  const maxPlayers=4; // GLOBALS.CPP MPlayerMax: maximum slots, not participating houses.
  if(players<1||players>Math.min(maxPlayers,remaining.length))throw new Error('Not enough starting waypoints');
  const ordered=[remaining.splice(randomWord(seed,0,0,500)%remaining.length,1)[0]];
  while(remaining.length){
    let best=0,farthest=-1;
    for(let i=0;i<remaining.length;i++){
      const cell=remaining[i][1];
      const nearest=Math.min(...ordered.map(([,other])=>distance(cell%width,Math.trunc(cell/width),other%width,Math.trunc(other/width))));
      // The original >= comparison chooses the last equally distant waypoint.
      if(nearest>=farthest){farthest=nearest;best=i;}
    }
    ordered.push(remaining.splice(best,1)[0]);
  }
  // FUNCTION.H Distance(CELL,CELL) rounds the shorter axis down before ranking.
  // Create_Units chooses from MPlayerMax slots, even for a two-house match.
  const slots=ordered.slice(0,maxPlayers);
  return Array.from({length:players},(_,owner)=>slots.splice(randomWord(seed,0,owner,501)%slots.length,1)[0][0]);
}
