import { HouseEconomy, ProductionQueues, type FactoryBuilding } from './economy.ts';
import type { SuperKind } from './super-weapons.ts';

/** CPU house state; shared map occupancy and actor slots belong to the match, not a house. */
export class HouseState {
  readonly economy: HouseEconomy;
  readonly factories: FactoryBuilding[] = [];
  readonly queues: ProductionQueues;
  readonly freebies: { name: string; building: number; attempt: number }[] = [];
  readonly announcements = { power: 1, silos: 1, attack: 1 };
  placementRetryFrame=0;
  knownOptions = new Set<string>();
  selected = -1;
  deploying = -1;
  placing: string | undefined;
  specialTarget: SuperKind | undefined;
  mode: 'normal' | 'repair' | 'sell' = 'normal';
  message = '';
  lastAttack = 0;
  lost = 0;
  harvested = 0;
  refunded = 0;
  delivered = 0;
  repaired = 0;
  constructor(readonly owner: number, readonly faction: number, credits: number) {
    this.economy = new HouseEconomy(credits);
    this.queues = new ProductionQueues(this.economy, this.factories);
  }
}
