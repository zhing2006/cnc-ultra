export const DEBUG_SPEEDS = [1, 10, 100] as const;
export type DebugSpeed = (typeof DEBUG_SPEEDS)[number];
export const DAMAGE_SCALE = 1000;
export const MAX_DEBUG_MONEY = 0x7fffffff;

export interface DebugState {
  money: number;
  buildSpeed: DebugSpeed;
  gameSpeed: DebugSpeed;
  /** Integer thousandths; floating point is confined to the menu's display value. */
  damageScale: number;
}

export function validDebugState(value: DebugState) {
  return Number.isInteger(value.money) && value.money >= 0 && value.money <= MAX_DEBUG_MONEY
    && DEBUG_SPEEDS.includes(value.buildSpeed) && DEBUG_SPEEDS.includes(value.gameSpeed)
    && Number.isInteger(value.damageScale) && value.damageScale >= 0 && value.damageScale <= DAMAGE_SCALE;
}

/** Debug-only incoming damage adjustment. Positive damage retains its minimum one hit point. */
export function scaleIncomingDamage(amount: number, owner: number, debugOwner: number, scale: number) {
  if (owner !== debugOwner || amount <= 0) return amount;
  if (!scale) return 0;
  // Split the product so a large simultaneous hit cannot overflow a GPU i32.
  return Math.max(1, Math.trunc(amount / DAMAGE_SCALE) * scale + Math.trunc(amount % DAMAGE_SCALE * scale / DAMAGE_SCALE));
}
