import { Commander, type ArmyOrder } from './ai/commander.ts';
import { GpuArmyOrders } from './ai/army-orders.ts';
import { GpuPlacementFlush } from './ai/placement-gpu.ts';
import { canPlaceBuilding } from './simulation/building-rules.ts';
import { EconomyRuntime } from './simulation/economy-runtime.ts';
import type { GpuCombat } from './simulation/combat-gpu.ts';
import type { skirmishScene } from './skirmish-scene.ts';
import { MOVEMENT } from './data/movement.ts';
import { WALLS } from './data/overlays.ts';

/** A two-house skirmish. Spectator controls do not grant either AI extra resources. */
export class MatchRuntime extends EconomyRuntime {
  readonly commanders: readonly [Commander, Commander];
  private readonly army: GpuArmyOrders;
  private readonly placementFlush:GpuPlacementFlush;
  override get extraSimulationBuffers(){return [this.placementFlush.cooldown];}
  private readonly orders: ArmyOrder[] = [];
  private result: number | undefined;
  override get outcome() { return this.result; }
  constructor(battle: GpuCombat, scene: ReturnType<typeof skirmishScene>) {
    super(battle, scene);
    this.commanders = [new Commander(0), new Commander(1)];
    this.army = new GpuArmyOrders(battle);
    this.placementFlush=new GpuPlacementFlush(battle);
    this.onBaseAttacked=(owner,enemy)=>{if(this.controlledOwner!==owner)this.placementFlush.respond(owner,enemy);};
    this.setController(null);
    this.onTick = () => {
      // Ported from HOUSE.CPP, HouseClass::AI multiplayer defeat check: no surviving inventory.
      // BUILDING.CPP Unlimbo turns walls into overlays; they never keep a house alive.
      const alive = [0, 1].map(owner => MOVEMENT.some((type,index)=>!WALLS[type.name]&&this.inventory[owner*MOVEMENT.length+index]>0));
      if (battle.frame > 0 && (!alive[0] || !alive[1])) { this.result = alive[0] ? 0 : alive[1] ? 1 : 2; return; }
      for (const commander of this.commanders) {
        const order = commander.step(this);
        if (order) this.orders.push(order);
      }
    };
  }
  override setController(owner: number | null) {
    super.setController(owner);
    for (const commander of this.commanders) commander.enabled = commander.owner !== owner;
  }
  override place(name:string,cell:number){
    if(this.controlledOwner!==this.owner&&this.queues.items.get('building')?.complete&&canPlaceBuilding(this.placement,name,cell,this.owner))this.placementFlush.flush(this.owner,name,cell);
    super.place(name,cell);
  }
  override async prepareForPlay() { await super.prepareForPlay(); await this.army.prepare(); await this.placementFlush.prepare(); }
  override endTick() {
    for (const order of this.orders.splice(0)) this.army.issue(order);
    return super.endTick();
  }
  override dispose() { this.placementFlush.dispose();this.army.dispose(); super.dispose(); }
}
