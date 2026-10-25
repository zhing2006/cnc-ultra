import type { GpuCombat } from './combat-gpu.ts';
import type { EconomyRuntime } from './economy-runtime.ts';
import type { GpuTiberium } from './tiberium-gpu.ts';
import type { GpuTransport } from './transport-gpu.ts';
import type { GpuServices } from './services-gpu.ts';
import type { GpuHarvest } from './harvest-gpu.ts';
import type { GpuAircraft } from './aircraft-gpu.ts';
import type { GpuAirOperations } from './air-operations-gpu.ts';
import type { GpuSight } from './sight.ts';
import type { GpuBuildingEffects } from './building-effects-gpu.ts';

export interface BattleSystems {
  battle:GpuCombat;
  economy?:EconomyRuntime;
  ore?:GpuTiberium;
  transport?:GpuTransport;
  services?:GpuServices;
  harvest?:GpuHarvest;
  aircraft?:GpuAircraft;
  airOperations?:GpuAirOperations;
  opposingSight?:GpuSight;
  buildingEffects?:GpuBuildingEffects;
}

/** One complete logical tick, shared by the live game and non-presenting simulation checks. */
export function stepBattle(s:BattleSystems,afterFlight?:()=>void){
  const {battle,economy,buildingEffects}=s;
  battle.movement.beginOccupancyEdits();
  s.ore?.step();
  s.transport?.step();
  s.services?.step(economy?.houses[0].economy.money??0,economy?.houses[1].economy.money??0);
  s.harvest?.step();
  s.airOperations?.before(economy?.houses.map(h=>h.economy.money));
  s.aircraft?.step();
  battle.movement.endOccupancyEdits();
  battle.step();
  s.opposingSight?.step();
  s.airOperations?.after();
  s.ore?.damage(battle.frame);
  afterFlight?.();
  if(buildingEffects){
    battle.movement.beginOccupancyEdits();buildingEffects.step();battle.movement.endOccupancyEdits();
  }
}
