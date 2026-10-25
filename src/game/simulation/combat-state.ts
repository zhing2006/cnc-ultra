import type { UnitsSetup } from './units-state.ts';
import { combatTypes } from '../data/combat.ts';
export const ROUTE_STEPS = 32;
export const CWORDS = 87;
export const CTARGET = 0, CMISSION = 1, CARM = 2, CSECOND = 3, CTURRET = 4, CTURN = 5;
export const CSCAN = 6, CFIRE = 7, CFEAR = 8, CPRONE = 9, CDEATH = 10, CWARHEAD = 11;
export const CLAST_FIRE = 12, CCURSOR = 13, CAMMO = 14, CRELOAD = 15, CKILLER = 16;
export const CCREW = 17, CACTION = 18, CSTAGE = 19, CSHOT = 20, CSEEN = 21, CKILLS = 22, CROTATING = 23;
export const CAPPROACH_GOAL = 24, CLOCAL_ROUTE = 25, CLOCAL_WAIT = 26;
export const CLOCAL_DEST = 27;
export const CROUTE_LENGTH = 28, CROUTE_CURSOR = 29, CROUTE_PATH = 30, CROUTE_TARGET = 62;
export const CLOCAL_SEARCH = 63;
/** INFANTRY.CPP Made_A_Kill/AI: excitement, delay and a retained local presentation event. */
export const CSTOKED = 64, CCOMMENT = 65, CCELEBRATED = 66, CTAUNT = 67;
export const CPOWER=68,CACTIVE=69,CSAM=70,CSTIMER=71,CCHARGE=72,CRECOIL=73;
export const CMUZZLEX=74,CMUZZLEY=75;
export const CWALL=76;
/** Last damaging hit, for campaign triggers and the house's Base_Is_Attacked response. */
export const CHIT_FRAME=77, CHIT_SOURCE=78;
export const CSABOTAGE=79;
/** MISSION.CPP / TECHNO.CPP / FOOT.CPP Override_Mission; mission + 1, zero means none. */
export const CSUSPENDED_MISSION=80, CSUSPENDED_TARGET=81, CSUSPENDED_GOAL=82, CSUSPENDED_ABILITY=83;
/** FOOT.CPP ArchiveTarget, encoded as cell + 1. */
export const CGUARD_CELL=84;
/** INFANTRY.CPP Random_Animate: tick * 4 plus the ambient voice (1..3). */
export const CIDLE_VOICE=85;
/** TECHNO.CPP Base_Is_Attacked requests suspension of low-priority campaign teams. */
export const CPANIC_FRAME=86;
export const GUARD = 0, MOVE = 1, ATTACK = 2, HUNT = 3, GUARD_AREA = 4;
export const SLEEP = 5, STICKY = 6, AMBUSH = 7, HARVEST = 8;
export const BWORDS = 28, SHOTS_PER_UNIT = 8;
export const MAX_SPECIAL_BLASTS = 128, SPECIAL_BLAST_WORDS = 7;
export interface ExplosionCommand { frame:number; x:number; y:number; damage:number; warhead:number; source:number; scorch?:boolean; crater?:boolean }
/** Overrun removes infantry directly, without a normal damage/death animation. */
export const CRUSHED = -2;
export const BX = 0, BY = 1, BTARGET = 2, BTYPE = 3, BDAMAGE = 4, BACTIVE = 5;
export const BFACE = 6, BDESIRED = 7, BSPEED = 8, BACCUM = 9, BTIMER = 10, BARM = 11;
export const BTO_X = 12, BTO_Y = 13, BPROXIMITY = 14, BALTITUDE = 15, BRISER = 16;
export const BIMPACT = 17, BEXPLODED = 18, BSOURCE = 19, BFIRE_X = 20, BFIRE_Y = 21, BWEAPON = 22, BBORN = 23;
export const BFIRE_FACE = 24;
export const BTRAIL_X = 25, BTRAIL_Y = 26, BTRAIL_TICK = 27;
export function initialProjectiles(units: number) {
  const state = new Int32Array(units * SHOTS_PER_UNIT * BWORDS);
  for (let at = 0; at < state.length; at += BWORDS) {
    state[at + BEXPLODED] = -1;
    state[at + BTRAIL_TICK] = -1;
  }
  return state;
}
export interface CombatSetup extends UnitsSetup {
  dynamicTypes?: boolean;
  multiplayer?: boolean;
  /** Original scenario missions, using this simulation's mission constants. */
  missions?: readonly number[];
  /** Parent vehicle index for each reserved survivor; -1 for initially present units. */
  crewParents?: readonly number[];
}
export interface AttackCommand {
  frame: number;
  kind: 'attack' | 'attack-ground' | 'capture' | 'sabotage';
  target: number;
  ids: readonly number[];
}
export function initialCombat(setup: CombatSetup) {
  const state = new Int32Array(setup.units.length * CWORDS);
  setup.units.forEach((unit, id) => {
    const at = id * CWORDS, type = combatTypes[unit.type];
    state[at + CTARGET] = -1;
    state[at + CMISSION] = setup.missions?.[id] ?? GUARD;
    state[at + CAPPROACH_GOAL] = -1;
    state[at + CLOCAL_DEST] = -1;
    state[at + CTURRET] = state[at + CTURN] = unit.facing ?? 0;
    state[at + CSECOND] = type.twoShooter ? 0 : 1;
    state[at + CFIRE] = -1;
    state[at + CDEATH] = -1;
    state[at + CLAST_FIRE] = -1;
    state[at + CCELEBRATED] = -1;
    state[at + CAMMO] = type.ammo;
    state[at + CKILLER] = -1;
    state[at + CCREW] = setup.crewParents?.[id] ?? -1;
    state[at + CSEEN] = (unit.owner ?? 0) === 0 ? 1 : 0;
    state[at+CPOWER]=256;state[at+CACTIVE]=1;
  });
  return state;
}
