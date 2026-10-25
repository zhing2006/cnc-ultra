import type { ProductionType } from '../data/production.ts';
import { canBuild, type FactoryBuilding } from '../simulation/economy.ts';

// Ported from BDATA.CPP, UDATA.CPP, IDATA.CPP and AADATA.CPP, the Scenario field (not Level).
const availability: Readonly<Record<string, number>> = {
  TMPL: 13, EYE: 13, WEAP: 5, GTWR: 7, ATWR: 13, OBLI: 11, GUN: 8, FACT: 1, PROC: 2, SILO: 2,
  HPAD: 10, HQ: 3, SAM: 5, AFLD: 5, NUKE: 1, NUK2: 13, HOSP: 99, BIO: 99, PYLE: 1, HAND: 2,
  FIX: 8, SBAG: 5, CYCL: 9, BRIK: 13, BARB: 98, WOOD: 98,
  VICE: 1, FTNK: 9, STNK: 12, LTNK: 5, MTNK: 7, HTNK: 13, MHQ: 99, LST: 99, MLRS: 98,
  ARTY: 9, HARV: 7, MCV: 15, JEEP: 5, BGGY: 5, BIKE: 5, MSAM: 11, APC: 5, BOAT: 99,
  E1: 1, E2: 3, E3: 3, E4: 5, E5: 99, E6: 2, RMBO: 98, A10: 0, TRAN: 98, HELI: 10, ORCA: 10, C17: 0,
};

/** Ported from HOUSE.CPP, HouseClass::Can_Build, GAME_NORMAL branch. Factions use game bit masks. */
export function canBuildCampaign(type: ProductionType, factoryFaction: number, playerFaction: number,
  buildings: readonly FactoryBuilding[], scenario: number, human = true) {
  if (!type.buildable || !(type.factions & factoryFaction)) return false;
  if (!human) return true;
  let level = scenario, prerequisites = type.prerequisites;
  const first = availability[type.name] ?? 99;
  if (factoryFaction === 2 && type.name === 'STNK' && level === 11) { prerequisites = ['MISS']; level = first; }
  if (factoryFaction === 1 && (type.name === 'E3' && level < 7 || type.name === 'MSAM' && level < 9)) return false;
  if (factoryFaction === 2 && (type.name === 'APC' || type.name === 'HPAD')) return false;
  if (playerFaction === 1 && (type.name === 'TMPL' || type.name === 'OBLI')) return false;
  if (playerFaction === 2 && (type.name === 'MSAM' || type.name === 'EYE')) return false;
  if (factoryFaction === 2 && level >= 12 && type.name === 'NUK2') level = first;
  if (factoryFaction === 1 && level < 8 && type.name === 'SBAG') return false;
  if (factoryFaction === 1 && level === 2) level = 1;
  return first <= level && canBuild({ ...type, prerequisites }, factoryFaction, buildings, 99);
}
