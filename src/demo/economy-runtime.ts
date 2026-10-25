import { movementType } from '../game/data/movement.ts';
import { EconomyRuntime } from '../game/simulation/economy-runtime.ts';
import type { GpuCombat } from '../game/simulation/combat-gpu.ts';
import { DESTINATION } from '../game/simulation/lifecycle-gpu.ts';
import type { economyScene } from './economy-scene.ts';
import type { DemoSpeed } from './production.ts';

/** Optional cheats and enemy waves belong to the sandbox, never to the match rules. */
export class DemoEconomyRuntime extends EconomyRuntime {
  waves = false;
  get productionSpeed() { return this.current.debugBuildSpeed; }
  constructor(battle: GpuCombat, override readonly scene: ReturnType<typeof economyScene>, faction = 1,
    private readonly reinforcements = false) {
    super(battle, scene, faction);
  }
  setProductionSpeed(speed: DemoSpeed) { this.command(() => { this.current.debugBuildSpeed = speed; }); }
  override beginTick() {
    if (!super.beginTick()) return false;
    if (this.reinforcements && this.waves && this.frame % 450 === 60) {
      this.spawnWave();
      this.lifecycle.flush();
    }
    return true;
  }
  private spawnWave() {
    const id = this.freeSlot();
    if (id < 0) return;
    const base = [...this.buildings.values()].find(b => b.active && ['SAM', 'ATWR', 'GTWR', 'GUN', 'OBLI'].includes(b.type))
      ?? this.buildings.values().next().value;
    if (!base) return;
    const cell = Math.trunc(base.cell / this.width) * this.width + (this.scene.setup.bounds?.x ?? 0)
      + (this.scene.setup.bounds?.width ?? this.width) - 2;
    this.pending.push({ id, name: 'TRAN', cell, faction: 2, generation: this.generations[id] + 1, silent: true, owner: 1 });
    this.lifecycle.create(id, { type: movementType('TRAN'), cell, owner: 1, facing: 192, altitude: 24 });
    this.lifecycle.edit(id, DESTINATION, base.cell + 5);
    for (let i = 0; i < 4; i++) {
      const cargo = this.freeSlot();
      if (cargo < 0) break;
      this.pending.push({ id: cargo, name: 'E1', cell, faction: 2, generation: this.generations[cargo] + 1, silent: true, owner: 1 });
      this.lifecycle.create(cargo, { type: movementType('E1'), cell, owner: 1, attached: id + 1 });
    }
  }
}
