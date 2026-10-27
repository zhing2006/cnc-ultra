import { MOVEMENT } from './data/movement.ts';
import { WALLS } from './data/overlays.ts';
import { GpuNaval } from './campaign/naval.ts';
import { EconomyRuntime } from './simulation/economy-runtime.ts';
import type { GpuCombat } from './simulation/combat-gpu.ts';
import type { ultraScene } from './ultra-scene.ts';

/** Fixed opening forces use standard missions; issuing an order replaces Hunt normally. */
export class UltraRuntime extends EconomyRuntime {
  onForces?: (counts: [number, number]) => void;
  private readonly naval: GpuNaval;
  private result: number | undefined;
  override get outcome() { return this.result; }
  override get extraSimulationBuffers() { return [this.naval.state]; }
  constructor(battle: GpuCombat, readonly world: ReturnType<typeof ultraScene>) {
    super(battle, world);
    this.naval = new GpuNaval(battle, world.navalMap);
    this.setController(0);
    for (const order of world.openingOrders) this.lifecycle.order(order.id, order.mission, order.target, order.cell);
    for (const house of this.houses) { house.queues.canProduce = () => false; house.queues.loadState({ unlocked: [], items: [] }); }
    this.onTick = () => {
      // Ported from HOUSE.CPP, HouseClass::AI: every remaining unit/building keeps its house alive.
      const alive = [0, 1].map(owner => MOVEMENT.some((type, id) => !WALLS[type.name] && this.inventory[owner * MOVEMENT.length + id] > 0));
      if (this.frame % 15 === 0) this.onForces?.([0, 1].map(owner => MOVEMENT.reduce((sum, type, id) => sum + (type.domain === 2 ? 0 : this.inventory[owner * MOVEMENT.length + id]), 0)) as [number, number]);
      if (battle.frame > 0 && (!alive[0] || !alive[1])) this.result = alive[0] ? 0 : alive[1] ? 1 : 2;
    };
  }
  protected override freeSlot() {
    // Vehicle survivor slots remain private until their parent resolves its original crew roll.
    for (let id = this.world.reserveStart; id < this.health.length; id++) if (this.health[id] <= 0 && !this.pending.some(p => p.id === id)) return id;
    return -1;
  }
  override async prepareForPlay() { await super.prepareForPlay(); await this.naval.prepare(); }
  override beginTick() { if (!super.beginTick()) return false; this.naval.step(); return true; }
  override dispose() { this.naval.dispose(); super.dispose(); }
}
