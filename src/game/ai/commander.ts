// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { randomWord } from '../../engine/simulation/fixed.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { PRODUCTION, type ProductionCategory } from '../data/production.ts';
import { combatTypes } from '../data/combat.ts';
import type { EconomyRuntime } from '../simulation/economy-runtime.ts';
import { findBuildLocation, planBase, ratioLimit } from './base-planning.ts';

export interface ArmyOrder { owner:number; frame:number; attack:boolean; forced:boolean; all?:boolean; base?:{x:number;y:number;radius:number} }

/** HOUSE.CPP USE_RA_AI: strategic information is global; commands still obey TD's economy. */
export class Commander {
  enabled=true;
  private nextExpert=0;
  private nextAttack=0;
  // TD DEFINES.H EACH_UNIT_MAX; the added RA counters are populated by Expert_AI.
  private limits={vehicle:75,infantry:0,aircraft:0};
  constructor(readonly owner:number){}
  private random(economy:EconomyRuntime,stream:number,count:number){return randomWord(economy.scene.setup.seed,economy.frame,this.owner,stream)%count;}
  step(economy:EconomyRuntime):ArmyOrder|undefined{
    if(!this.enabled)return;
    return economy.withOwner(this.owner,()=>{
      // BUILDING.CPP AI abandons halted factories instead of leaving an unaffordable first payment stuck forever.
      for(const [category,item] of economy.queues.items)if(item.suspended&&!item.complete)economy.queues.cancel(category);
      let owned=[...economy.buildings.values()].filter(b=>b.owner===this.owner&&b.health>0&&!b.selling);
      const count=(name:string,owner=this.owner)=>economy.inventory[owner*MOVEMENT.length+movementType(name)];
      const total=(category:ProductionCategory,owner=this.owner)=>MOVEMENT.reduce((sum,t,id)=>sum+(PRODUCTION.get(t.name)?.category===category?economy.inventory[owner*MOVEMENT.length+id]:0),0);
      economy.deployIdleMcvs();
      // Original BUILDING.CPP AI: SCM01 is Scenario 1, so repair below one-quarter at $1000.
      // Nyerguds instead uses build level (20 in multiplayer); that change is not used here.
      for(const b of owned){const type=PRODUCTION.get(b.type)!;if(b.active&&type.repairable&&b.health*4<=type.strength&&economy.house.money>=1000)b.repairing=true;}
      let order:ArmyOrder|undefined;
      if(economy.frame>=this.nextExpert){
        this.nextExpert=economy.frame+76+this.random(economy,403,7);
        if(owned.length&&economy.frame>=this.nextAttack&&total('building',1-this.owner)>0)
          for(const category of ['vehicle','infantry','aircraft'] as const)this.limits[category]=Math.max(this.limits[category],total(category,1-this.owner)+10);
        const money=economy.house.money,attacked=economy.frame<economy.houses[this.owner].lastAttack+900;
        const canMakeMoney=money>300||count('PROC')>0;
        const first=(names:readonly string[])=>owned.find(b=>b.active&&names.includes(b.type)&&!b.selling);
        const sell=(names:readonly string[])=>{for(const name of names){const b=first([name]);if(b){economy.sell(b.id);return;}}};
        // Expert_AI executes every matching strategy at every urgency; its 'acted' flag is unused.
        const actions:{urgency:number;run:()=>void}[]=[];
        if(owned.length&&!attacked&&!owned.some(b=>['PYLE','FACT','AFLD','WEAP','HPAD'].includes(b.type)))actions.push({urgency:4,run:()=>{
          for(const b of owned)if(b.active)economy.sell(b.id);
          order={owner:this.owner,frame:economy.frame,attack:true,forced:true,all:true};
        }});
        const cashUrgency=Number(money<100)+Number(money<2000&&!canMakeMoney);
        if(cashUrgency)actions.push({urgency:cashUrgency,run:()=>sell(cashUrgency>=2?['BIO','EYE','HQ','SILO','FIX','HPAD']:['BIO','SILO'])});
        const powerUrgency=economy.house.powerFraction<192&&economy.house.power<economy.house.drain-400?2+Number(attacked):0;
        if(powerUrgency)actions.push({urgency:powerUrgency,run:()=>sell(powerUrgency===3?['BIO','EYE','HQ','FIX','OBLI','GUN','ATWR','GTWR']:['BIO','EYE','HQ','FIX'])});
        if(economy.house.power>economy.house.drain+300)actions.push({urgency:1,run:()=>sell(['NUKE','NUK2'])});
        if(economy.frame>900&&economy.frame>=this.nextAttack)actions.push({urgency:attacked?1:4,run:()=>{
          if(!order?.all)order={owner:this.owner,frame:economy.frame,forced:owned.length===0,attack:owned.length===0||this.random(economy,405,100)<33};
          this.nextAttack=economy.frame+3*(450+this.random(economy,404,1351));
        }});
        actions.sort((a,b)=>b.urgency-a.urgency);for(const action of actions)action.run();
        owned=owned.filter(b=>!b.selling);
      }
      const available=new Set(economy.available.map(type=>type.name)),can=(name:string)=>available.has(name);
      const money=economy.house.money,income=count('PROC')>0&&count('HARV')>0;
      const afford=(name:string)=>can(name)&&(PRODUCTION.get(name)!.cost<money||income);
      const weighted=(choices:{name:string;weight:number}[],stream:number)=>{
        const sum=choices.reduce((n,c)=>n+c.weight,0);if(!sum)return;
        let pick=this.random(economy,stream,sum);for(const choice of choices){if(pick<choice.weight)return choice.name;pick-=choice.weight;}
      };
      // BUILDING.CPP AI starts a new factory only above ten credits, even for free initial installments.
      const begin=(name:string|undefined)=>{if(name&&economy.house.money>10)economy.choose(name);};
      const building=economy.queues.items.get('building');
      if(building?.complete){
        if(economy.frame>=economy.current.placementRetryFrame){
          const cell=findBuildLocation(economy.placement,building.type.name,this.owner,owned,(stream,count)=>this.random(economy,stream,count));
          // BUILDING.CPP AI / Exit_Object: no legal site is a permanent failure, not a blocked exit.
          if(cell>=0)economy.place(building.type.name,cell);
          else economy.queues.cancel('building');
        }
      }else if(!building){
        // AI_Building, RULES.CPP ratios and original strict cost comparisons.
        const choices:{name:string;priority:number}[]=[],add=(name:string,priority:number)=>{if(afford(name))choices.push({name,priority});};
        const want=(quantity:number,ratio:number,limit:number)=>quantity<ratioLimit(owned.length,ratio)&&quantity<limit;
        if(economy.house.power<=economy.house.drain+50){
          const power=can('NUK2')&&PRODUCTION.get('NUK2')!.cost<money?'NUK2':'NUKE';
          if(can(power)&&PRODUCTION.get(power)!.cost<money)choices.push({name:power,priority:count('PROC')?2:1});
        }
        if(want(count('PROC'),0x28,4))add('PROC',count('PROC')?2:3);
        if(want(count('PYLE')+count('HAND'),0x28,2)&&(money>300||income))add(can('PYLE')?'PYLE':'HAND',count('PYLE')+count('HAND')?1:2);
        if(want(count('WEAP'),0x19,2)&&(money>2000||income))add('WEAP',count('WEAP')?1:2);
        if(want(count('GUN')+count('OBLI'),0x66,40))add(afford('OBLI')?'OBLI':'GUN',2);
        const enemyAircraft=total('aircraft',1-this.owner);
        if(want(count('SAM'),0x24,10)&&enemyAircraft){if(!count('HQ'))add('HQ',3);add('SAM',count('SAM')<enemyAircraft?3:2);}
        if(want(count('HPAD'),0x1e,5))add('HPAD',total('aircraft')<enemyAircraft?3:2);
        if(want(count('AFLD'),0x1e,5))add('AFLD',total('aircraft')<enemyAircraft?3:2);
        // TD adaptation required by M6: the imported RA list omits GDI defenses and both superweapon structures.
        if(!count('HQ')&&count('PROC')&&(count('WEAP')||count('AFLD')))add('HQ',2);
        const advanced=economy.faction===1?'EYE':'TMPL';if(count('HQ')&&!count(advanced))add(advanced,2);
        if(economy.faction===1&&want(count('GTWR')+count('ATWR'),0x66,40))add(afford('ATWR')?'ATWR':'GTWR',count('ATWR')<enemyAircraft&&afford('ATWR')?3:2);
        choices.sort((a,b)=>b.priority-a.priority);begin(choices[0]?.name);
      }
      // AI_Unit: no scenario TeamTypes exist in SCM01; the skirmish weighted branch applies.
      if(!economy.queues.items.has('vehicle')&&total('vehicle')<this.limits.vehicle){
        if(count('PROC')>count('HARV')&&can('HARV'))begin('HARV');
        else begin(weighted(MOVEMENT.flatMap((type,id)=>PRODUCTION.get(type.name)?.category==='vehicle'&&type.name!=='HARV'&&can(type.name)?[{name:type.name,weight:combatTypes[id].primary>=0?20:1}]:[]),401));
      }
      // AI_Infantry: the imported INFANTRY_E7 name denotes TD's engineer E6.
      if(!economy.queues.items.has('infantry')&&total('infantry')<this.limits.infantry){
        begin(weighted([['E1',3],['E2',5],['E3',2],['E4',5],['E6',total('infantry')>5?Math.max(0,1-count('E6')):0]]
          .flatMap(([name,weight])=>can(String(name))&&(count(String(name),1-this.owner)>count(String(name))||money>3000||total('infantry')<owned.length)?[{name:String(name),weight:Number(weight)}]:[]),402));
      }
      // AI_Aircraft retains its airstrip quantity test; TD helipads also supply their bundled Orca.
      if(!economy.queues.items.has('aircraft')&&total('aircraft')<this.limits.aircraft&&count('AFLD')>count('HELI')+count('ORCA'))begin(can('HELI')?'HELI':can('ORCA')?'ORCA':undefined);
      if(order&&owned.length){const {x,y,radius}=planBase(owned,economy.scene.setup.grid.width);order.base={x,y,radius};}
      return order;
    });
  }
}
