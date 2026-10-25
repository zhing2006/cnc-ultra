// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { randomWord } from '../../engine/simulation/fixed.ts';
import * as C from './combat-state.ts';
import * as U from './units-state.ts';

export interface TiberiumSetup {
  width: number;
  height: number;
  seed: number;
  /** -1 means no Tiberium overlay; 0..11 is the original OverlayData. */
  amount: Int32Array;
  /** Original overlay variant, 0..11. Only used where amount is nonnegative. */
  variants: Int32Array;
  /** Clear land with no other overlay, bridge, tree or building. */
  clear: Int32Array;
  blossom: Int32Array;
  /** Playable source cells (MapClass::In_Radar). */
  playable: Int32Array;
  grow?: boolean;
  spread?: boolean;
  fast?: boolean;
}
export const TIBERIUM_STATE_WORDS = 105;
export const TGROWTH = 5, TSPREAD = 55;
export function initialTiberiumState() {
  const state = new Int32Array(TIBERIUM_STATE_WORDS);
  state[2] = 1;
  return state;
}
export const TIBERIUM_DIRECTIONS = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]] as const;

/** Ported from MAP.CPP, MapClass::Logic, including its repeated boundary cell. */
export class CpuTiberium {
  readonly amount: Int32Array;
  readonly variants: Int32Array;
  readonly state = initialTiberiumState();
  constructor(readonly setup: TiberiumSetup) {
    this.amount = setup.amount.slice();
    this.variants = setup.variants.slice();
  }
  step(occupied?: Int32Array | Uint32Array) {
    const {setup, state:s, amount} = this;
    const frame = ++s[0], grow = setup.grow !== false, spread = setup.spread !== false;
    if (!grow && !spread) return;
    const pick = (object:number, stream:number, count:number) => randomWord(setup.seed, frame, object, stream) % count;
    const add = (base:number, counter:number, cell:number, stream:number) => {
      if (s[counter] < 50) s[base + s[counter]++] = cell;
      else s[base + pick(cell, stream, 50)] = cell;
    };
    let index = s[1], remaining = 30;
    for (; index < amount.length; index++) {
      const cell = s[2] ? index : amount.length - 1 - index;
      if (grow && amount[cell] >= 0 && amount[cell] < 11) add(TGROWTH, 3, cell, 0);
      // The original expression deliberately includes blossom trees even when spread is off.
      if (spread && amount[cell] > 6 || setup.blossom[cell]) {
        for (let i = 0; i < (setup.blossom[cell] ? 3 : 1); i++) add(TSPREAD, 4, cell, 1 + i);
      }
      if (--remaining === 0) break;
    }
    s[1] = index;
    if (index < amount.length) return;
    s[1] = 0;
    s[2] ^= 1;
    const tries = setup.fast === false ? 1 : 2;
    if (s[3]) for (let i = 0; i < tries; i++) {
      const cell = s[TGROWTH + pick(i, 4, s[3])];
      if (amount[cell] >= 0 && amount[cell] < 11) amount[cell]++;
    }
    s[3] = 0;
    if (s[4]) for (let i = 0; i < tries; i++) {
      const cell = s[TSPREAD + pick(i, 5, s[4])];
      if (!setup.playable[cell]) continue;
      const offset = pick(i, 6, 8), x = cell % setup.width, y = Math.trunc(cell / setup.width);
      for (let j = 0; j < 8; j++) {
        const [dx, dy] = TIBERIUM_DIRECTIONS[(j + offset) & 7], xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= setup.width || yy < 0 || yy >= setup.height) continue;
        const target = yy * setup.width + xx;
        if (!setup.clear[target] || amount[target] >= 0 || occupied?.subarray(target*5,target*5+5).some(value=>value!==0)) continue;
        amount[target] = 1;
        this.variants[target] = pick(i, 7, 12);
        break;
      }
    }
    s[4] = 0;
  }
}

/** UNIT.CPP Harvesting, CELL.CPP Reduce_Tiberium, TYPE.H UnitTypeClass. */
export function harvestBail(amount: number, load: number) {
  if (amount < 0 || load >= 28) return {amount, load, taken:0};
  const taken = Math.min(amount % 6 + 1, 28 - load, amount);
  return {amount: amount > taken ? amount - taken : -1, load:load + taken, taken};
}

/** COMBAT.CPP Explosion_Damage and CELL.CPP Reduce_Tiberium. */
export function damageTiberium(amount:Int32Array,projectiles:Int32Array,units:Int32Array,width:number,frame:number){
  for(let at=0;at<projectiles.length;at+=C.BWORDS){
    if(projectiles[at+C.BEXPLODED]!==frame)continue;
    const target=projectiles[at+C.BTARGET];
    if(target>=0&&units[target*U.WORDS+U.UDOMAIN]===1&&units[target*U.WORDS+U.UALTITUDE]>=16)continue;
    const cell=Math.trunc(projectiles[at+C.BY]/256)*width+Math.trunc(projectiles[at+C.BX]/256),levels=Math.trunc(projectiles[at+C.BDAMAGE]/10);
    if(cell>=0&&cell<amount.length&&amount[cell]>=0&&levels>0)amount[cell]=amount[cell]>levels?amount[cell]-levels:-1;
  }
}
