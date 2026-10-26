import type { Grid } from '../../engine/simulation/state.ts';
import { MOVEMENT } from '../data/movement.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { INFANTRY_SPOTS } from './map.ts';
export const WORDS = 53;
export const UX = 0;
export const UY = 1;
export const UCELL = 2;
export const UDEST = 3;
export const USLOT = 4;
export const UDSLOT = 5;
export const UTRACK_STEP = 6;
export const UTRACK = 7;
export const UACCUM = 8;
export const UKIND = 9;
export const UFACE = 10;
export const UDESIRED = 11;
export const UTYPE = 12;
export const UHEALTH = 13;
export const UJUMP = 14;
export const UJUMP_TRACK = 15;
export const UWAIT = 16;
export const UWALK = 17;
export const UOWNER = 18;
export const UHEAD_X = 19;
export const UHEAD_Y = 20;
export const UMIDDLE = 21;
export const USPEED = 22;
export const URETRIES = 23;
export const USTARTED = 24;
export const UROTATED = 25;
export const UROUTE = 26;
export const USTALLED = 27;
/** DRIVE.CPP, Per_Cell_Process: position of this tick's vehicle overrun check. */
export const UOVERRUN_CELL = 28;
export const UOVERRUN_X = 29;
export const UOVERRUN_Y = 30;
/** 0: ground mobile, 1: aircraft, 2: building. */
export const UDOMAIN = 31;
/** Aircraft altitude in original image pixels; all other positions remain in leptons. */
export const UALTITUDE = 32;
export const UORIGIN = 33;
export const UGENERATION = 34;
/** Attached cargo or a refinery's contained harvester: parent ID + 1, otherwise zero. */
export const UATTACHED = 35;
/** Requested docking/boarding object ID + 1, zero for no contact. */
export const UENTER=36;
export const UDOOR=37;
/** TECHNO.CPP: uncloaked, cloaking, cloaked, uncloaking. */
export const UCLOAK=38, UCLOAK_STAGE=39, UCLOAK_WAIT=40;
export const UBOMB_TICK=41, UBOMB_SOURCE=42;
/** INFANTRY.CPP: capture/sabotage approach and the final occupied-cell step. */
export const UABILITY_TARGET=43, UABILITY_MODE=44, UABILITY_ENTRY=45, UABILITY_ORIGIN=46;
export const UCAPTURE_TICK=47;
/** Tick << 3, plus detach/sound/uncloak event bits. */
export const UCLOAK_EVENT=48;
/** Destructible obstruction ID + 1 and the navigation order it interrupted. */
export const UOBSTRUCTION=49, UOBSTRUCTION_GOAL=50;
/** Automatic Scatter NavCom, cell + 1. It changes the route without replacing a harvesting mission. */
export const USCATTER_GOAL=51;
export const UFLAGS=52, TECHNICIAN=1, LOANER=2, PLAYER_ORDER=4;
/** UNIT.CPP / FOOT.CPP: hovercraft contact and passengers still leaving the deck. */
export const UNLOADING=8, HOVER_TETHERED=16;
/** A caller has already planned the adjacent goal; do not allocate a whole-map flow field. */
export const DIRECT_STEP = -2;
export interface UnitPlacement {
  cell: number;
  type: number;
  facing?: number;
  slot?: number;
  owner?: number;
  health?: number;
  altitude?: number;
  attached?:number;
  enter?:number;
  flags?:number;
}
export interface UnitsSetup {
  campaignRouting?: boolean;
  campaignLevel?: number;
  goodOwner?: number;
  houseEdges?: readonly number[];
  /** Includes dormant campaign houses that may receive reinforcements later. */
  houseCount?: number;
  allies?: readonly number[];
  grid: Grid;
  /** Original map bounds, excluding the surrounding reinforcement cells. */
  bounds?:{x:number;y:number;width:number;height:number};
  land: Uint8Array;
  passable?: Uint8Array;
  units: readonly UnitPlacement[];
  seed: number;
}
export interface UnitCommand {
  frame: number;
  kind: 'move' | 'stop' | 'scatter';
  target?: number;
  /** Local selection is resolved when recording the command, outside the simulation. */
  ids: readonly number[];
}
export function initialUnits(setup: UnitsSetup) {
  const result = new Int32Array(setup.units.length * WORDS);
  setup.units.forEach((placed, id) => {
    const at = id * WORDS;
    const type = MOVEMENT[placed.type];
    const slot = placed.slot ?? 0;
    result[at + UX] = placed.cell % setup.grid.width * 256 + INFANTRY_SPOTS[slot][0];
    result[at + UY] = Math.floor(placed.cell / setup.grid.width) * 256 + INFANTRY_SPOTS[slot][1];
    result[at + UCELL] = placed.cell;
    result[at + UDEST] = -1;
    result[at + USLOT] = slot;
    result[at + UDSLOT] = slot;
    result[at + UTRACK] = -1;
    result[at + UKIND] = type.infantry;
    result[at + UFACE] = placed.facing ?? 0;
    result[at + UDESIRED] = result[at + UFACE];
    result[at + UTYPE] = placed.type;
    result[at + UHEALTH] = placed.health ?? type.strength;
    result[at + UJUMP] = -1;
    result[at + UJUMP_TRACK] = -1;
    result[at + UROUTE] = -1;
    result[at + UOWNER] = placed.owner ?? 0;
    result[at + UMIDDLE] = -1;
    result[at + URETRIES] = 10;
    result[at + UOVERRUN_CELL] = -1;
    result[at + UDOMAIN] = type.domain ?? 0;
    result[at + UALTITUDE] = placed.altitude ?? 0;
    result[at + UORIGIN] = placed.cell;
    result[at + UGENERATION] = result[at+UHEALTH]>0?1:0;
    result[at+UATTACHED]=placed.attached??0;result[at+UENTER]=placed.enter??0;
    result[at+UFLAGS]=placed.flags??0;
    if(type.name==='STNK')result[at+UCLOAK_STAGE]=1;
    if(type.domain===2){
      const building=BUILDINGS.get(type.name)!;
      result[at+UX]=placed.cell%setup.grid.width*256+(building.width===2?255:building.width*128);
      result[at+UY]=Math.trunc(placed.cell/setup.grid.width)*256+(building.height===2?255:building.height*128);
      result[at+UCELL]=Math.trunc(result[at+UY]/256)*setup.grid.width+Math.trunc(result[at+UX]/256);
    }
  });
  return result;
}
