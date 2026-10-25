// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { canPlaceBuilding,type PlacementGrid } from '../simulation/building-rules.ts';

/** Remaster UNIT.CPP Goto_Clear_Spot, including USE_RA_AI's randomized 36-entry scan. */
export function mcvDeployment(grid:PlacementGrid,cell:number,id:number,start:number):{kind:'deploy'|'move';cell:number}|undefined{
  if(canPlaceBuilding(grid,'FACT',cell-grid.width-1,0,id,false))return {kind:'deploy',cell};
  const w=grid.width,offsets=[-w,-2*w,-2*w+1,-2*w-1,-3*w,-3*w+1,-3*w-1,-3*w+2,-3*w-2,-4*w,-4*w+1,-4*w-1,-4*w+2,-4*w-2,
    w,2*w,2*w+1,2*w-1,3*w,3*w+1,3*w-1,3*w+2,3*w-2,4*w,4*w+1,4*w-1,4*w+2,4*w-2,-1,-2,-3,-4,1,2,3,4,0];
  for(let i=0,index=start;i<36;i++){
    const next=cell+offsets[index++];if(index>=36||offsets[index]===0)index=0;
    if(canPlaceBuilding(grid,'FACT',next,0,id,false))return {kind:'move',cell:next};
  }
}
