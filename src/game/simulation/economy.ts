// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { PRODUCTION,PRODUCTION_TYPES, type ProductionCategory, type ProductionType } from '../data/production.ts';

/** HOUSE.CPP, Available_Money/Harvested/Spend_Money/Refund_Money/Adjust_Capacity. */
export class HouseEconomy {
  credits: number;
  tiberium = 0;
  capacity = 0;
  power = 0;
  drain = 0;
  harvested = 0;
  maxedOut = false;
  constructor(credits: number) { this.credits = credits; }
  get money() { return this.credits + this.tiberium; }
  get powerFraction() {
    return this.power ? this.drain ? Math.trunc(this.power * 256 / this.drain) : 256 : 0;
  }
  harvest(amount: number) {
    this.harvested += amount;
    this.maxedOut ||= this.tiberium + amount > this.capacity;
    this.tiberium = Math.min(this.capacity, this.tiberium + amount);
  }
  spend(amount: number) {
    const stored = Math.min(amount, this.tiberium);
    this.tiberium -= stored;
    this.credits -= amount - stored;
  }
  refund(amount: number) { this.credits += amount; }
  adjustCapacity(change: number, destroyed: boolean) {
    this.capacity = Math.max(0, this.capacity + change);
    const excess = Math.max(0, this.tiberium - this.capacity);
    this.tiberium -= excess;
    if (!destroyed) this.refund(excess);
    else this.maxedOut ||= excess > 0;
    return destroyed ? excess : 0;
  }
}

/** BDATA.CPP, BuildingTypeClass::Raw_Cost: exclude the bundled harvester or Orca. */
export function rawCost(type: ProductionType) {
  return type.cost - (type.name === 'PROC' ? PRODUCTION.get('HARV')!.cost :
    type.name === 'HPAD' ? PRODUCTION.get('ORCA')!.cost : 0);
}

/** BDATA.CPP, BuildingTypeClass::Cost_Of. IsSeparate only changes the helipad purchase. */
export function purchaseCost(type: ProductionType, separateAircraft = false) {
  return separateAircraft && type.name === 'HPAD' ? rawCost(type) : type.cost;
}

/** TECHNO.CPP Refund_Amount: the harvester's remaining cargo contributes one quarter. */
export function unitSaleRefund(type:ProductionType,load=0){
  const cargo=(700*Math.trunc(load*256/28)+128)>>8;
  return Math.trunc((rawCost(type)+Math.trunc(cargo/2))/2);
}

/** TECHNO.CPP, TechnoTypeClass::Time_To_Build, multiplayer branch. */
export function buildTime(type: ProductionType) {
  const cost = rawCost(type);
  return type.category === 'vehicle' && !(type.factions & 1) ? cost - Math.trunc(cost / 4) : cost;
}

export interface FactoryBuilding {
  type: string;
  /** Original factory nationality survives capture (BUILDING.CPP, ActLike). */
  faction: number;
  active: boolean;
}

/** HOUSE.CPP, Can_Build: prerequisite equivalences and the multiplayer technology limit. */
export function canBuild(type: ProductionType, faction: number, buildings: readonly FactoryBuilding[], level = 7) {
  if (!type.buildable || !(type.factions & faction) || type.level > level) return false;
  const present = new Set(buildings.filter(b => b.active).map(b => b.type));
  for (const [from, to] of [['NUK2', 'NUKE'], ['HAND', 'PYLE'], ['OBLI', 'ATWR'],
    ['TMPL', 'EYE'], ['AFLD', 'WEAP'], ['SAM', 'HPAD']]) if (present.has(from)) present.add(to);
  return type.prerequisites.every(name => present.has(name));
}

/** BDATA/UDATA/AADATA, Repair_Cost: fixed-point rounding matches COORDA.ASM. */
export function repairStep(type: ProductionType) {
  const health = type.category === 'building' ? 5 : type.category === 'aircraft' ? 2 : 4;
  if (type.category !== 'building') {
    const cost = Math.trunc(type.cost / Math.trunc(type.strength / health));
    return {health, cost: (cost * 102 + 128) >> 8};
  }
  const cost = Math.max(1, Math.trunc(Math.trunc(rawCost(type) * health / type.strength) / 2));
  return {health, cost: Math.max(1, (cost * 102 + 128) >> 8)};
}

export const FACTORY_STAGES = 108;

/** FACTORY.CPP and STAGE.H: one in-progress item per production category. */
export class FactoryProduction {
  stage = 0;
  rate = 0;
  timer = 0;
  balance: number;
  suspended = true;
  readonly purchasePrice: number;
  constructor(readonly type: ProductionType, readonly house: HouseEconomy, separateAircraft = false) {
    this.balance = this.purchasePrice = purchaseCost(type, separateAircraft);
  }
  get complete() { return this.stage === FACTORY_STAGES; }
  get costPerStep() {
    return this.complete ? this.balance : Math.trunc(this.balance / (FACTORY_STAGES - this.stage));
  }
  start() {
    if (!this.suspended || this.complete || this.house.money < this.costPerStep) return false;
    const fraction = Math.max(16, Math.min(256, this.house.powerFraction));
    this.rate = Math.max(1, Math.min(255, Math.trunc(Math.trunc(buildTime(this.type) * 256 / fraction) / FACTORY_STAGES)));
    this.timer = this.rate;
    this.suspended = false;
    return true;
  }
  suspend() { this.suspended = true; this.rate = this.timer = 0; }
  abandon() {
    this.house.refund(this.purchasePrice - this.balance);
    this.balance = 0;
    this.suspend();
  }
  step(factoryCount: number) {
    if (this.suspended) return;
    for (let i = 0; i < Math.max(1, factoryCount) && !this.complete; i++) {
      if (--this.timer) continue;
      this.timer = this.rate;
      this.stage++;
      const cost = Math.min(this.balance, this.costPerStep);
      if (cost > this.house.money) this.stage--;
      else { this.house.spend(cost); this.balance -= cost; }
      if (this.complete) {
        this.house.spend(this.balance);
        this.balance = 0;
        this.suspend();
      }
    }
  }
}

/** HOUSE.CPP, Begin_Production/Suspend_Production/Abandon_Production. */
export class ProductionQueues {
  readonly items = new Map<ProductionCategory, FactoryProduction>();
  private readonly unlocked=new Set<string>();
  constructor(readonly house: HouseEconomy, readonly buildings: FactoryBuilding[]) {}
  available(type: ProductionType) {
    const factories=this.buildings.filter(b=>b.active&&PRODUCTION.get(b.type)?.factory===type.category&&(b.faction&type.factions));
    // SIDEBAR.CPP StripClass::Recalc checks the factory, not prerequisites already unlocked.
    if(!factories.length){this.unlocked.delete(type.name);return false;}
    if(factories.some(b=>canBuild(type,b.faction,this.buildings)))this.unlocked.add(type.name);
    return this.unlocked.has(type.name);
  }
  /** SIDEBAR.CPP StripClass::Add appends discoveries; Recalc removes only unavailable factories. */
  options(){
    for(const name of this.unlocked)this.available(PRODUCTION.get(name)!);
    for(const factory of this.buildings)for(const type of PRODUCTION_TYPES){
      if(PRODUCTION.get(factory.type)?.factory===type.category)this.available(type);
    }
    return Array.from(this.unlocked,name=>PRODUCTION.get(name)!);
  }
  begin(name: string) {
    const type = PRODUCTION.get(name)!;
    const previous = this.items.get(type.category);
    if (previous) return previous.type === type && previous.start();
    if (!this.available(type)) return false;
    const item = new FactoryProduction(type, this.house);
    this.items.set(type.category, item);
    return item.start();
  }
  cancel(category: ProductionCategory) {
    this.items.get(category)?.abandon();
    this.items.delete(category);
  }
  step() {
    for (const [category, item] of this.items) {
      const count = this.buildings.filter(b => b.active && PRODUCTION.get(b.type)?.factory === category).length;
      if (!count||!this.available(item.type)) this.cancel(category);
      else item.step(count);
    }
  }
}
