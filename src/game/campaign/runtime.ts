import { randomWord } from '../../engine/simulation/fixed.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { WALLS } from '../data/overlays.ts';
import { PRODUCTION, type ProductionCategory } from '../data/production.ts';
import { EconomyRuntime, type LiveBuilding } from '../simulation/economy-runtime.ts';
import type { GpuCombat } from '../simulation/combat-gpu.ts';
import { GUARD, GUARD_AREA, HUNT, MOVE, SLEEP, STICKY, HARVEST } from '../simulation/combat-state.ts';
import { DESTINATION } from '../simulation/lifecycle-gpu.ts';
import { distance } from '../coord.ts';
import type { CampaignScenario, CampaignTeam, CampaignTrigger } from './scenario.ts';
import type { campaignScene } from './scene.ts';
import { CampaignTriggers, type TriggerContext } from './triggers.ts';
import { canBuildCampaign } from './production.ts';
import { GpuNaval } from './naval.ts';
import { GpuTeamTargets } from './team-targets.ts';
import { GpuCampaignEvents, ATTACKED, DISCOVERED, DESTROYED, CAPTURED, ENTERED, EVACUATED, REMOVED, SABOTAGED, CLOAKED, BASE_PANIC, EVENT_WORDS } from './events.ts';
import { FactoryProduction, rawCost } from '../simulation/economy.ts';
import { GpuPlacementFlush } from '../ai/placement-gpu.ts';
import { placementOffsets } from '../simulation/building-rules.ts';
import { GpuBombers } from './bombers.ts';
import { ATTACK } from '../simulation/combat-state.ts';
import { ANIMATION_IDS } from '../data/combat.ts';
import { LOANER, PLAYER_ORDER } from '../simulation/units-state.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { SCRIPT_UNLOAD } from '../simulation/transport-cpu.ts';

interface TeamState { name: string; ids: number[]; order: number; issued: boolean; deadline: number;
  moving: boolean; hasBeen: boolean; forced: boolean; initiated: number[]; center: number; lagging: boolean; reforming: boolean; loaners: number[]; suspendedUntil?:number }
const ATTACK_MODES: Readonly<Record<string, number>> = { 'Attack Units': 0, 'Attack Base': 1, 'Attack Civil.': 2, Rampage: 3 };
// DEFINES.H, StructType: the INI's Built It number uses this order, not BDATA.CPP declaration order.
const BUILDING_ORDER = ['WEAP','GTWR','ATWR','OBLI','HQ','GUN','FACT','PROC','SILO','HPAD','SAM','AFLD','NUKE','NUK2','HOSP','PYLE','ARCO','FIX','BIO','HAND','TMPL','EYE','MISS'];
interface Arrival { trigger: string; ids: number[]; owner: number; transport?: number; team?: string; loaners: number[] }
interface FactoryOrder { owner: number; item: FactoryProduction; retry: number; pending?: { id: number; generation: number } }

/** Campaign houses use map teams and triggers; the skirmish commander never participates. */
export class CampaignRuntime extends EconomyRuntime {
  readonly triggers: CampaignTriggers;
  private readonly naval: GpuNaval;
  private readonly targeting: GpuTeamTargets;
  private readonly teams: TeamState[] = [];
  private readonly arrivals: Arrival[] = [];
  private readonly recruited = new Set<number>();
  private readonly events: GpuCampaignEvents;
  private eventReport?: Int32Array;
  private readonly discovered = new Set<number>();
  private readonly evacuated = new Set<number>();
  private readonly justBuilt = new Map<number, number>();
  private readonly production = new Set<number>();
  private readonly alerted = new Set<number>();
  private blockage = 0;
  private nextTeam = 90;
  private readonly nextAlert = new Map<number, number>();
  private readonly factoriesAI = new Map<number, FactoryOrder>();
  private readonly placementAI?: GpuPlacementFlush;
  private readonly bombers?: GpuBombers;
  sabotaged: string | undefined;
  templeIoned = false;
  private readonly collectedCrates=new Set<number>();
  readonly nukePieces=[7,7,7,7];
  private result: number | undefined;
  private pendingResult: { winner: number; at: number } | undefined;
  override get outcome() { return this.result; }
  override get extraSimulationBuffers() { return [this.naval.state, this.events.previous, this.events.result, ...this.targeting.buffers, ...(this.placementAI ? [this.placementAI.cooldown] : []), ...(this.bombers ? [this.bombers.state] : [])]; }
  override get trackedActors() {
    const candidates = new Set(this.teams.flatMap(team => this.mission.teams.find(type => type.name === team.name)!.members.map(member => member.type)));
    return [...new Set([...this.teams.flatMap(team => team.ids), ...this.arrivals.flatMap(arrival => arrival.ids),
      ...Array.from(this.health.keys()).filter(id => this.health[id] > 0 && candidates.has(MOVEMENT[this.types[id]].name))])];
  }
  constructor(battle: GpuCombat, readonly world: ReturnType<typeof campaignScene>, readonly mission: CampaignScenario) {
    super(battle, world);
    this.supers.campaign=true;
    this.naval = new GpuNaval(battle, world.navalMap);
    this.targeting = new GpuTeamTargets(battle);
    this.events = new GpuCampaignEvents(battle);
    if (mission.triggers.some(trigger => trigger.action === 'Airstrike') || mission.teams.some(team => team.members.some(member => member.type === 'A10'))) this.bombers = new GpuBombers(battle);
    this.supers.onAirstrike = (owner, cell) => this.launchAirstrike(owner, cell);
    if (mission.base.length || mission.triggers.some(trigger => trigger.action === 'Production')) {
      this.placementAI = new GpuPlacementFlush(battle);
      this.onBaseAttacked = (owner, enemy) => { if (owner === 1) this.placementAI!.respond(owner,enemy); };
    }
    this.blockage = mission.triggers.filter(trigger => trigger.house === mission.player && trigger.action === 'Allow Win').length;
    this.triggers = new CampaignTriggers(mission.triggers, (trigger,event,context) => this.action(trigger,event,context),
      { objects: mission.objectTriggers, cells: mission.cellTriggers }, trigger => {
        if (trigger.house === mission.player && trigger.action === 'Allow Win') {
          this.blockage = Math.max(0, this.blockage - 1);
          if (this.pendingResult) this.pendingResult.at = this.frame + 60;
        }
      });
    for (const house of this.houses) house.queues.canProduce = (type, faction) => canBuildCampaign(type, faction, house.faction, house.factories, mission.buildLevel, house.owner === 0);
    this.onTick = () => this.campaignTick();
  }
  override async prepareForPlay() { await super.prepareForPlay(); await Promise.all([this.naval.prepare(), this.targeting.prepare(), this.events.prepare(), this.placementAI?.prepare(), this.bombers?.prepare()]); }
  protected override async observeTick() { this.eventReport = await this.events.read(); }
  protected override buildingOpened(building: LiveBuilding) { this.justBuilt.set(building.owner, BUILDING_ORDER.indexOf(building.type)); }
  protected override buildingDebris(building:LiveBuilding){
    // BUILDING.CPP Drop_Debris: Chan escapes the Nod 10 technology center with the CHAN trigger.
    if(building.type!=='MISS'||this.mission.player!=='BadGuy'||this.mission.buildLevel!==10)return;
    const id=this.freeSlot();if(id<0)return;
    const shape=BUILDINGS.get(building.type)!,cell=building.cell+Math.trunc(shape.height/2)*this.width+Math.trunc(shape.width/2);
    const health=5+randomWord(this.battle.setup.seed,this.frame,building.id,670)%(MOVEMENT[movementType('CHAN')].strength-4);
    this.pending.push({id,name:'CHAN',cell,owner:building.owner,faction:building.faction,generation:this.generations[id]+1,silent:true});
    const offsets=[-this.width,1-this.width,1,this.width+1,this.width,this.width-1,-1,-this.width-1];
    const destination=cell+offsets[randomWord(this.battle.setup.seed,this.frame,id,671)%8];
    this.lifecycle.create(id,{type:movementType('CHAN'),cell,health,owner:building.owner},{ignore:building.id,mission:GUARD_AREA,destination});
    this.triggers.attachObject(id,'CHAN');
  }
  protected override superAvailable(kind: 'ion' | 'nuke', available: boolean) {
    const charge = this.supers.charges[this.owner][kind];
    if (kind === 'ion') return charge.present && charge.oneTime || available && this.owner === 0 && this.faction === 1;
    charge.oneTime = true;
    if(charge.spent)this.nukePieces[this.owner]=0;
    return available && this.nukePieces[this.owner]===7 && !charge.spent;
  }
  override beginTick() { if (!super.beginTick()) return false; this.targeting.step(); this.naval.step(); this.bombers?.step(); return true; }
  private houseOwner(name: string) { return this.world.houseNames.indexOf(name); }
  private campaignTick() {
    this.processEvents();
    if (this.pendingResult && this.frame >= this.pendingResult.at && (this.pendingResult.winner !== 0 || this.blockage === 0)) { this.result = this.pendingResult.winner; return; }
    for (let i = this.arrivals.length - 1; i >= 0; i--) {
      const arrival = this.arrivals[i];
      if (!arrival.ids.every(id => this.actorDetail(id))) continue;
      if (arrival.transport === undefined ? arrival.ids.some(id => this.health[id] > 0) : this.health[arrival.transport] > 0) {
        const definition = this.mission.triggers.find(trigger => trigger.name === arrival.trigger)!;
        const state=this.triggers.state[this.mission.triggers.indexOf(definition)];
        if (state.persistence === 0) this.triggers.remove(arrival.trigger);
        else if(definition.event==='Time')state.remaining=definition.data;
        if (arrival.owner === 0) this.onEvent?.('reinforcements', 0);
        if(arrival.team){
          const members=arrival.ids.filter(id=>this.health[id]>0&&MOVEMENT[this.types[id]].name!=='LST');
          this.teams.push(this.newTeam(arrival.team,members,true,arrival.loaners));
        }
      }
      this.arrivals.splice(i, 1);
    }
    const houses = ['GoodGuy', 'BadGuy', 'Neutral', 'Special'].map(name => {
      const owner = this.houseOwner(name), house = this.houses[owner];
      let buildings = 0, units = 0, factories = 0;
      for (let type = 0; type < MOVEMENT.length; type++) {
        const quantity = this.inventory[owner * MOVEMENT.length + type], unit = MOVEMENT[type];
        if (unit.domain === 2) {
          if (!WALLS[unit.name]) buildings += quantity;
          if (['AFLD', 'HAND', 'WEAP', 'PYLE'].includes(unit.name)) factories += quantity;
        } else if (!['BOAT', 'TRAN', 'C17', 'A10'].includes(unit.name)) units += quantity;
      }
      return { name, buildings, units, factories, credits: house.economy.credits, buildingsLost: house.buildingsLost, unitsLost: house.lost,
        discovered: this.discovered.has(owner), evacuated: this.evacuated.has(owner), justBuilt: this.justBuilt.get(owner) };
    });
    this.triggers.tick(this.frame, houses);
    for (const house of houses) { const owner = this.houseOwner(house.name); if (!house.discovered) this.discovered.delete(owner); if (house.justBuilt === undefined) this.justBuilt.delete(owner); }
    this.createHouseTeams();
    this.advanceTeams();
    this.advanceFactories();
    this.advanceAirstrikes();
  }
  private advanceAirstrikes() {
    for (let owner=0;owner<this.houses.length;owner++) {
      const charge=this.supers.charges[owner].airstrike;
      if(charge.step(this.frame,charge.present,true))this.onEvent?.('airready',owner);
      if(owner!==0&&charge.ready){
        const target=[...this.buildings.values()].filter(building=>building.owner===0&&building.health>0).sort((a,b)=>PRODUCTION.get(b.type)!.cost-PRODUCTION.get(a.type)!.cost||a.id-b.id)[0];
        if(target)this.supers.fire(owner,'airstrike',target.cell,this.frame,[...this.buildings.values()]);
      }
    }
  }
  private entryCell(owner: number, id: number, flying: boolean) {
    const bounds=this.mission.scenario,edge=this.mission.houses.find(house=>house.name===this.world.houseNames[owner])!.edge.toLowerCase();
    const vertical=edge==='east'||edge==='west',size=vertical?bounds.height:bounds.width;
    const start=randomWord(this.battle.setup.seed,this.frame,id,601)%size;
    for(let offset=0;offset<size;offset++){
      const n=(start+offset)%size;
      const x=vertical?(edge==='west'?bounds.x-1:bounds.x+bounds.width):bounds.x+n;
      const y=vertical?bounds.y+n:(edge==='south'?bounds.y+bounds.height:bounds.y-1);
      const cell=y*this.width+x,inside=cell+(edge==='south'?-this.width:edge==='east'?-1:edge==='west'?1:this.width);
      if(flying||this.world.navalMap.clear[cell]&&this.world.passable[inside])return {cell,inside,facing:edge==='south'?0:edge==='east'?192:edge==='west'?64:128};
    }
    return undefined;
  }
  private launchAirstrike(owner: number, target: number) {
    const count=Math.max(1,Math.min(3,Math.trunc(this.mission.buildLevel/3)));
    for(let index=0;index<count;index++){
      const id=this.freeSlot();if(id<0)break;
      const entry=this.entryCell(owner,id,true)!;
      this.pending.push({id,name:'A10',owner,cell:entry.cell,faction:this.houses[owner].faction,generation:this.generations[id]+1,silent:true});
      this.lifecycle.create(id,{type:movementType('A10'),cell:entry.cell,owner,altitude:24,facing:0},{mission:ATTACK,target:-target-2});
    }
  }
  private processEvents() {
    const events = this.eventReport; this.eventReport = undefined;
    if(events?.some((value,index)=>index%EVENT_WORDS===0&&!!(value&BASE_PANIC))){
      // Ported from TEAM.CPP Suspend_Teams(20): release all lower-priority
      // teams, including their members, for two original game minutes.
      for(const team of this.teams)if(this.mission.teams.find(type=>type.name===team.name)!.priority<20){
        for(const id of team.ids)this.recruited.delete(id);
        team.ids=[];team.initiated=[];team.suspendedUntil=this.frame+1800;
      }
    }
    if (!events) return;
    for (let id = 0; id < events.length / EVENT_WORDS; id++) {
      const at=id*EVENT_WORDS,flags = events[at] & 255, owner = events[at] >>> 8 & 15, house = this.world.houseNames[owner];
      const cell=events[at+2],crate=this.world.crates.get(cell);
      if(crate&&!this.collectedCrates.has(cell)){
        this.collectedCrates.add(cell);this.onSceneryVisibility?.(crate.sprite,false);
        const nod=this.world.houseNames[owner]==='BadGuy';
        if(!crate.steel)this.houses[owner].economy.refund(2000);
        else if(nod){const pieces=this.nukePieces[owner];this.nukePieces[owner]|=!(pieces&4)?4:!(pieces&2)?2:1;this.supers.charges[owner].nuke.spent=false;}
        if(!crate.steel||nod)this.animations.push({kind:ANIMATION_IDS[crate.steel?'ANIM_CRATE_EMPULSE':'ANIM_CRATE_DOLLAR'],x:cell%this.width*256+128,y:Math.trunc(cell/this.width)*256+128});
      }
      if (!flags) continue;
      if(flags&SABOTAGED)this.sabotaged=MOVEMENT[this.types[id]].name;
      if(flags&DESTROYED&&MOVEMENT[this.types[id]].domain===2)this.templeIoned=MOVEMENT[this.types[id]].name==='TMPL'&&(events[at+1]>>>16)-2===5;
      // TECHNO.CPP Captured springs PlayerEntered before its Record_The_Kill call.
      if (flags & CAPTURED) this.triggers.object(id, 'Player Enters', house);
      if (flags & ATTACKED) this.triggers.object(id, 'Attacked', house);
      if (flags & DISCOVERED || flags & DESTROYED && flags & ATTACKED) { this.triggers.object(id, 'Discovered', house); if (owner !== 0) this.discovered.add(owner); }
      if (flags & (DESTROYED | CAPTURED)) this.triggers.object(id, 'Destroyed', house);
      if (flags & (DESTROYED | REMOVED)) this.triggers.objects.delete(id);
      if (flags & (DESTROYED | REMOVED)) this.health[id] = 0;
      if(flags&CAPTURED)this.owners[id]=events[at]>>>12&15;
      if (flags & ENTERED) {
        if(!(events[at]&CLOAKED))this.triggers.cell(events[at+1]&65535, house);
      }
      if (flags & EVACUATED) this.evacuated.add(owner);
    }
  }
  private win() { if (!this.pendingResult) this.pendingResult = { winner: 0, at: this.frame + 15 }; }
  private lose() { if (this.pendingResult?.winner !== 1) this.pendingResult = { winner: 1, at: this.frame + 15 }; }
  private action(trigger: CampaignTrigger, event: string, context: TriggerContext): boolean {
    const type = this.mission.teams.find(team => team.name === trigger.team);
    switch (trigger.action) {
      case 'Win': this.win(); return true;
      case 'Lose': this.lose(); return true;
      case 'Allow Win': return true;
      case "DZ at 'Z'": {
        const cell=this.mission.scenario.waypoints.get(25);
        if(cell!==undefined)this.animations.push({kind:ANIMATION_IDS.ANIM_LZ_SMOKE,x:cell%this.width*256+128,y:Math.trunc(cell/this.width)*256+128});return true;
      }
      case 'Nuclear Missile': case 'Ion Cannon': {
        const kind=trigger.action==='Ion Cannon'?'ion':'nuke',owner=this.houseOwner(kind==='ion'?'GoodGuy':'BadGuy');
        this.supers.charges[owner][kind].grant(this.frame,true);if(owner===0)this.onEvent?.(kind==='ion'?'ionready':'nukeready',owner);return true;
      }
      case 'Airstrike': {
        const owner=context.kind==='cell'?this.houseOwner(trigger.house):0,charge=this.supers.charges[owner].airstrike;
        const charged=context.kind==='object'?!charge.present:owner===0&&this.houseOwner(trigger.house)===0;
        charge.grant(this.frame,false,charged);if(charged)this.onEvent?.('airready',owner);return true;
      }
      case 'Cap=Win/Des=Lose':
        if (event === 'Player Enters') { this.win(); return true; }
        if (event === 'Destroyed') { if (this.pendingResult?.winner !== 0 || this.blockage) this.lose(); return true; }
        return false;
      case "Dstry Trig 'XXXX'": case "Dstry Trig 'YYYY'": case "Dstry Trig 'ZZZZ'": this.triggers.remove(trigger.action.slice(-5, -1)); return true;
      case 'Production': this.production.add(context.kind === 'cell' ? 1 : this.houseOwner(trigger.house)); return true;
      case 'Autocreate':
        if (context.kind === 'cell') for (let owner = 0; owner < this.houses.length; owner++) this.alerted.add(owner);
        else this.alerted.add(this.houseOwner(context.kind === 'object' ? context.house : trigger.house));
        return true;
      case 'All to Hunt':
        for (let id = 0; id < this.health.length; id++) if (this.health[id] > 0 && this.owners[id] !== 0 && MOVEMENT[this.types[id]].domain === 0) {
          this.recruited.delete(id); for (const team of this.teams) team.ids = team.ids.filter(member => member !== id); this.lifecycle.order(id, HUNT);
        }
        return true;
      case 'Dstry Teams':
        for (let index = this.teams.length - 1; index >= 0; index--) if (this.teams[index].name === trigger.team) {
          for (const id of this.teams[index].ids) this.recruited.delete(id); this.teams.splice(index, 1);
        }
        return true;
      case 'Create Team': if (type) this.createTeam(type,true); return true;
      case 'Reinforce.': return !type || this.reinforce(type, trigger.name);
      case 'None': return true;
      default: throw new Error(`Campaign action not implemented: ${trigger.action}`);
    }
  }
  /** TEAM.CPP Recruit/Add: area guards and hunters do not leave their assigned posts. */
  private createTeam(type: CampaignTeam, force=false) {
    if (!force&&this.teams.filter(team => team.name === type.name).length >= type.maximum) return;
    const team = this.newTeam(type.name); this.teams.push(team); this.recruitTeam(team, type);
  }
  private newTeam(name: string, ids: number[] = [], forced = false, loaners:number[]=[]): TeamState {
    for (const id of ids) this.recruited.add(id);
    return { name, ids, order: 0, issued: false, deadline: 0, moving: false, hasBeen: false, forced, initiated: ids.slice(0,1), center: -1, lagging: false, reforming: false, loaners };
  }
  private recruitTeam(team: TeamState, type: CampaignTeam) {
    const owner = this.houseOwner(type.house);
    for (const member of type.members) {
      let remaining = member.count - team.ids.filter(id => MOVEMENT[this.types[id]].name === member.type).length;
      for (let id = 0; id < this.battle.setup.units.length && remaining; id++) {
        const detail = this.actorDetail(id), mission = detail ? detail[6] >> 1 : this.battle.setup.missions?.[id] ?? GUARD;
        if (this.health[id] <= 0 || this.owners[id] !== owner || MOVEMENT[this.types[id]].name !== member.type || detail && detail[6] & 1 || [GUARD_AREA,HUNT,SLEEP,STICKY,HARVEST].includes(mission) || member.type === 'HARV' || team.ids.includes(id)) continue;
        const other = this.teams.find(candidate => candidate.ids.includes(id));
        if (other) {
          if (this.mission.teams.find(candidate => candidate.name === other.name)!.priority >= type.priority) continue;
          other.ids = other.ids.filter(member => member !== id); other.initiated = other.initiated.filter(member => member !== id);
        }
        if (!team.ids.length) team.initiated.push(id);
        team.ids.push(id); this.recruited.add(id); remaining--;
      }
    }
  }
  /** HOUSE.CPP AI and TEAMTYPE.CPP Suggested_New_Team. */
  private createHouseTeams() {
    const suggest = (owner: number, alerted: boolean) => {
      let best: CampaignTeam | undefined, value = -1;
      for (const type of this.mission.teams) {
        if (this.houseOwner(type.house) !== owner || type.autocreate && !alerted || this.teams.filter(team => team.name === type.name).length >= type.maximum) continue;
        const present = type.members.some(member => this.inventory[owner * MOVEMENT.length + movementType(member.type)] > 0);
        const score = present ? type.priority : Math.trunc(type.priority / 2);
        if (!best || score > value) { best = type; value = score; }
      }
      if (best) this.createTeam(best);
    };
    for (const owner of this.alerted) if (this.frame >= (this.nextAlert.get(owner) ?? 0)) {
      const maximum = Math.max(2, Math.trunc((this.mission.buildLevel - 1) / 3) + 1);
      const count = 2 + randomWord(this.battle.setup.seed, this.frame, owner, 650) % (maximum - 1);
      for (let index = 0; index < count; index++) suggest(owner, true);
      this.nextAlert.set(owner, this.frame + (5 + randomWord(this.battle.setup.seed, this.frame, owner, 651) % 16) * 900);
    }
    if (this.frame >= this.nextTeam) { for (let owner = 0; owner < this.houses.length; owner++) suggest(owner, false); this.nextTeam = this.frame + 90; }
  }
  private near(id: number, cell: number) {
    const detail = this.actorDetail(id)!;
    return Math.trunc(distance(detail[8], detail[9], cell % this.width * 256 + 128, Math.trunc(cell / this.width) * 256 + 128) / 256) <= 2;
  }
  /** HOUSE.CPP Suggest_New_Object: active teams and prebuilt reserves drive production. */
  private suggestObject(owner: number, category: ProductionCategory) {
    const definition=this.mission.houses.find(house=>house.name===this.world.houseNames[owner])!,building=category==='building';
    let current=0;
    for(let type=0;type<MOVEMENT.length;type++)if((MOVEMENT[type].domain===2)===building&&!WALLS[MOVEMENT[type].name])current+=this.inventory[owner*MOVEMENT.length+type];
    for(const job of this.factoriesAI.values())if(job.owner===owner&&(job.item.type.category==='building')===building)current++;
    if(current>=(building?definition.maxBuildings:definition.maxUnits))return;
    const baseMissing = (name?: string) => this.mission.base.find(node => (!name || node.type === name)
      && ![...this.buildings.values()].some(building => building.health > 0 && building.cell === node.cell && building.type === node.type));
    if (category === 'building') return owner === 1 ? baseMissing()?.type : undefined;
    if (category === 'aircraft') return;
    if (category === 'vehicle' && this.mission.buildLevel >= 7 && this.inventory[owner*MOVEMENT.length+movementType('PROC')]
      && !this.inventory[owner*MOVEMENT.length+movementType('HARV')]) return 'HARV';
    const counters = new Map<string, number>();
    for (const team of this.teams) {
      const type = this.mission.teams.find(type => type.name === team.name)!;
      if (this.houseOwner(type.house) !== owner) continue;
      const full = team.ids.length === type.members.reduce((sum,member)=>sum+member.count,0);
      if (full && (category === 'vehicle' || !type.reinforcable)) continue;
      for (const member of type.members) if (PRODUCTION.get(member.type)?.category === category)
        counters.set(member.type, category === 'vehicle' ? 1 : (counters.get(member.type) ?? 0) + member.count + 1);
    }
    for (const team of this.mission.teams) if (this.houseOwner(team.house) === owner && team.prebuilt && (!team.autocreate || this.alerted.has(owner))) {
      for (const member of team.members) if (PRODUCTION.get(member.type)?.category === category) {
        const desired = Math.max(counters.get(member.type) ?? 0,member.count);
        counters.set(member.type,category === 'infantry' ? Math.min(5,desired) : desired);
      }
    }
    for (let id=0;id<this.health.length;id++) if (this.health[id]>0 && this.owners[id]===owner && !this.recruited.has(id)) {
      const mission = this.actorDetail(id) ? this.actorDetail(id)![6]>>1 : this.battle.setup.missions?.[id] ?? GUARD;
      if ([GUARD_AREA,HUNT,SLEEP,STICKY].includes(mission)) continue;
      const name=MOVEMENT[this.types[id]].name; counters.set(name,(counters.get(name)??0)-1);
    }
    let maximum=-1;const choices:string[]=[];
    for (const movement of MOVEMENT) {
      const count=counters.get(movement.name)??0,type=PRODUCTION.get(movement.name),house=this.houses[owner];
      if (!type || count<=0 || type.category!==category || type.cost>house.economy.money || !canBuildCampaign(type,house.faction,house.faction,house.factories,this.mission.buildLevel,false)) continue;
      // Original appends every later positive candidate until a new maximum clears the list.
      if (count>maximum) { maximum=count;choices.length=0; } choices.push(type.name);
    }
    return choices.length ? choices[randomWord(this.battle.setup.seed,this.frame,owner,660+(category==='vehicle'?0:1))%choices.length] : undefined;
  }
  /** BUILDING.CPP AI/Exit_Object: each computer factory owns an independent production job. */
  private advanceFactories() {
    for (const [id,order] of this.factoriesAI) {
      const building=this.buildings.get(id);
      if (!building || !building.active || building.owner!==order.owner || building.health<=0) { order.item.abandon();this.factoriesAI.delete(id); }
    }
    for (const building of this.buildings.values()) {
      const owner=building.owner,type=PRODUCTION.get(building.type)!;
      if (owner===0 || !building.active || building.selling || building.health<=0) continue;
      const house=this.houses[owner],threshold=this.mission.buildLevel>10?192:this.mission.buildLevel>6?128:64;
      if (type.repairable && building.health*256<=type.strength*threshold && house.economy.money>=1000) building.repairing=true;
      const category=type.factory; if (!category) continue;
      let order=this.factoriesAI.get(building.id);
      if (order?.pending) {
        if (this.generations[order.pending.id]===order.pending.generation) { this.factoriesAI.delete(building.id);order=undefined; }
        else { order.pending=undefined;order.retry=this.frame+45; }
      }
      if (!order && this.production.has(owner) && house.economy.money>10) {
        const name=this.suggestObject(owner,category),product=name&&PRODUCTION.get(name);
        if (!product) continue;
        const item=category==='building'?new FactoryProduction(product,house.economy,false,Math.trunc((rawCost(product)+2000)/2)):new FactoryProduction(product,house.economy);
        if (!item.start()) continue;
        order={owner,item,retry:0};this.factoriesAI.set(building.id,order);
      }
      if (!order) continue;
      if (!order.item.complete) { order.item.step(1);continue; }
      if (this.frame<order.retry) continue;
      const before=this.pending.length,name=order.item.type.name;
      this.withOwner(owner,()=>{
        if (category==='building') {
          const node=this.mission.base.find(node=>node.type===name&&!Array.from(this.buildings.values()).some(b=>b.health>0&&b.cell===node.cell&&b.type===name));
          if (!node) { order!.item.abandon();this.factoriesAI.delete(building.id);return; }
          if (!placementOffsets(name).every(([x,y])=>{const cell=node.cell+y*this.width+x;return this.scene.buildable[cell]&&this.placement.occupied[cell]<0;})) { order!.retry=this.frame+45;return; }
          this.placementAI?.flush(owner,name,node.cell);
          const id=this.freeSlot();if(id>=0)this.createBuilding(name,node.cell,id,house.faction);
        } else if (building.type==='AFLD') this.spawnDelivery(name,building);
        else this.spawnNear(name,building);
      });
      const pending=this.pending[before];
      if (pending) order.pending={id:pending.id,generation:pending.generation};else order.retry=this.frame+45;
    }
  }
  private regroup(team: TeamState,center=team.center) {
    let ready = true;
    for (const id of team.ids) {
      const detail = this.actorDetail(id)!; if (detail[6] & 1) continue;
      if (!this.near(id, center)) { if (detail[7] !== center) this.lifecycle.order(id, MOVE, -1, center); ready = false; }
      else { if (!team.initiated.includes(id)) team.initiated.push(id); if (detail[6] >> 1 !== GUARD_AREA && (detail[6] >> 1 !== GUARD||detail[7]>=0)) this.lifecycle.order(id, GUARD); }
    }
    return ready;
  }
  private advanceTeams() {
    for (let index = 0; index < this.teams.length; index++) {
      const team = this.teams[index];
      if(this.frame<(team.suspendedUntil??0))continue;
      const type = this.mission.teams.find(type => type.name === team.name)!;
      const owner = this.houseOwner(type.house), desired = type.members.reduce((sum, member) => sum + member.count, 0);
      team.ids = team.ids.filter(id => { if (this.health[id] > 0 && this.owners[id] === owner && !(owner===0&&(this.actorDetail(id)?.[12]??0)&PLAYER_ORDER)) return true; this.recruited.delete(id); return false; });
      team.initiated = team.initiated.filter(id => team.ids.includes(id));
      if (!team.initiated.length && team.ids.length) team.initiated.push(team.ids.at(-1)!);
      const full = team.ids.length === desired, under = owner !== 0 && (type.reinforcable ? team.ids.length <= Math.trunc(desired / 3) : !team.hasBeen);
      if (team.moving && under) { team.moving = false; team.order = 0; team.issued = false; team.reforming = true; }
      if (!team.moving && (full || team.forced)) {
        this.targeting.gesture(team.ids,randomWord(this.battle.setup.seed,this.frame,index,720)%2);
        team.moving = team.hasBeen = true; team.order = 0; team.issued = false; team.initiated = [...team.ids]; team.forced = false;
      }
      if (!team.moving || !full && type.reinforcable && owner !== 0) this.recruitTeam(team,type);
      const order = type.orders[team.order];
      // TEAM.CPP destructor leaves the final orders in place.
      if (!order || !team.ids.length && (team.hasBeen || owner === 0)) { for (const id of team.ids) this.recruited.delete(id); this.teams.splice(index--, 1); continue; }
      if (!team.ids.length || team.ids.some(id => !this.actorDetail(id))) continue;
      const centered = team.initiated.filter(id => !(this.actorDetail(id)![6] & 1));
      if (!centered.length) continue;
      team.center = Math.trunc(centered.reduce((sum,id)=>sum+this.actorDetail(id)![2]%this.width,0)/centered.length)
        + Math.trunc(centered.reduce((sum,id)=>sum+Math.trunc(this.actorDetail(id)![2]/this.width),0)/centered.length)*this.width;
      // TEAM.CPP Coordinate_Conscript: replacements join the center before taking team orders.
      for(const id of team.ids)if(!team.initiated.includes(id)&&!(this.actorDetail(id)![6]&1)){
        if(this.near(id,team.center))team.initiated.push(id);
        else if(this.actorDetail(id)![7]<0)this.lifecycle.order(id,MOVE,-1,team.center);
      }
      if(!team.moving&&team.hasBeen)continue;
      if (!team.moving || team.reforming) { team.reforming = !this.regroup(team); continue; }
      if (!team.issued) team.deadline = this.frame + order.argument * 90;
      if (order.mission === 'Move') {
        const target = this.mission.scenario.waypoints.get(order.argument);
        if (target === undefined) { team.order++; team.issued = false; continue; }
        if (team.lagging) {
          // TEAM.CPP Calc_Center/Lagging_Units: use the member nearest the objective.
          let objective=team.center,best=0x7fffffff;
          for(const id of [...centered].reverse()){const cell=this.actorDetail(id)![2],d=distance(cell%this.width,Math.trunc(cell/this.width),target%this.width,Math.trunc(target/this.width));if(d<best){best=d;objective=cell;}}
          team.lagging = !this.regroup(team,objective); continue;
        }
        if (team.initiated.some(id => !(this.actorDetail(id)![6] & 1) && MOVEMENT[this.types[id]].domain !== 1 && !this.near(id,team.center))) { team.lagging = true; continue; }
        const fighting=team.initiated.some(id=>this.actorDetail(id)![6]>>1===ATTACK&&this.actorDetail(id)![10]>=0);
        if(fighting)continue;
        for (const id of team.initiated) if (!(this.actorDetail(id)![6] & 1) && (!this.near(id,target)||this.actorDetail(id)![11]>0&&type.orders[team.order+1]?.mission!=='Move') && this.actorDetail(id)![7] !== target) this.lifecycle.order(id,MOVE,-1,target);
        team.issued = true;
        if (team.initiated.every(id => this.actorDetail(id)![6] & 1 || this.near(id,target)&&(this.actorDetail(id)![11]===0||type.orders[team.order+1]?.mission==='Move'))) { team.order++; team.issued = false; }
      } else if (order.mission in ATTACK_MODES) {
        if (team.issued && (this.frame >= team.deadline || this.actorDetail(team.ids.at(-1)!)![10] < 0)) { team.order++; team.issued = false; }
        else team.issued = true;
      } else if (order.mission === 'Guard') {
        this.regroup(team); team.issued = true;
        if (this.frame >= team.deadline) { team.order++; team.issued = false; }
      } else if (order.mission === 'Loop') {
        team.order = order.argument; team.issued = false;
      } else if (order.mission === 'Unload') {
        if (!team.issued) {
          const pending = this.battle.movement.pending.array as Int32Array;
          for (const id of team.ids) if (['APC','TRAN'].includes(MOVEMENT[this.types[id]].name)) { pending[id*2]=SCRIPT_UNLOAD;pending[id*2+1]=this.mission.scenario.waypoints.get(order.argument)??-1; this.battle.movement.pending.addUpdateRange(id*2,2); this.battle.movement.pending.needsUpdate=true; }
          team.ids=team.ids.filter(id=>{if(!team.loaners.includes(id))return true;this.recruited.delete(id);return false;});
          team.issued = true;
        }
        if (this.frame >= team.deadline || team.ids.every(id => !(this.actorDetail(id)![6] & 1))) { team.order++; team.issued = false; }
      }
    }
    const attacks = this.teams.filter(team => {const mission=this.mission.teams.find(type=>type.name===team.name)?.orders[team.order]?.mission;return !team.moving&&team.hasBeen||team.moving&&!team.reforming&&mission&&(mission in ATTACK_MODES||mission==='Move');});
    this.targeting.set(attacks.map(team => team.ids.filter(id => team.initiated.includes(id))),
      attacks.map(team => !team.moving?-2:ATTACK_MODES[this.mission.teams.find(type => type.name === team.name)!.orders[team.order].mission]??-1),
      attacks.map(team=>`${team.name}:${team.order}`),attacks.map(team=>this.mission.teams.find(type=>type.name===team.name)!.suicide));
    this.battle.movement.routing?.setTeams(this.teams.filter(team=>this.mission.teams.find(type=>type.name===team.name)!.roundabout).map(team=>team.ids),this.generations);
  }
  private reinforce(type: CampaignTeam, trigger: string) {
    if (this.arrivals.some(arrival => arrival.trigger === trigger)) return false;
    const start = this.pending.length, owner = this.houseOwner(type.house), faction = this.houses[owner].faction;
    const names = type.members.flatMap(member => Array<string>(member.count).fill(member.type)), ids: number[] = [];
    for (const name of names) {
      const id = this.freeSlot();
      if (id < 0) { this.pending.splice(start); return false; }
      ids.push(id); this.pending.push({ id, name, owner, faction, cell: 0, generation: this.generations[id] + 1, silent: true });
    }
    const transportIndex = names.reduce((found,name,index)=>['LST','TRAN','APC'].includes(name)?index:found,-1), transport = transportIndex >= 0 ? ids[transportIndex] : undefined;
    const naval=transportIndex>=0&&names[transportIndex]==='LST',flying=names.some(name=>MOVEMENT[movementType(name)].domain===1);
    const entry=this.entryCell(owner,ids[0],flying);
    if(!entry&&!naval){this.pending.splice(start);return false;}
    for (let i = 0; i < ids.length; i++) {
      const attached = transport !== undefined && ids[i] !== transport ? transport + 1 : 0;
      const loaner=names[i]==='A10'||names[i]==='LST'||names[i]==='TRAN'&&names.length>1;
      this.lifecycle.create(ids[i], { type: movementType(names[i]), cell: naval ? 0 : entry!.cell, owner, attached, facing: naval ? 0 : flying?192:entry!.facing, flags: loaner?LOANER:0,
        altitude: MOVEMENT[movementType(names[i])].domain===1?24:0 },
        naval || attached ? { mission: GUARD } : names[i]==='A10'?{mission:HUNT}:{ mission: MOVE, destination:entry!.inside, direct:!flying });
    }
    // Wait for the creation report before enrolling actors: their CPU health is
    // still zero until then. LST passengers form a team without the carrier.
    this.arrivals.push({ trigger, ids, owner, transport, team:type.orders.length?type.name:undefined,
      loaners:transport!==undefined&&names[transportIndex]==='TRAN'&&names.length>1?[transport]:[] });
    // The next existing economic report confirms creation; a failed landing retains the trigger.
    return false;
  }
  saveCampaign() { return { triggers: this.triggers.state.map(state => ({ ...state })), nextTime: this.triggers.nextTime,
    objectTriggers: [...this.triggers.objects], cellTriggers: [...this.triggers.cells], eventReport: this.eventReport && Array.from(this.eventReport),
    discovered: [...this.discovered], evacuated: [...this.evacuated], justBuilt: [...this.justBuilt], production: [...this.production], alerted: [...this.alerted], blockage: this.blockage,
    nextTeam: this.nextTeam, nextAlert: [...this.nextAlert], targeting:this.targeting.saveMeta(),
    sabotaged: this.sabotaged, templeIoned: this.templeIoned,
    collectedCrates:[...this.collectedCrates],nukePieces:[...this.nukePieces],
    factories: [...this.factoriesAI].map(([id,order])=>({id,owner:order.owner,retry:order.retry,pending:order.pending,type:order.item.type.name,
      stage:order.item.stage,rate:order.item.rate,timer:order.item.timer,balance:order.item.balance,suspended:order.item.suspended,duration:order.item.duration})),
    teams: structuredClone(this.teams), arrivals: structuredClone(this.arrivals), recruited: [...this.recruited], result: this.result, pendingResult: this.pendingResult && { ...this.pendingResult } }; }
  loadCampaign(state: ReturnType<CampaignRuntime['saveCampaign']>) {
    this.targeting.loadMeta(state.targeting);
    this.triggers.state.splice(0, this.triggers.state.length, ...state.triggers); this.triggers.nextTime = state.nextTime;
    this.triggers.objects.clear(); for (const [id, trigger] of state.objectTriggers) this.triggers.objects.set(id, trigger);
    this.triggers.cells.clear(); for (const [cell, trigger] of state.cellTriggers) this.triggers.cells.set(cell, trigger);
    this.eventReport = state.eventReport && Int32Array.from(state.eventReport); this.blockage = state.blockage;
    this.sabotaged=state.sabotaged;this.templeIoned=state.templeIoned;
    this.collectedCrates.clear();for(const cell of state.collectedCrates)this.collectedCrates.add(cell);
    this.nukePieces.splice(0,this.nukePieces.length,...state.nukePieces);
    for(const [cell,crate] of this.world.crates)this.onSceneryVisibility?.(crate.sprite,!this.collectedCrates.has(cell));
    this.nextTeam = state.nextTeam; this.nextAlert.clear(); for (const [owner, frame] of state.nextAlert) this.nextAlert.set(owner,frame);
    this.factoriesAI.clear();for(const saved of state.factories){const item=new FactoryProduction(PRODUCTION.get(saved.type)!,this.houses[saved.owner].economy,false,saved.duration);
      Object.assign(item,{stage:saved.stage,rate:saved.rate,timer:saved.timer,balance:saved.balance,suspended:saved.suspended});this.factoriesAI.set(saved.id,{owner:saved.owner,retry:saved.retry,pending:saved.pending,item});}
    for (const [target, values] of [[this.discovered, state.discovered], [this.evacuated, state.evacuated], [this.production, state.production], [this.alerted, state.alerted]] as const) { target.clear(); for (const value of values) target.add(value); }
    this.justBuilt.clear(); for (const [owner, type] of state.justBuilt) this.justBuilt.set(owner, type);
    this.teams.splice(0, this.teams.length, ...state.teams); this.arrivals.splice(0, this.arrivals.length, ...state.arrivals);
    this.recruited.clear(); for (const id of state.recruited) this.recruited.add(id); this.result = state.result; this.pendingResult = state.pendingResult;
  }
  override dispose() { this.bombers?.dispose(); this.placementAI?.dispose(); this.events.dispose(); this.targeting.dispose(); this.naval.dispose(); super.dispose(); }
}
