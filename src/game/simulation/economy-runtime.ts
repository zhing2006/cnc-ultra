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
import { repairStep,rawCost,unitSaleRefund } from './economy.ts';
import { HouseState } from './house-state.ts';
import { SuperWeapons, type SuperKind } from './super-weapons.ts';
import { buildingPower, canPlaceBuilding, constructionAnimation, deployYard, placementOffsets, saleRefund, type PlacementGrid } from './building-rules.ts';
import { GpuLifecycle, HEALTH, REMOVE, DESTINATION } from './lifecycle-gpu.ts';
import { EconomyReport,REPORT_COUNTS,REPORT_RECORD } from './economy-report.ts';
import type { EconomySetup, InitialBuilding } from './economy-setup.ts';
import type { GpuCombat } from './combat-gpu.ts';
import { initialHarvest } from './harvest-cpu.ts';
import { initialTransport } from './transport-cpu.ts';
import { initialServices,FACTORY_POINT } from './services-cpu.ts';
import { mcvDeployment } from '../ai/deployment.ts';
import { GUARD,HUNT,ATTACK,GUARD_AREA } from './combat-state.ts';
import { scaleIncomingDamage } from '../debug.ts';
import type { AnimationRequest } from './building-effects-state.ts';
import { TECHNICIAN } from './units-state.ts';

export interface LiveBuilding extends InitialBuilding {
  health:number; active:boolean; started:number; duration:number; selling:boolean; repairing:boolean;
  dying?:number;
  saboteur?:number;
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
type SavedCommand = { kind: 'choose'; name: string; secondary: boolean } | { kind: 'fire'; weapon: SuperKind; cell: number }
  | { kind: 'place'; name: string; cell: number } | { kind: 'building' | 'deploy' | 'primary'; id: number };
/** CPU-owned construction. Moving units, occupancy, damage and mining remain GPU-owned. */
export class EconomyRuntime {
  readonly animations: AnimationRequest[] = [];
  readonly houses: readonly HouseState[];
  readonly supers: SuperWeapons;
  private actingOwner = 0;
  get owner(){return this.actingOwner;}
  get current(){return this.houses[this.actingOwner];}
  get faction(){return this.current.faction;}
  get house(){return this.current.economy;}
  get factories(){return this.current.factories;}
  get queues(){return this.current.queues;}
  controlledOwner:number|null=0;
  setOwner(owner:number){this.actingOwner=owner;this.report.select(this.selected);}
  setController(owner:number|null){this.controlledOwner=owner;this.battle.humanOwner.value=owner??-1;if(owner!==null)this.setOwner(owner);this.syncDebugDamage();}
  syncDebugDamage(){
    this.battle.debugDamageOwner.value=this.controlledOwner??-1;
    this.battle.debugDamageScale.value=this.controlledOwner===null?1000:this.houses[this.controlledOwner].debugDamageScale;
  }
  /** Consume an already-submitted accounting report while paused, without executing another tick. */
  async settleForDebug(){
    await this.reportCompletion;
    if(this.released)return;
    if(this.ready){this.accept(this.ready);this.ready=undefined;this.waiting=false;}
  }
  withOwner<T>(owner:number,work:()=>T):T{const before=this.actingOwner;this.actingOwner=owner;try{return work();}finally{this.actingOwner=before;}}
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
  protected get width(){return this.battle.setup.grid.width;}
  private get cells(){return this.battle.setup.grid.edges.length;}
  frame=0;
  get selected(){return this.current.selected;} set selected(value:number){this.current.selected=value;}
  get placing(){return this.current.placing;} set placing(value:string|undefined){this.current.placing=value;}
  get mode(){return this.current.mode;} set mode(value:HouseState['mode']){this.current.mode=value;}
  get message(){return this.current.message;} set message(value:string){this.current.message=value;}
  onEvent?:(name:string,owner:number)=>void;
  onSound?:(name:string,x:number,y:number)=>void;
  onShake?:()=>void;
  onTick?:()=>void;
  onSceneryVisibility?:(sprite:number,visible:boolean)=>void;
  onNuclearFlash?:(phase:'rise'|'fall')=>void;
  onBaseAttacked?:(owner:number,enemy:number)=>void;
  get outcome():number|undefined{return undefined;}
  get extraSimulationBuffers():readonly StorageBufferAttribute[]{return [];}
  async prepareForPlay(){await Promise.all([this.lifecycle.prepareForPlay(),this.report.prepareForPlay()]);}
  private emit(name:string){this.onEvent?.(name,this.owner);}
  private ready:Int32Array|undefined;
  private waiting=false;
  private released=false;
  private readonly actions:{ run: () => void; owner: number; saved?: SavedCommand }[]=[];
  private reportCompletion: Promise<void> = Promise.resolve();
  protected get trackedActors(): readonly number[] { return []; }
  protected actorDetail(id: number) { return this.details.get(id); }
  protected readonly pending:PendingSpawn[]=[];
  private get freebies(){return this.current.freebies;}
  private freeSlots:number[]=[];
  private readonly detail=new Int32Array(8).fill(-1);
  private readonly details=new Map<number,Int32Array>();
  private readonly attackers=new Map<number,number>();
  private readonly mobileYards=new Map<number,number>();
  readonly inventory:Int32Array;
  private get announcements(){return this.current.announcements;}
  private get knownOptions(){return this.current.knownOptions;} private set knownOptions(value:Set<string>){this.current.knownOptions=value;}
  private readonly busyFactories=new Set<number>();
  private readonly docked=new Map<number,{id:number;load:number}>();
  private readonly visualIds=new Set<number>();
  constructor(readonly battle:GpuCombat,readonly scene:EconomySetup,faction=1){
    const count=battle.setup.units.length,cells=scene.playable.length;
    const initial=scene.houses??[{faction,credits:scene.credits},{faction:faction===1?2:1,credits:0}];
    this.houses=initial.map((house, owner)=>new HouseState(owner,house.faction,house.credits));
    this.inventory=new Int32Array(MOVEMENT.length*this.houses.length);
    this.supers=new SuperWeapons(battle.setup.grid.width,battle.setup.grid.height,battle.setup.bounds??{x:0,y:0,width:battle.setup.grid.width,height:battle.setup.grid.height},
      new Map([...scene.scene.animation!.frames].map(([name,frames])=>[name,frames.length])),this.houses.length);
    this.miningState=new StorageBufferAttribute(initialHarvest(count),1);
    this.transportState=new StorageBufferAttribute(initialTransport(count),1);
    this.serviceState=new StorageBufferAttribute(initialServices(count),1);
    this.lifecycle=new GpuLifecycle(battle);this.report=new EconomyReport(battle,this.miningState,this.transportState,this.serviceState);
    this.health=Int32Array.from(battle.setup.units,u=>u.health??MOVEMENT[u.type].strength);
    this.generations=Int32Array.from(this.health,h=>Number(h>0));
    this.types=Int32Array.from(battle.setup.units,u=>u.type);
    this.owners=Int32Array.from(battle.setup.units,u=>u.owner??0);
    for(let id=0;id<count;id++)if(this.health[id]<=0)this.freeSlots.push(id);else this.inventory[this.owners[id]*MOVEMENT.length+this.types[id]]++;
    for(let id=0;id<count;id++)if(this.health[id]>0&&this.types[id]===movementType('MCV'))this.mobileYards.set(id,0);
    this.visuals=new StorageBufferAttribute(new Int32Array(count*BUILDING_WORDS),1);
    this.placement={width:battle.setup.grid.width,height:battle.setup.grid.height,playable:scene.playable,buildable:scene.buildable,
      occupied:new Int32Array(cells).fill(-1),owners:new Int32Array(cells),bibs:new Int32Array(cells)};
    for(const b of scene.buildings)this.buildings.set(b.id,{...b,health:this.health[b.id],active:true,opened:true,started:0,duration:0,selling:false,repairing:false});
    this.rebuildMap();this.refreshHouse();this.updateVisuals();
  }
  get available(){return this.queues.options();}
  get deliveredUnits(){return this.current.delivered;}
  get radar(){return this.house.powerFraction>=256&&[...this.buildings.values()].some(b=>b.owner===this.owner&&b.active&&(b.type==='HQ'||b.type==='EYE'));}
  select(id:number){this.selected=id;this.report.select(id);}
  command(action:()=>void,saved?:SavedCommand){const owner=this.owner;this.actions.push({run:()=>this.withOwner(owner,action),owner,saved});}
  choose(name:string,secondary=false){this.command(()=>{
    const type=PRODUCTION.get(name);if(!type)return;
    const item=this.queues.items.get(type.category);
    if(secondary){
      if(item?.type.name!==name)return;
      if(item.suspended||item.complete){this.queues.cancel(type.category);if(this.placing===name)this.placing=undefined;this.emit('cancelled');}
      else{item.suspend();this.emit('hold');}
      return;
    }
    if(item?.type.name===name&&item.complete&&type.category==='building'){this.placing=name;this.mode='normal';return;}
    if(item&&(item.type.name!==name||!item.suspended)){this.emit('busy');return;}
    if(this.queues.begin(name)){this.emit('building');this.message='';}
  },{kind:'choose',name,secondary});}
  toggle(mode:'repair'|'sell'){this.mode=this.mode===mode?'normal':mode;this.placing=undefined;}
  cancelPlacement(){this.placing=undefined;this.current.specialTarget=undefined;this.mode='normal';}
  chooseSuper(kind:SuperKind){
    const weapon=this.supers.charges[this.owner][kind];
    if(weapon.ready){this.current.specialTarget=kind;this.placing=undefined;this.mode='normal';}
    else this.emit(weapon.suspended?'lowpower':kind==='ion'?'ioncharging':'notready');
  }
  click(cell:number){
    if(this.current.specialTarget){const kind=this.current.specialTarget;this.command(()=>{this.supers.fire(this.owner,kind,cell,this.frame,[...this.buildings.values()]);this.current.specialTarget=undefined;},{kind:'fire',weapon:kind,cell});return true;}
    if(this.placing){const name=this.placing;this.command(()=>this.place(name,cell),{kind:'place',name,cell});return true;}
    if(this.mode!=='normal'){
      const b=[...this.buildings.values()].find(b=>b.owner===this.owner&&placementOffsets(b.type).some(([x,y])=>b.cell+y*this.width+x===cell));
      if(b)this.command(()=>{if(this.mode==='sell')this.sell(b.id);else if(b.active&&PRODUCTION.get(b.type)?.repairable){b.repairing=!b.repairing;b.wrenchVisible=true;}},{kind:'building',id:b.id});
      return true;
    }
    return false;
  }
  deploy(id=this.selected){if(id>=0)this.command(()=>{this.deploying=id;},{kind:'deploy',id});}
  /** Remaster UNIT.CPP Mission_Guard/Mission_Unload/Mission_Hunt; only tracked MCV reports cross to the CPU. */
  deployIdleMcvs(){
    if(this.deploying>=0)return;
    for(const [id,next] of this.mobileYards){
      if(this.owners[id]!==this.owner||this.frame<next)continue;
      const detail=this.details.get(id);if(!detail)continue;
      const [,,cell,,destination,health,flags,goal]=detail,mission=flags>>1;
      if(health<=0||(flags&1)||destination>=0||goal>=0||(mission!==GUARD&&mission!==HUNT))continue;
      this.mobileYards.set(id,this.frame+15);
      const order=mcvDeployment(this.placement,cell,id,randomWord(this.scene.setup.seed,this.frame,id,430)%37);
      if(!order)continue;
      if(order.kind==='deploy')this.deploy(id);else this.lifecycle.edit(id,DESTINATION,order.cell);
      break;
    }
  }
  selectPrimary(id:number){this.command(()=>{
    const b=this.buildings.get(id);if(!b?.active||b.owner!==this.owner||!['PYLE','HAND','WEAP','AFLD'].includes(b.type))return;
    const category=PRODUCTION.get(b.type)!.factory,peers=[...this.buildings.values()].filter(other=>other.owner===this.owner&&other.active&&PRODUCTION.get(other.type)!.factory===category);
    if(peers.length<2)return;
    const primary=!b.primary;for(const other of peers)other.primary=false;b.primary=primary;
    if(primary)this.emit('primary');
  },{kind:'primary',id});}
  private get deploying(){return this.current.deploying;} private set deploying(value:number){this.current.deploying=value;}
  protected freeSlot(){return this.freeSlots.find(id=>!this.pending.some(p=>p.id===id))??-1;}
  protected createBuilding(name:string,cell:number,id:number,faction:number,health=PRODUCTION.get(name)!.strength,category?:ProductionCategory){
    this.pending.push({id,name,cell,faction,owner:this.owner,generation:this.generations[id]+1,building:true,category});
    this.lifecycle.create(id,{type:movementType(name),cell,health,owner:this.owner,facing:0},{ignore:id});
    this.lifecycle.status(id,this.house.powerFraction,false);
  }
  place(name:string,cell:number){
    const item=this.queues.items.get('building');
    if(!item?.complete||item.type.name!==name||this.pending.some(p=>p.owner===this.owner&&p.category==='building'))return;
    if(!canPlaceBuilding(this.placement,name,cell,this.owner)){this.message='Unable to build here';this.emit('cantbuild');return;}
    const id=this.freeSlot();if(id<0)return;
    const faction=['AFLD','HAND'].includes(name)?2:['WEAP','PYLE'].includes(name)?1:this.faction;
    this.createBuilding(name,cell,id,faction,undefined,'building');
  }
  sell(id:number){
    const b=this.buildings.get(id);if(!b||!b.active||b.owner!==this.owner)return;
    if(b.type==='PROC'&&this.busyFactories.has(id)){this.message='The refinery is unloading';return;}
    const occupant=this.docked.get(id);
    if(b.type==='FIX'&&occupant){this.house.refund(unitSaleRefund(PRODUCTION.get(MOVEMENT[this.types[occupant.id]].name)!,occupant.load));this.lifecycle.edit(occupant.id,REMOVE);return;}
    if(WALLS[b.type]){this.house.refund(saleRefund(PRODUCTION.get(b.type)!,this.controlledOwner===this.owner));this.lifecycle.edit(id,REMOVE);this.buildings.delete(id);this.rebuildMap();return;}
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
    if(this.scene.houseNames?.[b.owner]==='Neutral')name=`C${1+roll(0,9)}`;
    else if(b.type==='SILO')name=roll(0,2)?'C7':'C1';
    else if(allowEngineer&&b.type==='FACT'&&b.faction===this.faction&&roll(0,4)===0)name='E6';
    else if(combatTypes[movementType(b.type)].primary<0&&roll(1,7)===1)name=roll(2,2)?'C7':'C1';
    const max=PRODUCTION.get(name)!.strength,health=damaged?5+roll(3,max-4):max;
    this.pending.push({id,name,cell,faction:b.faction,owner:b.owner,generation:this.generations[id]+1,silent:true});
    // BUILDING.CPP Mission_Deconstruction / Drop_Debris: retain Scatter's NavCom independently of the mission.
    const source=damaged?(b.saboteur??-1):-1,target=source>=0&&this.owners[source]!==b.owner?source:-1;
    const mission=!damaged?GUARD_AREA:target>=0?ATTACK:this.controlledOwner===b.owner?GUARD:HUNT;
    const offsets=[-this.width,1-this.width,1,this.width+1,this.width,this.width-1,-1,-this.width-1],destination=cell+offsets[roll(4,8)];
    this.lifecycle.create(id,{type:movementType(name),cell,health,owner:b.owner,flags:/^C\d+$/.test(name)&&this.scene.houseNames?.[b.owner]!=='Neutral'?TECHNICIAN:0},{ignore:b.id,mission,target,destination:destination>=0&&destination<this.cells?destination:-1});
    return name;
  }
  private open(b:LiveBuilding){
    b.active=true;b.opened=true;
    this.buildingOpened(b);
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
    for(const state of this.houses)this.withOwner(state.owner,()=>{
      this.factories.length=0;this.house.power=0;this.house.drain=0;
      let capacity=0;
      for(const b of this.buildings.values()){
        if(b.owner!==this.owner)continue;
        const type=PRODUCTION.get(b.type)!;
        if(!b.selling&&b.dying===undefined)this.factories.push({...b,active:true});
        // BUILDING.CPP AI updates Power_Output during construction; Grand_Opening adds drain and capacity.
        this.house.power+=buildingPower(type,Math.max(0,b.health));
        if(b.opened){this.house.drain+=type.drain??0;capacity+=type.capacity??0;}
      }
      if(capacity!==this.house.capacity)this.house.adjustCapacity(capacity-this.house.capacity,false);
      const options=new Set(this.available.map(type=>type.name));
      if([...options].some(name=>!this.knownOptions.has(name)))this.emit('newoptions');this.knownOptions=options;
    });
  }
  private updateVisuals(){
    const values=this.visuals.array as Int32Array;
    for(const id of this.visualIds)if(!this.buildings.has(id)){
      values.fill(0,id*BUILDING_WORDS,(id+1)*BUILDING_WORDS);this.visuals.addUpdateRange(id*BUILDING_WORDS,BUILDING_WORDS);this.visuals.needsUpdate=true;this.visualIds.delete(id);
    }
    const constructing=new Set<number>();for(const b of this.buildings.values())if(b.dying===undefined&&!b.active&&!b.selling)constructing.add(b.owner);
    for(const b of this.buildings.values()){
      const house=this.houses[b.owner].economy;
      let shape=house.capacity?Math.min(4,Math.trunc(house.tiberium*5/house.capacity)):0;
      if(WALLS[b.type]){
        shape=0;for(const [dx,dy,bit] of [[0,-1,1],[1,0,2],[0,1,4],[-1,0,8]]){
          const x=b.cell%this.width+dx,y=Math.trunc(b.cell/this.width)+dy;
          if(x>=0&&x<this.width&&y>=0&&y<this.placement.height&&this.buildings.get(this.placement.occupied[y*this.width+x])?.type===b.type)shape|=bit;
        }
      }
      const capacity=PRODUCTION.get(b.type)!.capacity??0,maxPips=Math.min(10,Math.trunc(capacity/100));
      const pips=(maxPips*(house.capacity?Math.trunc(house.tiberium*256/house.capacity):0)+128)>>8;
      const working=b.type==='FACT'&&constructing.has(b.owner);
      const flags=Number(!!b.primary)|Number(b.repairing&&!!b.wrenchVisible)*2|Number(working)*4|((this.supers.doorFrame(b.id,this.frame)+1)<<3);
      const record=[b.active?0:b.selling?2:1,b.started,shape,Number(b.active),flags,pips],at=b.id*BUILDING_WORDS;
      if(record.some((value,index)=>values[at+index]!==value)){
        values.set(record,at);this.visuals.addUpdateRange(at,BUILDING_WORDS);this.visuals.needsUpdate=true;
      }
      this.visualIds.add(b.id);
    }
  }
  private accept(report:Int32Array){
    this.busyFactories.clear();this.docked.clear();this.details.clear();this.attackers.clear();
    this.inventory.set(report.subarray(REPORT_COUNTS,this.report.losses));
    const records=report[16],free=report[17];
    for(let i=0;i<records;i++){
      const at=this.report.header+i*REPORT_RECORD,id=report[at];
      this.health[id]=report[at+1];this.generations[id]=report[at+2];this.types[id]=report[at+7];this.owners[id]=report[at+12];
      this.details.set(id,new Int32Array([id,report[at+7],report[at+8],report[at+9],report[at+10],report[at+1],report[at+13],report[at+11],report[at+16],report[at+17],report[at+18],report[at+19],report[at+20]]));
      if(this.health[id]<=0||this.types[id]!==movementType('MCV'))this.mobileYards.delete(id);
      if(report[at+14]>=0)this.attackers.set(id,report[at+14]);
      const building=this.buildings.get(id);if(building)building.saboteur=report[at+15];
      if(report[at+4])this.busyFactories.add(id);
      if(report[at+5]>=0)this.docked.set(id,{id:report[at+5],load:report[at+6]});
    }
    this.freeSlots.length=0;
    for(let i=0;i<free;i++){const at=this.report.header+records*REPORT_RECORD+i*2,id=report[at];this.freeSlots.push(id);this.health[id]=0;this.generations[id]=report[at+1];}
    this.detail.set(report.subarray(0,8));
    for(const state of this.houses)this.withOwner(state.owner,()=>{
      for(;state.lost<report[this.report.losses+state.owner*2];state.lost++)this.emit('unitlost');
      state.buildingsLost=report[this.report.losses+state.owner*2+1];
      if(state.owner>=2)return;
      const harvested=report[8+state.owner],refunded=report[10+state.owner],delivered=report[state.owner===0?12:18],repaired=report[13+state.owner];
      if(harvested>state.harvested)this.house.harvest(harvested-state.harvested);state.harvested=harvested;
      if(refunded>state.refunded)this.house.refund(refunded-state.refunded);state.refunded=refunded;
      if(delivered>state.delivered)this.emit('reinforcements');state.delivered=delivered;
      if(repaired>state.repaired)this.house.spend(repaired-state.repaired);state.repaired=repaired;
    });
    let changed=false;
    for(const p of this.pending.splice(0))this.withOwner(p.owner??0,()=>{
      if(this.generations[p.id]!==p.generation){
        this.message=p.building?'Unable to build here':'Exit blocked';
        // Exit_Object == 1: the GPU still found mobile occupants after Flush_For_Placement.
        // Reuse the normal creation report, without adding another readback.
        if(p.category==='building'&&this.controlledOwner!==this.owner)this.current.placementRetryFrame=this.frame+45;
        if(p.free){if(p.name==='HARV')this.house.refund(PRODUCTION.get('HARV')!.cost);this.freebies.shift();}
        return;
      }
      this.types[p.id]=movementType(p.name);this.owners[p.id]=this.owner;
      if(p.name==='MCV')this.mobileYards.set(p.id,0);
      if(p.building){
        this.buildings.set(p.id,{id:p.id,type:p.name,cell:p.cell,faction:p.faction,owner:this.owner,health:this.health[p.id],active:false,opened:false,
          started:this.frame,duration:this.animationDuration(p.name),selling:false,repairing:false});
        changed=true;if(p.category)this.placing=undefined;
      }
      if(p.category)this.queues.items.delete(p.category);
      if(p.free)this.freebies.shift();
    });
    for(const [id,b] of this.buildings){
      if(this.health[id]>0&&this.owners[id]!==b.owner){
        // BUILDING.CPP Captured: the lost storage's excess Tiberium goes to the captor.
        const previous=this.houses[b.owner],next=this.houses[this.owners[id]],capacity=b.opened?(PRODUCTION.get(b.type)?.capacity??0):0;
        const booty=previous.economy.adjustCapacity(-capacity,true);
        next.economy.adjustCapacity(capacity,false);next.economy.harvest(booty);
        this.onEvent?.(previous.faction===1?'gdicaptured':'nodcaptured',b.owner);
        b.owner=next.owner;b.primary=false;b.repairing=false;changed=true;
      }
      this.withOwner(b.owner,()=>{
      if(this.health[id]<b.health){
        this.current.lastAttack=this.frame;
        const enemy=this.attackers.get(id);if(enemy!==undefined&&combatTypes[movementType(b.type)].primary<0)this.onBaseAttacked?.(b.owner,enemy);
      }
      if(this.health[id]<b.health&&this.frame>=this.announcements.attack){this.emit('underattack');this.announcements.attack=this.frame+1800;}
      b.health=this.health[id];
      if(b.health<=0&&b.dying===undefined){
        b.active=false;b.repairing=false;b.dying=this.frame;
        if(WALLS[b.type]){this.buildings.delete(id);changed=true;}else this.emit('buildinglost');
      }
      });
    }
    if(changed)this.rebuildMap();this.refreshHouse();
  }
  protected stepProduction(){this.queues.step(this.current.debugBuildSpeed);}
  /** Called before the next fixed tick. A late report stalls that tick without dropping it. */
  beginTick(){
    if(this.waiting&&!this.ready)return false;
    if(this.ready){this.accept(this.ready);this.ready=undefined;this.waiting=false;}
    this.frame=this.battle.frame+1;
    this.onTick?.();
    if(this.outcome!==undefined)return false;
    for(const action of this.actions.splice(0))action.run();
    for(const state of this.houses)this.withOwner(state.owner,()=>this.advanceHouse());
    this.advanceSupers();
    for(const b of this.buildings.values())this.lifecycle.status(b.id,this.houses[b.owner].economy.powerFraction,b.active);
    this.lifecycle.flush();this.updateVisuals();return true;
  }
  protected superAvailable(_kind: 'ion' | 'nuke', available: boolean) { return available; }
  private advanceSupers(){
    const buildings=[...this.buildings.values()];
    for(const state of this.houses)this.withOwner(state.owner,()=>{
      for(const kind of ['ion','nuke'] as const){
        const weapon=this.supers.charges[this.owner][kind],wasPresent=weapon.present;
        // HOUSE.CPP AI checks IsHuman only when granting a new nuclear device.
        // An existing device survives handover and the AI may still fire it.
        const available=this.superAvailable(kind,(kind!=='nuke'||wasPresent||this.controlledOwner===this.owner)&&
          buildings.some(b=>b.owner===this.owner&&b.active&&b.health>0&&!b.selling&&b.type===(kind==='ion'?'EYE':'TMPL')));
        if(weapon.step(this.frame,available,this.house.powerFraction>=256))this.emit(kind==='ion'?'ionready':'nukeready');
        if(!wasPresent&&weapon.present&&kind==='ion'&&!weapon.suspended)this.emit('ioncharging');
        if(this.controlledOwner!==this.owner&&weapon.ready){
          const targets=buildings.filter(b=>b.owner!==this.owner&&b.health>0);
          targets.sort((a,b)=>(combatTypes[movementType(b.type)].risk+combatTypes[movementType(b.type)].reward)-(combatTypes[movementType(a.type)].risk+combatTypes[movementType(a.type)].reward)||a.id-b.id);
          const target=targets[0];if(target)this.supers.fire(this.owner,kind,this.supers.targetCell(target),this.frame,buildings);
        }
      }
    });
    const explosions=this.supers.step(this.frame,buildings);if(explosions.length)this.battle.queueExplosions(explosions);
    for(const event of this.supers.events){
      if(event.sound)this.onSound?.(event.sound,event.x,event.y);
      if(event.speech)this.onEvent?.(event.speech,event.owner);
      if(event.shake)this.onShake?.();
      if(event.flash)this.onNuclearFlash?.(event.flash);
    }
  }
  private advanceHouse(){
    if(this.deploying>=0){
      const detail=this.details.get(this.deploying)??this.detail;
      const [id,type,cell,face,dest,health,,goal]=detail;
      if(id===this.deploying&&this.owners[id]===this.owner){
        if(type!==movementType('MCV')||health<=0)this.deploying=-1;
        else if(dest<0&&goal<0){
          const yard=deployYard(this.placement,cell,health,id,this.owner);
          if(!yard){this.message='Unable to deploy here';this.emit('cantdeploy');this.deploying=-1;}
          else if(face===160){this.createBuilding('FACT',yard.cell,id,this.faction,yard.health);this.deploying=-1;}
          else this.lifecycle.face(id,160);
        }
      }
    }
    let changed=false;
    for(const [id,b] of this.buildings){
      if(b.owner!==this.owner)continue;
      if(b.dying!==undefined){
        if(this.frame-b.dying>=(b.selling?0:8)){
          if(!b.selling)this.buildingDebris(b);
          const odds=2-Number((b.saboteur??-1)>=0)+(b.faction===this.faction?0:6);
          for(const [i,[x,y]] of BUILDINGS.get(b.type)!.occupy.entries())if(randomWord(this.scene.setup.seed,this.frame,id,210+i)%(odds+1)===1)this.spawnCrew(b,b.cell+y*this.width+x,i,true);
          if(b.opened)this.house.adjustCapacity(-(PRODUCTION.get(b.type)!.capacity??0),true);
          this.buildings.delete(id);changed=true;
        }
        continue;
      }
      if(!b.active&&this.frame-b.started>=b.duration){
        if(b.selling){this.house.adjustCapacity(-(PRODUCTION.get(b.type)!.capacity??0),true);this.house.refund(saleRefund(PRODUCTION.get(b.type)!,this.controlledOwner===this.owner));this.lifecycle.edit(id,REMOVE);this.buildings.delete(id);changed=true;}
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
        b.health-=scaleIncomingDamage(modifyDamage(1,bullets[2].warhead,combatTypes[movementType(b.type)].armor),b.owner,this.controlledOwner??-1,this.houses[this.controlledOwner??0].debugDamageScale);this.lifecycle.edit(id,HEALTH,b.health);
      }
    }
    if(changed){this.rebuildMap();this.refreshHouse();}
    const finishing=[...this.queues.items.values()].filter(item=>!item.complete);
    this.stepProduction();
    if(this.frame>=this.announcements.power&&this.house.powerFraction<256&&this.factories.some(b=>b.active&&b.type==='FACT')){this.emit('lowpower');this.announcements.power=this.frame+1800;}
    if(this.frame>=this.announcements.silos&&this.house.maxedOut){
      this.house.maxedOut=false;if(this.house.capacity>500&&this.house.capacity-this.house.tiberium<300&&this.factories.some(b=>b.type==='PROC'||b.type==='FACT')){this.emit('silos');this.announcements.silos=this.frame+1800;}
    }
    for(const item of finishing)if(item.complete)this.emit(item.type.category==='infantry'?'unitready':'complete');
    for(const [category,item] of this.queues.items)if(item.complete&&category!=='building'&&!this.pending.some(p=>p.owner===this.owner&&p.category===category))this.produce(item.type.name,category);
    const gift=this.freebies[0];if(gift&&!this.pending.some(p=>p.owner===this.owner&&p.free)){
      const b=this.buildings.get(gift.building);if(!b)this.freebies.shift();else this.spawnNear(gift.name,b,undefined,true,gift.attempt++);
    }
  }
  private produce(name:string,category:ProductionCategory){
    const type=PRODUCTION.get(name)!;
    const candidates=[...this.buildings.values()].filter(b=>b.owner===this.owner&&b.active&&PRODUCTION.get(b.type)?.factory===category&&(type.factions&b.faction)&&(category==='aircraft'||!this.busyFactories.has(b.id)));
    const factory=candidates.find(b=>b.primary)??candidates.at(-1);
    if(factory){if(factory.type==='AFLD')this.spawnDelivery(name,factory,category);else this.spawnNear(name,factory,category);}
  }
  protected spawnDelivery(name:string,b:LiveBuilding,category?:ProductionCategory){
    const id=this.freeSlot();if(id<0)return;
    const bounds=this.scene.setup.bounds!;
    const cell=(Math.trunc(b.cell/this.width)+1)*this.width+bounds.x+bounds.width;
    this.pending.push({id,name:'C17',cell,faction:b.faction,owner:b.owner,generation:this.generations[id]+1,category,silent:true});
    const cargo=this.freeSlot();if(cargo<0){this.pending.pop();return;}
    this.pending.push({id:cargo,name,cell,faction:b.faction,owner:b.owner,generation:this.generations[cargo]+1,silent:true});
    this.lifecycle.create(id,{type:movementType('C17'),cell,owner:b.owner,facing:192,altitude:24,enter:b.id+1});
    this.lifecycle.create(cargo,{type:movementType(name),cell,owner:b.owner,attached:id+1});
  }
  protected spawnNear(name:string,b:LiveBuilding,category?:ProductionCategory,free=false,attempt=this.frame){
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
    this.pending.push({id,name,cell,faction:b.faction,owner:b.owner,generation:this.generations[id]+1,category,free});
    this.lifecycle.create(id,{type:movementType(name),cell,owner:b.owner,facing:air?32:160,enter:air?b.id+1:point?-b.id-1:0},{ignore:b.id,nearby:gift});
    if(!air&&!point&&!gift)this.lifecycle.edit(id,DESTINATION,cell);
  }
  protected buildingOpened(_building: LiveBuilding) {}
  protected buildingDebris(_building: LiveBuilding) {}
  protected observeTick(): Promise<void> { return Promise.resolve(); }
  endTick(){
    // Reserve enough free IDs for every building's possible crew, gifts and production.
    let slots=16;for(const b of this.buildings.values())slots+=Math.max(5,BUILDINGS.get(b.type)!.occupy.length);
    this.report.request([...this.buildings.keys(),...this.pending.map(p=>p.id),...this.mobileYards.keys(),...this.trackedActors,...this.houses.flatMap(h=>[h.selected,h.deploying]).filter(id=>id>=0)],slots);
    this.waiting=true;
    return this.reportCompletion=Promise.all([this.report.read(),this.observeTick()]).then(([result])=>{if(!this.released)this.ready=result;});
  }
  /** Freeze at a tick boundary, preserving the report that the next tick has yet to consume. */
  async saveState() {
    await this.reportCompletion;
    return {
      owner:this.owner,controlledOwner:this.controlledOwner,frame:this.frame,placementVersion:this.placementVersion,animations:this.animations.map(request=>({...request})),
      houses:this.houses.map(h=>{const {queues,economy,factories,knownOptions,...state}=h;return {...state,knownOptions:[...knownOptions],
        economy:{...economy},factories:factories.map(f=>({...f})),queues:queues.saveState()};}),
      buildings:[...this.buildings].map(([id,b])=>[id,{...b}] as const),supers:this.supers.saveState(),
      health:Array.from(this.health),generations:Array.from(this.generations),types:Array.from(this.types),owners:Array.from(this.owners),
      placement:{occupied:Array.from(this.placement.occupied),owners:Array.from(this.placement.owners),bibs:Array.from(this.placement.bibs)},
      ready:this.ready?Array.from(this.ready):undefined,waiting:this.waiting,pending:this.pending.map(p=>({...p})),freeSlots:[...this.freeSlots],
      detail:Array.from(this.detail),details:[...this.details].map(([id,value])=>[id,Array.from(value)] as const),
      attackers:[...this.attackers],mobileYards:[...this.mobileYards],inventory:Array.from(this.inventory),busyFactories:[...this.busyFactories],
      docked:[...this.docked].map(([id,value])=>[id,{...value}] as const),visualIds:[...this.visualIds],
      actions:this.actions.map(action=>{if(!action.saved)throw new Error('A non-recordable development command is pending');return {owner:action.owner,command:action.saved};}),
    };
  }
  loadState(saved: Awaited<ReturnType<EconomyRuntime['saveState']>>) {
    this.animations.splice(0,this.animations.length,...saved.animations);
    this.frame=saved.frame;this.controlledOwner=saved.controlledOwner;this.placementVersion=saved.placementVersion;
    for(let i=0;i<this.houses.length;i++){
      const {queues,economy,factories,knownOptions,...values}=saved.houses[i],house=this.houses[i];
      Object.assign(house,values);house.knownOptions=new Set(knownOptions);Object.assign(house.economy,economy);
      house.factories.splice(0,house.factories.length,...factories);house.queues.loadState(queues);
    }
    this.buildings.clear();for(const [id,b] of saved.buildings)this.buildings.set(id,{...b});
    this.supers.loadState(saved.supers);
    this.health.set(saved.health);this.generations.set(saved.generations);this.types.set(saved.types);this.owners.set(saved.owners);
    (this.placement.occupied as Int32Array).set(saved.placement.occupied);(this.placement.owners as Int32Array).set(saved.placement.owners);(this.placement.bibs as Int32Array).set(saved.placement.bibs);
    this.ready=saved.ready?Int32Array.from(saved.ready):undefined;this.waiting=saved.waiting;
    this.pending.splice(0,this.pending.length,...saved.pending);this.freeSlots=[...saved.freeSlots];this.detail.set(saved.detail);
    this.details.clear();for(const [id,value] of saved.details)this.details.set(id,Int32Array.from(value));
    this.attackers.clear();for(const [id,value] of saved.attackers)this.attackers.set(id,value);
    this.mobileYards.clear();for(const [id,value] of saved.mobileYards)this.mobileYards.set(id,value);
    this.inventory.set(saved.inventory);this.busyFactories.clear();for(const id of saved.busyFactories)this.busyFactories.add(id);
    this.docked.clear();for(const [id,value] of saved.docked)this.docked.set(id,{...value});
    this.visualIds.clear();for(const id of saved.visualIds)this.visualIds.add(id);
    this.actions.length=0;
    for(const {owner,command} of saved.actions)this.withOwner(owner,()=>{
      switch(command.kind){
        case 'choose':this.choose(command.name,command.secondary);break;
        case 'deploy':this.deploy(command.id);break;
        case 'primary':this.selectPrimary(command.id);break;
        case 'place':this.command(()=>this.place(command.name,command.cell),command);break;
        case 'fire':this.command(()=>{this.supers.fire(this.owner,command.weapon,command.cell,this.frame,[...this.buildings.values()]);this.current.specialTarget=undefined;},command);break;
        case 'building':this.command(()=>{const b=this.buildings.get(command.id);if(!b)return;if(this.mode==='sell')this.sell(b.id);else if(b.active&&PRODUCTION.get(b.type)?.repairable){b.repairing=!b.repairing;b.wrenchVisible=true;}},command);break;
      }
    });
    this.setOwner(saved.owner);this.battle.humanOwner.value=saved.controlledOwner??-1;
    this.syncDebugDamage();
    this.rebuildMap();this.updateVisuals();this.placementVersion=saved.placementVersion;
  }
  dispose(){this.released=true;this.report.dispose();this.lifecycle.dispose();releaseStorage(this.battle.renderer,[this.visuals,this.miningState,this.transportState,this.serviceState]);}
}
