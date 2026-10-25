// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute } from 'three/webgpu';
import { gridEdges } from '../../engine/simulation/state.ts';
import { randomWord } from '../../engine/simulation/fixed.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { PRODUCTION, PRODUCTION_TYPES, type ProductionCategory } from '../data/production.ts';
import { combatTypes,modifyDamage,bullets } from '../data/combat.ts';
import { WALLS } from '../data/overlays.ts';
import { HouseEconomy, ProductionQueues, repairStep,rawCost,unitSaleRefund, type FactoryBuilding } from './economy.ts';
import { buildingPower, canPlaceBuilding, constructionAnimation, deployYard, placementOffsets, saleRefund, type PlacementGrid } from './building-rules.ts';
import { GpuLifecycle, HEALTH, REMOVE, DESTINATION } from './lifecycle-gpu.ts';
import { EconomyReport,REPORT_HEADER,REPORT_RECORD } from './economy-report.ts';
import type { EconomyScene, InitialBuilding } from './economy-scene.ts';
import type { GpuCombat } from './combat-gpu.ts';
import { initialHarvest } from './harvest-cpu.ts';
import { initialTransport } from './transport-cpu.ts';
import { initialServices,FACTORY_POINT } from './services-cpu.ts';

export interface LiveBuilding extends InitialBuilding {
  health:number; active:boolean; started:number; duration:number; selling:boolean; repairing:boolean;
  dying?:number;
  opened:boolean;
  primary?:boolean;
  wrenchVisible?:boolean;
}
interface PendingSpawn {
  id:number; name:string; generation:number; cell:number; faction:number;
  building?:boolean; category?:ProductionCategory; free?:boolean;
  silent?:boolean;
  owner?:number;
}
export const BUILDING_WORDS=6;
/** CPU-owned construction. Moving units, occupancy, damage and mining remain GPU-owned. */
export class EconomyRuntime {
  readonly house:HouseEconomy;
  readonly factories:FactoryBuilding[]=[];
  readonly queues:ProductionQueues;
  readonly buildings=new Map<number,LiveBuilding>();
  readonly lifecycle:GpuLifecycle;
  readonly report:EconomyReport;
  readonly miningState:StorageBufferAttribute;
  readonly transportState:StorageBufferAttribute;
  readonly serviceState:StorageBufferAttribute;
  /** Draw mode, animation start tick, storage level and flags, indexed by stable object ID. */
  readonly visuals:StorageBufferAttribute;
  readonly placement:PlacementGrid;
  readonly health:Int32Array;
  readonly generations:Int32Array;
  readonly types:Int32Array;
  readonly owners:Int32Array;
  placementVersion=0;
  private get width(){return this.battle.setup.grid.width;}
  private get cells(){return this.battle.setup.grid.edges.length;}
  frame=0;
  selected=-1;
  placing:string|undefined;
  mode:'normal'|'repair'|'sell'='normal';
  message='';
  waves=false;
  productionSpeed:1|10|100=1;
  onEvent?:(name:string)=>void;
  private ready:Int32Array|undefined;
  private waiting=false;
  private released=false;
  private readonly actions:(()=>void)[]=[];
  private readonly pending:PendingSpawn[]=[];
  private readonly freebies:{name:string;building:number;attempt:number}[]=[];
  private freeSlots:number[]=[];
  private lost=0;
  private readonly detail=new Int32Array(8).fill(-1);
  private refunded=0;
  private delivered=0;
  private repaired=0;
  private readonly announcements={power:1,silos:1,attack:1};
  private knownOptions=new Set<string>();
  private readonly busyFactories=new Set<number>();
  private readonly docked=new Map<number,{id:number;load:number}>();
  private readonly visualIds=new Set<number>();
  constructor(readonly battle:GpuCombat,readonly scene:EconomyScene,readonly faction=1){
    const count=battle.setup.units.length,cells=scene.playable.length;
    this.house=new HouseEconomy(scene.buildingDemo?100000:10000);
    this.queues=new ProductionQueues(this.house,this.factories);
    this.miningState=new StorageBufferAttribute(initialHarvest(count),1);
    this.transportState=new StorageBufferAttribute(initialTransport(count),1);
    this.serviceState=new StorageBufferAttribute(initialServices(count),1);
    this.lifecycle=new GpuLifecycle(battle);this.report=new EconomyReport(battle,this.miningState,this.transportState,this.serviceState);
    this.health=Int32Array.from(battle.setup.units,u=>u.health??MOVEMENT[u.type].strength);
    this.generations=Int32Array.from(this.health,h=>Number(h>0));
    this.types=Int32Array.from(battle.setup.units,u=>u.type);
    this.owners=Int32Array.from(battle.setup.units,u=>u.owner??0);
    for(let id=0;id<count;id++)if(this.health[id]<=0)this.freeSlots.push(id);
    this.visuals=new StorageBufferAttribute(new Int32Array(count*BUILDING_WORDS),1);
    this.placement={width:battle.setup.grid.width,height:battle.setup.grid.height,playable:scene.playable,buildable:scene.buildable,
      occupied:new Int32Array(cells).fill(-1),owners:new Int32Array(cells),bibs:new Int32Array(cells)};
    for(const b of scene.buildings)this.buildings.set(b.id,{...b,health:this.health[b.id],active:true,opened:true,started:0,duration:0,selling:false,repairing:false});
    this.rebuildMap();this.refreshHouse();this.updateVisuals();
  }
  get available(){return this.queues.options();}
  get deliveredUnits(){return this.delivered;}
  get radar(){return this.house.powerFraction>=256&&[...this.buildings.values()].some(b=>b.active&&(b.type==='HQ'||b.type==='EYE'));}
  select(id:number){this.selected=id;this.report.select(id);}
  command(action:()=>void){this.actions.push(action);}
  setProductionSpeed(speed:1|10|100){this.command(()=>{this.productionSpeed=speed;});}
  choose(name:string,secondary=false){this.command(()=>{
    const type=PRODUCTION.get(name);if(!type)return;
    const item=this.queues.items.get(type.category);
    if(secondary){
      if(item?.type.name!==name)return;
      if(item.suspended||item.complete){this.queues.cancel(type.category);if(this.placing===name)this.placing=undefined;this.onEvent?.('cancelled');}
      else{item.suspend();this.onEvent?.('hold');}
      return;
    }
    if(item?.type.name===name&&item.complete&&type.category==='building'){this.placing=name;this.mode='normal';return;}
    if(item&&(item.type.name!==name||!item.suspended)){this.onEvent?.('busy');return;}
    if(this.queues.begin(name)){this.onEvent?.('building');this.message='';}
  });}
  toggle(mode:'repair'|'sell'){this.mode=this.mode===mode?'normal':mode;this.placing=undefined;}
  cancelPlacement(){this.placing=undefined;this.mode='normal';}
  click(cell:number){
    if(this.placing){const name=this.placing;this.command(()=>this.place(name,cell));return true;}
    if(this.mode!=='normal'){
      const b=[...this.buildings.values()].find(b=>placementOffsets(b.type).some(([x,y])=>b.cell+y*this.width+x===cell));
      if(b)this.command(()=>{if(this.mode==='sell')this.sell(b.id);else if(b.active&&PRODUCTION.get(b.type)?.repairable){b.repairing=!b.repairing;b.wrenchVisible=true;}});
      return true;
    }
    return false;
  }
  deploy(){const id=this.selected;if(id>=0)this.command(()=>{this.deploying=id;});}
  selectPrimary(id:number){this.command(()=>{
    const b=this.buildings.get(id);if(!b?.active||!['PYLE','HAND','WEAP','AFLD'].includes(b.type))return;
    const category=PRODUCTION.get(b.type)!.factory,peers=[...this.buildings.values()].filter(other=>other.active&&PRODUCTION.get(other.type)!.factory===category);
    if(peers.length<2)return;
    const primary=!b.primary;for(const other of peers)other.primary=false;b.primary=primary;
    if(primary)this.onEvent?.('primary');
  });}
  private deploying=-1;
  private freeSlot(){return this.freeSlots.find(id=>!this.pending.some(p=>p.id===id))??-1;}
  private createBuilding(name:string,cell:number,id:number,faction:number,health=PRODUCTION.get(name)!.strength,category?:ProductionCategory){
    this.pending.push({id,name,cell,faction,generation:this.generations[id]+1,building:true,category});
    this.lifecycle.create(id,{type:movementType(name),cell,health,owner:0,facing:0},{ignore:id});
    this.lifecycle.status(id,this.house.powerFraction,false);
  }
  private place(name:string,cell:number){
    const item=this.queues.items.get('building');
    if(!item?.complete||item.type.name!==name||this.pending.some(p=>p.category==='building'))return;
    if(!canPlaceBuilding(this.placement,name,cell,0)){this.message='Unable to build here';this.onEvent?.('cantbuild');return;}
    const id=this.freeSlot();if(id<0)return;
    const faction=['AFLD','HAND'].includes(name)?2:['WEAP','PYLE'].includes(name)?1:this.faction;
    this.createBuilding(name,cell,id,faction,undefined,'building');
  }
  private sell(id:number){
    const b=this.buildings.get(id);if(!b||!b.active)return;
    if(b.type==='PROC'&&this.busyFactories.has(id)){this.message='The refinery is unloading';return;}
    const occupant=this.docked.get(id);
    if(b.type==='FIX'&&occupant){this.house.refund(unitSaleRefund(PRODUCTION.get(MOVEMENT[this.types[occupant.id]].name)!,occupant.load));this.lifecycle.edit(occupant.id,REMOVE);return;}
    if(WALLS[b.type]){this.house.refund(saleRefund(PRODUCTION.get(b.type)!));this.lifecycle.edit(id,REMOVE);this.buildings.delete(id);this.rebuildMap();return;}
    b.active=false;b.repairing=false;b.selling=true;b.started=this.frame;
    b.duration=this.animationDuration(b.type);this.refreshHouse();
    const count=Math.min(5,Math.max(1,Math.ceil(rawCost(PRODUCTION.get(b.type)!)/(b.faction===this.faction?200:400))));
    const shape=BUILDINGS.get(b.type)!,center=b.cell+Math.trunc((shape.width===2?255:shape.width*128)/256)+Math.trunc(((shape.height===2?255:shape.height*128)-128)/256)*this.width;
    let engineer=false;for(let i=0;i<count;i++)if(this.spawnCrew(b,center,i,false,!engineer)==='E6')engineer=true;
  }
  private animationDuration(name:string){return WALLS[name]?0:constructionAnimation(this.scene.scene.animation!.frames.get(`${name}MAKE`)?.length??1).ticks;}
  private spawnCrew(b:LiveBuilding,cell:number,index:number,damaged:boolean,allowEngineer=true){
    const id=this.freeSlot();if(id<0)return;
    const roll=(stream:number,max:number)=>randomWord(this.scene.setup.seed,this.frame,b.id,220+index*8+stream)%max;
    let name='E1';
    if(b.type==='SILO')name=roll(0,2)?'C7':'C1';
    else if(allowEngineer&&b.type==='FACT'&&b.faction===this.faction&&roll(0,4)===0)name='E6';
    else if(combatTypes[movementType(b.type)].primary<0&&roll(1,7)===1)name=roll(2,2)?'C7':'C1';
    const max=PRODUCTION.get(name)!.strength,health=damaged?5+roll(3,max-4):max;
    this.pending.push({id,name,cell,faction:b.faction,generation:this.generations[id]+1,silent:true});
    this.lifecycle.create(id,{type:movementType(name),cell,health,owner:b.owner},{ignore:b.id});
    const offsets=[-this.width,1-this.width,1,this.width+1,this.width,this.width-1,-1,-this.width-1],target=cell+offsets[roll(4,8)];
    if(target>=0&&target<this.cells)this.lifecycle.edit(id,DESTINATION,target);
    return name;
  }
  private open(b:LiveBuilding){
    b.active=true;b.opened=true;
    if(b.type==='PROC')this.freebies.push({name:'HARV',building:b.id,attempt:0});
    if(b.type==='HPAD')this.freebies.push({name:this.faction===2?'HELI':'ORCA',building:b.id,attempt:0});
  }
  private rebuildMap(){
    this.placementVersion++;
    const occupied=this.placement.occupied as Int32Array,owners=this.placement.owners as Int32Array,bibs=this.placement.bibs as Int32Array;
    occupied.fill(-1);owners.fill(0);bibs.fill(0);
    const passable=this.scene.basePassable.slice();
    for(const b of this.buildings.values()){
      const shape=BUILDINGS.get(b.type)!;
      for(const [x,y] of shape.occupy){const c=b.cell+y*this.width+x;occupied[c]=b.id;owners[c]=b.owner+1;passable[c]=0;}
      if(shape.bib)for(let y=shape.height-1;y<=shape.height;y++)for(let x=0;x<shape.width;x++){
        const c=b.cell+y*this.width+x;bibs[c]=b.id+1;owners[c]=b.owner+1;
      }
    }
    this.battle.movement.updateMap(gridEdges(this.width,this.battle.setup.grid.height,passable,true).edges,passable,this.scene.baseLand);
    this.battle.setBuildings(occupied);
    this.lifecycle.setPlacementClear(Int32Array.from(passable,(open,cell)=>Number(!!open&&!bibs[cell]&&!!this.scene.playable[cell]&&(this.scene.baseLand[cell]===0||this.scene.baseLand[cell]===1))));
  }
  private refreshHouse(){
    this.factories.length=0;this.house.power=0;this.house.drain=0;
    let capacity=0;
    for(const b of this.buildings.values()){
      const type=PRODUCTION.get(b.type)!;
      if(!b.selling&&b.dying===undefined)this.factories.push({...b,active:true});
      // BUILDING.CPP AI updates Power_Output during construction; Grand_Opening adds drain and capacity.
      this.house.power+=buildingPower(type,Math.max(0,b.health));
      if(b.opened){this.house.drain+=type.drain??0;capacity+=type.capacity??0;}
    }
    // Destruction has already reconciled its capacity before this general refresh.
    if(capacity!==this.house.capacity)this.house.adjustCapacity(capacity-this.house.capacity,false);
    const options=new Set(this.available.map(type=>type.name));
    if([...options].some(name=>!this.knownOptions.has(name)))this.onEvent?.('newoptions');this.knownOptions=options;
  }
  private updateVisuals(){
    const values=this.visuals.array as Int32Array;
    for(const id of this.visualIds)if(!this.buildings.has(id)){
      values.fill(0,id*BUILDING_WORDS,(id+1)*BUILDING_WORDS);this.visuals.addUpdateRange(id*BUILDING_WORDS,BUILDING_WORDS);this.visuals.needsUpdate=true;this.visualIds.delete(id);
    }
    const level=this.house.capacity?Math.min(4,Math.trunc(this.house.tiberium*5/this.house.capacity)):0;
    let constructing=false;for(const b of this.buildings.values())if(b.dying===undefined&&!b.active&&!b.selling){constructing=true;break;}
    for(const b of this.buildings.values()){
      let shape=level;
      if(WALLS[b.type]){
        shape=0;for(const [dx,dy,bit] of [[0,-1,1],[1,0,2],[0,1,4],[-1,0,8]]){
          const x=b.cell%this.width+dx,y=Math.trunc(b.cell/this.width)+dy;
          if(x>=0&&x<this.width&&y>=0&&y<this.placement.height&&this.buildings.get(this.placement.occupied[y*this.width+x])?.type===b.type)shape|=bit;
        }
      }
      const capacity=PRODUCTION.get(b.type)!.capacity??0,maxPips=Math.min(10,Math.trunc(capacity/100));
      const pips=(maxPips*(this.house.capacity?Math.trunc(this.house.tiberium*256/this.house.capacity):0)+128)>>8;
      const working=b.type==='FACT'&&constructing;
      const flags=Number(!!b.primary)|Number(b.repairing&&!!b.wrenchVisible)*2|Number(working)*4;
      const record=[b.active?0:b.selling?2:1,b.started,shape,Number(b.active),flags,pips],at=b.id*BUILDING_WORDS;
      if(record.some((value,index)=>values[at+index]!==value)){
        values.set(record,at);this.visuals.addUpdateRange(at,BUILDING_WORDS);this.visuals.needsUpdate=true;
      }
      this.visualIds.add(b.id);
    }
  }
  private accept(report:Int32Array){
    this.busyFactories.clear();this.docked.clear();
    const records=report[16],free=report[17];
    for(let i=0;i<records;i++){
      const at=REPORT_HEADER+i*REPORT_RECORD,id=report[at];
      this.health[id]=report[at+1];this.generations[id]=report[at+2];this.types[id]=report[at+7];
      if(report[at+4])this.busyFactories.add(id);
      if(report[at+5]>=0)this.docked.set(id,{id:report[at+5],load:report[at+6]});
    }
    this.freeSlots.length=0;
    for(let i=0;i<free;i++){const at=REPORT_HEADER+records*REPORT_RECORD+i*2,id=report[at];this.freeSlots.push(id);this.health[id]=0;this.generations[id]=report[at+1];}
    for(;this.lost<report[15];this.lost++)this.onEvent?.('unitlost');
    this.detail.set(report.subarray(0,8));
    const harvested=report[8];
    if(harvested>this.house.harvested)this.house.harvest(harvested-this.house.harvested);
    const refunded=report[10],delivered=report[12];
    if(refunded>this.refunded)this.house.refund(refunded-this.refunded);this.refunded=refunded;
    if(delivered>this.delivered)this.onEvent?.('reinforcements');this.delivered=delivered;
    const repaired=report[13];if(repaired>this.repaired)this.house.spend(repaired-this.repaired);this.repaired=repaired;
    let changed=false;
    for(const p of this.pending.splice(0)){
      if(this.generations[p.id]!==p.generation){
        this.message=p.building?'Unable to build here':'Exit blocked';
        if(p.free){if(p.name==='HARV')this.house.refund(PRODUCTION.get('HARV')!.cost);this.freebies.shift();}
        continue;
      }
      this.types[p.id]=movementType(p.name);
      this.owners[p.id]=p.owner??0;
      if(p.building){
        this.buildings.set(p.id,{id:p.id,type:p.name,cell:p.cell,faction:p.faction,owner:0,health:this.health[p.id],active:false,opened:false,
          started:this.frame,duration:this.animationDuration(p.name),selling:false,repairing:false});
        changed=true;if(p.category)this.placing=undefined;
      }
      if(p.category)this.queues.items.delete(p.category);
      if(p.free)this.freebies.shift();
    }
    for(const [id,b] of this.buildings){
      if(this.health[id]<b.health&&this.frame>=this.announcements.attack){this.onEvent?.('underattack');this.announcements.attack=this.frame+1800;}
      b.health=this.health[id];
      if(b.health<=0){
        if(b.dying===undefined){
          b.active=false;b.repairing=false;b.dying=this.frame;
          if(WALLS[b.type]){this.buildings.delete(id);changed=true;}else this.onEvent?.('buildinglost');
        }
      }
    }
    if(changed)this.rebuildMap();this.refreshHouse();
  }
  /** Called before the next fixed tick. A late report stalls that tick without dropping it. */
  beginTick(){
    if(this.waiting&&!this.ready)return false;
    if(this.ready){this.accept(this.ready);this.ready=undefined;this.waiting=false;}
    this.frame=this.battle.frame+1;
    for(const action of this.actions.splice(0))action();
    if(this.deploying>=0){
      const [id,type,cell,face,dest,health,,goal]=this.detail;
      if(id===this.deploying){
        if(type!==movementType('MCV')||health<=0)this.deploying=-1;
        else if(dest<0&&goal<0){
          const yard=deployYard(this.placement,cell,health,id,0);
          if(!yard){this.message='Unable to deploy here';this.onEvent?.('cantdeploy');this.deploying=-1;}
          else if(face===160){this.createBuilding('FACT',yard.cell,id,this.faction,yard.health);this.deploying=-1;}
          else this.lifecycle.face(id,160);
        }
      }
    }
    let changed=false;
    for(const [id,b] of this.buildings){
      if(b.dying!==undefined){
        if(this.frame-b.dying>=(b.selling?0:8)){
          for(const [i,[x,y]] of BUILDINGS.get(b.type)!.occupy.entries())if(randomWord(this.scene.setup.seed,this.frame,id,210+i)%(b.faction===this.faction?3:9)===1)this.spawnCrew(b,b.cell+y*this.width+x,i,true);
          if(b.opened)this.house.adjustCapacity(-(PRODUCTION.get(b.type)!.capacity??0),true);
          this.buildings.delete(id);changed=true;
        }
        continue;
      }
      if(!b.active&&this.frame-b.started>=b.duration){
        if(b.selling){this.house.adjustCapacity(-(PRODUCTION.get(b.type)!.capacity??0),true);this.house.refund(saleRefund(PRODUCTION.get(b.type)!));this.lifecycle.edit(id,REMOVE);this.buildings.delete(id);changed=true;}
        else{this.open(b);changed=true;}
      }
      if(b.repairing&&this.frame%15===0){
        b.wrenchVisible=!b.wrenchVisible;
        const type=PRODUCTION.get(b.type)!,step=repairStep(type);
        if(this.house.money<step.cost)b.repairing=false;
        else{this.house.spend(step.cost);b.health=Math.min(type.strength,b.health+step.health);this.lifecycle.edit(id,HEALTH,b.health);if(b.health===type.strength)b.repairing=false;}
      }
      // HOUSE.CPP AI applies one AP hit each minute while power is insufficient.
      if(this.frame%900===0&&this.house.powerFraction<256&&b.health*2>PRODUCTION.get(b.type)!.strength){
        b.health-=modifyDamage(1,bullets[2].warhead,combatTypes[movementType(b.type)].armor);this.lifecycle.edit(id,HEALTH,b.health);
      }
    }
    if(changed){this.rebuildMap();this.refreshHouse();}
    const finishing=[...this.queues.items.values()].filter(item=>!item.complete);
    this.queues.step(this.productionSpeed);
    if(this.frame>=this.announcements.power&&this.house.powerFraction<256&&this.factories.some(b=>b.active&&b.type==='FACT')){this.onEvent?.('lowpower');this.announcements.power=this.frame+1800;}
    if(this.frame>=this.announcements.silos&&this.house.maxedOut){
      this.house.maxedOut=false;if(this.house.capacity>500&&this.house.capacity-this.house.tiberium<300&&this.factories.some(b=>b.type==='PROC'||b.type==='FACT')){this.onEvent?.('silos');this.announcements.silos=this.frame+1800;}
    }
    for(const item of finishing)if(item.complete)this.onEvent?.(item.type.category==='infantry'?'unitready':'complete');
    for(const [category,item] of this.queues.items)if(item.complete&&category!=='building'&&!this.pending.some(p=>p.category===category))this.produce(item.type.name,category);
    const gift=this.freebies[0];if(gift&&!this.pending.some(p=>p.free)){
      const b=this.buildings.get(gift.building);if(!b)this.freebies.shift();else this.spawnNear(gift.name,b,undefined,true,gift.attempt++);
    }
    if(this.scene.buildingDemo&&this.waves&&this.frame%450===60)this.spawnWave();
    for(const b of this.buildings.values())this.lifecycle.status(b.id,this.house.powerFraction,b.active);
    this.lifecycle.flush();this.updateVisuals();return true;
  }
  private produce(name:string,category:ProductionCategory){
    const type=PRODUCTION.get(name)!;
    const candidates=[...this.buildings.values()].filter(b=>b.active&&PRODUCTION.get(b.type)?.factory===category&&(type.factions&b.faction)&&(category==='aircraft'||!this.busyFactories.has(b.id)));
    const factory=candidates.find(b=>b.primary)??candidates.at(-1);
    if(factory){if(factory.type==='AFLD')this.spawnDelivery(name,factory,category);else this.spawnNear(name,factory,category);}
  }
  private spawnDelivery(name:string,b:LiveBuilding,category:ProductionCategory){
    const id=this.freeSlot();if(id<0)return;
    const bounds=this.scene.setup.bounds!;
    const cell=(Math.trunc(b.cell/this.width)+1)*this.width+bounds.x+bounds.width;
    this.pending.push({id,name:'C17',cell,faction:b.faction,generation:this.generations[id]+1,category,silent:true});
    const cargo=this.freeSlot();if(cargo<0){this.pending.pop();return;}
    this.pending.push({id:cargo,name,cell,faction:b.faction,generation:this.generations[cargo]+1,silent:true});
    this.lifecycle.create(id,{type:movementType('C17'),cell,owner:b.owner,facing:192,altitude:24,enter:b.id+1});
    this.lifecycle.create(cargo,{type:movementType(name),cell,owner:b.owner,attached:id+1});
  }
  private spawnWave(){
    const id=this.freeSlot();if(id<0)return;
    const base=[...this.buildings.values()].find(b=>b.active&&['SAM','ATWR','GTWR','GUN','OBLI'].includes(b.type))??this.buildings.values().next().value;
    if(!base)return;
    const cell=Math.trunc(base.cell/this.width)*this.width+(this.scene.setup.bounds?.x??0)+(this.scene.setup.bounds?.width??this.width)-2;
    this.pending.push({id,name:'TRAN',cell,faction:2,generation:this.generations[id]+1,silent:true,owner:1});
    this.lifecycle.create(id,{type:movementType('TRAN'),cell,owner:1,facing:192,altitude:24});
    this.lifecycle.edit(id,DESTINATION,base.cell+5);
    for(let i=0;i<4;i++){
      const cargo=this.freeSlot();if(cargo<0)break;
      this.pending.push({id:cargo,name:'E1',cell,faction:2,generation:this.generations[cargo]+1,silent:true,owner:1});
      this.lifecycle.create(cargo,{type:movementType('E1'),cell,owner:1,attached:id+1});
    }
  }
  private spawnNear(name:string,b:LiveBuilding,category?:ProductionCategory,free=false,attempt=this.frame){
    const id=this.freeSlot();if(id<0){if(free){if(name==='HARV')this.house.refund(PRODUCTION.get('HARV')!.cost);this.freebies.shift();}return;}
    const shape=BUILDINGS.get(b.type)!,air=PRODUCTION.get(name)!.category==='aircraft';
    const exits:number[]=[];
    for(let radius=0;radius<5;radius++)for(let y=-radius;y<=shape.height+radius;y++)for(let x=-radius;x<=shape.width+radius;x++){
      const cell=b.cell+y*this.width+x;if(cell<0||cell>=this.cells||!this.scene.playable[cell])continue;
      if(air||this.scene.setup.passable?.[cell])exits.push(cell);
    }
    if(!exits.length)return;
    const gift=free&&name==='HARV',point=gift?undefined:FACTORY_POINT[b.type];
    const cell=gift?b.cell+2*this.width:air?b.cell+1:point?b.cell+Math.trunc(point[1]/256)*this.width+Math.trunc(point[0]/256):exits[attempt%exits.length];
    this.pending.push({id,name,cell,faction:b.faction,generation:this.generations[id]+1,category,free});
    this.lifecycle.create(id,{type:movementType(name),cell,owner:b.owner,facing:air?32:160,enter:air?b.id+1:point?-b.id-1:0},{ignore:b.id,nearby:gift});
    if(!air&&!point&&!gift)this.lifecycle.edit(id,DESTINATION,cell);
  }
  endTick(){
    // Reserve enough free IDs for every building's possible crew, gifts and production.
    let slots=16;for(const b of this.buildings.values())slots+=Math.max(5,BUILDINGS.get(b.type)!.occupy.length);
    this.report.request([...this.buildings.keys(),...this.pending.map(p=>p.id)],slots);
    this.waiting=true;
    return this.report.read().then(result=>{if(!this.released)this.ready=result;});
  }
  dispose(){this.released=true;this.report.dispose();this.lifecycle.dispose();releaseStorage(this.battle.renderer,[this.visuals,this.miningState,this.transportState,this.serviceState]);}
}
