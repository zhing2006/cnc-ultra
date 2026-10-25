// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { BUILDINGS } from '../data/buildings.ts';
import { PRODUCTION, type ProductionType } from '../data/production.ts';
import { rawCost } from './economy.ts';

export interface PlacementGrid {
  width: number;
  height: number;
  playable: ArrayLike<number>;
  buildable: ArrayLike<number>;
  /** Object ID, or -1 for an empty cell. Includes the five infantry spots. */
  occupied: ArrayLike<number>;
  /** Owner + 1 for a building, wall or owned bib; zero for unowned ground. */
  owners: ArrayLike<number>;
  /** Owned bibs cannot be built over even where they do not block movement. */
  bibs: ArrayLike<number>;
}

/** BDATA.CPP, Occupy_List(true) and Bib_And_Offset. Includes the complete two-row bib. */
export function placementOffsets(name:string):readonly (readonly [number,number])[] {
  const type=BUILDINGS.get(name)!;
  const offsets=[...type.occupy];
  if(type.bib)for(let y=type.height-1;y<=type.height;y++)for(let x=0;x<type.width;x++){
    if(!offsets.some(p=>p[0]===x&&p[1]===y))offsets.push([x,y]);
  }
  return offsets;
}

/** BDATA.CPP Legal_Placement, CELL.CPP Is_Generally_Clear, DISPLAY.CPP Passes_Proximity_Check. */
export function canPlaceBuilding(grid:PlacementGrid,name:string,origin:number,owner:number,ignore=-1,proximity=true) {
  const ox=origin%grid.width,oy=Math.trunc(origin/grid.width),cells:number[]=[];
  if(origin<0)return false;
  for(const [dx,dy] of placementOffsets(name)){
    const x=ox+dx,y=oy+dy,cell=y*grid.width+x;
    if(x<0||x>=grid.width||y<0||y>=grid.height||!grid.playable[cell]||!grid.buildable[cell]||grid.bibs[cell])return false;
    if(grid.occupied[cell]>=0&&grid.occupied[cell]!==ignore)return false;
    cells.push(cell);
  }
  if(!proximity)return true;
  for(const cell of cells)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    if(!dx&&!dy)continue;
    const x=cell%grid.width+dx,y=Math.trunc(cell/grid.width)+dy;
    if(x>=0&&x<grid.width&&y>=0&&y<grid.height&&grid.owners[y*grid.width+x]===owner+1)return true;
  }
  return false;
}

/** BUILDING.CPP Power_Output, using LastStrength and the original two fixed-point conversions. */
export function buildingPower(type:ProductionType,health:number) {
  return (((type.power??0)*Math.trunc(health*256/type.strength))+128)>>8;
}

/** TECHNO.CPP Refund_Amount: half raw cost for a human, full raw cost for the computer. */
export function saleRefund(type:ProductionType,human=true) { return Math.trunc(rawCost(type)/(human?2:1)); }

/** UNIT.CPP Try_To_Deploy: northwest origin and the MCV's health ratio carried into the yard. */
export function deployYard(grid:PlacementGrid,cell:number,health:number,unit:number,owner:number) {
  const origin=cell-grid.width-1;
  if(!canPlaceBuilding(grid,'FACT',origin,owner,unit,false))return undefined;
  const ratio=Math.trunc(health*256/PRODUCTION.get('MCV')!.strength);
  return {cell:origin,health:(PRODUCTION.get('FACT')!.strength*ratio+128)>>8,facing:160};
}

/** BDATA.CPP One_Time: construction animation lasts whole frames at a quantized rate. */
export function constructionAnimation(frameCount:number) {
  const rate=Math.trunc(75/frameCount);
  return {rate,ticks:frameCount*rate};
}
