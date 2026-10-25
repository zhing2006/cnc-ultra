import type { ProductionQueues } from '../game/simulation/economy.ts';

export type DemoSpeed = 1 | 10 | 100;
export const DEMO_SPEEDS: readonly DemoSpeed[] = [1, 10, 100];

/** Sandbox-only queue acceleration; prices and stage accounting still use the game rules. */
export function accelerateProduction(queues: ProductionQueues, speed: DemoSpeed) {
  for (let step = 0; step < speed; step++) queues.step();
}
