// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { BUILDINGS } from '../data/buildings.ts';
import { PRODUCTION } from '../data/production.ts';
import { combatTypes, weapons, bullets, warheads } from '../data/combat.ts';
import { movementType } from '../data/movement.ts';
import { desiredFacing256, distance, movePoint } from '../coord.ts';
import { canPlaceBuilding, type PlacementGrid } from '../simulation/building-rules.ts';

export interface BaseBuilding { type:string; cell:number }
export interface BasePlan { x:number;y:number;radius:number;defense:number[][] }
export type PlannerRandom=(stream:number,count:number)=>number;
/** Remaster HOUSE.CPP Round_Up, including its exact-integer branch and ushort argument. */
export function ratioLimit(count:number,ratio:number){const value=(count*ratio)&65535;return value&255?((value&65280)+256)>>>8:value;}
export function buildingCenter(building:BaseBuilding,width:number):[number,number]{
  const shape=BUILDINGS.get(building.type)!;
  return [building.cell%width*256+(shape.width===2?255:shape.width*128),Math.trunc(building.cell/width)*256+(shape.height===2?255:shape.height*128)];
}
/** Remaster TECHNO.CPP Anti_Air / Anti_Armor / Anti_Infantry. */
export function defenseValues(name:string):number[]{
  const type=combatTypes[movementType(name)],weapon=weapons[type.primary];if(!weapon)return [0,0,0];
  const bullet=bullets[weapon.bullet],head=warheads[bullet.warhead];
  if(bullet.antiAir)return [Math.trunc(Math.trunc(weapon.damage*head.armor[2]*weapon.range/weapon.rof)/50),0,0];
  const strength=(armor:number)=>Math.trunc(Math.trunc(Math.trunc(weapon.damage*head.armor[armor]*Math.min(weapon.range,1024)*head.spread/weapon.rof)/(bullet.inaccurate?2:1))/50);
  return [0,strength(3),strength(0)];
}
/** Remaster HOUSE.CPP Which_Zone; 0 core, then north/east/south/west. */
export function whichZone(plan:Pick<BasePlan,'x'|'y'|'radius'>,x:number,y:number){
  const d=distance(plan.x,plan.y,x,y);if(d<=plan.radius)return 0;if(d>plan.radius*4)return -1;
  const facing=desiredFacing256(plan.x,plan.y,x,y);return facing<32||facing>224?1:facing<96?2:facing<160?3:4;
}
/** Remaster HOUSE.CPP Recalc_Center; radius divides the unweighted distance sum by weighted count. */
export function planBase(buildings:readonly BaseBuilding[],width:number):BasePlan{
  const plan:BasePlan={x:0,y:0,radius:512,defense:Array.from({length:5},()=>[0,0,0])};let count=0;
  for(const b of buildings){const weight=Math.trunc(PRODUCTION.get(b.type)!.cost/1000)+1,[x,y]=buildingCenter(b,width);count+=weight;plan.x+=x*weight;plan.y+=y*weight;}
  if(!count)return plan;
  plan.x=Math.trunc(plan.x/count);plan.y=Math.trunc(plan.y/count);
  plan.radius=Math.max(512,Math.trunc(buildings.reduce((sum,b)=>sum+distance(plan.x,plan.y,...buildingCenter(b,width)),0)/count));
  for(const b of buildings){const zone=whichZone(plan,...buildingCenter(b,width));if(zone>=0){const values=defenseValues(b.type);values.forEach((v,i)=>{plan.defense[zone][i]+=v;});}}
  return plan;
}
/** Remaster HOUSE.CPP Random_Cell_In_Zone and COORD.CPP Coord_Scatter. */
export function randomCellInZone(plan:Pick<BasePlan,'x'|'y'|'radius'>,zone:number,grid:Pick<PlacementGrid,'width'|'height'|'playable'>,random:PlannerRandom,stream=420){
  let x=plan.x,y=plan.y;
  const bounds={left:grid.width,right:0,top:grid.height,bottom:0};
  for(let cell=0;cell<grid.playable.length;cell++)if(grid.playable[cell]){bounds.left=Math.min(bounds.left,cell%grid.width);bounds.right=Math.max(bounds.right,cell%grid.width+1);bounds.top=Math.min(bounds.top,Math.trunc(cell/grid.width));bounds.bottom=Math.max(bounds.bottom,Math.trunc(cell/grid.width)+1);}
  if(zone===0){[x,y]=movePoint(x,y,random(stream,256),random(stream+1,plan.radius+1));}
  else{
    const edge=[0,plan.y-bounds.top*256,bounds.right*256-plan.x,bounds.bottom*256-plan.y,plan.x-bounds.left*256][zone];
    const max=Math.min(plan.radius*3,edge-256);
    if(max<0)return randomCellInZone(plan,0,grid,random,stream+2);
    const min=Math.min(plan.radius*2,max),facing=(zone-1)*64-32+random(stream,65);
    [x,y]=movePoint(x,y,facing, min+random(stream+1,max-min+1));
  }
  let xx=Math.trunc(x/256),yy=Math.trunc(y/256);
  if(xx<0||xx>=grid.width||yy<0||yy>=grid.height||!grid.playable[yy*grid.width+xx]){
    if(zone!==0)return randomCellInZone(plan,0,grid,random,stream+2);
    xx=Math.trunc(plan.x/256);yy=Math.trunc(plan.y/256);
  }
  return Math.max(bounds.top,Math.min(bounds.bottom-1,yy))*grid.width+Math.max(bounds.left,Math.min(bounds.right-1,xx));
}
/** Remaster HOUSE.CPP Find_Build_Location / Find_Cell_In_Zone. */
export function findBuildLocation(grid:PlacementGrid,name:string,owner:number,buildings:readonly BaseBuilding[],random:PlannerRandom){
  if(!buildings.length)return -1;
  const plan=planBase(buildings,grid.width),values=defenseValues(name),average=[0,1,2].map(i=>Math.trunc(plan.defense.slice(1).reduce((sum,d)=>sum+d[i],0)/4));
  let zone=random(410,5),largest=0;
  for(let z=0;z<5;z++){
    const rating=average.reduce((sum,a,i)=>{const deficit=Math.trunc((a-plan.defense[z][i])/(z===0?2:1));return sum+Math.max(0,Math.min(values[i],deficit));},0);
    if(rating>largest){largest=rating;zone=z;}
  }
  const target=randomCellInZone(plan,zone,grid,random),tx=target%grid.width*256+128,ty=Math.trunc(target/grid.width)*256+128;
  let best=-1,bestDistance=0x7fffffff;
  // The original falls back through zones only when this same legal-cell set is empty.
  const left=Math.max(0,Math.floor((plan.x-plan.radius*4)/256)),right=Math.min(grid.width-1,Math.floor((plan.x+plan.radius*4)/256));
  const top=Math.max(0,Math.floor((plan.y-plan.radius*4)/256)),bottom=Math.min(grid.height-1,Math.floor((plan.y+plan.radius*4)/256));
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
    const cell=y*grid.width+x;if(whichZone(plan,x*256+128,y*256+128)<0||!canPlaceBuilding(grid,name,cell,owner))continue;
    const d=distance(tx,ty,x*256+128,y*256+128);if(d<bestDistance){bestDistance=d;best=cell;}
  }
  return best;
}
