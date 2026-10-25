import { HouseEconomy, ProductionQueues } from '../src/game/simulation/economy.ts';
import type { EconomyRuntime } from '../src/game/simulation/economy-runtime.ts';
import { PRODUCTION } from '../src/game/data/production.ts';

/** Only the CPU state read by the sidebar; no GPU simulation or decoded scene is needed. */
export function sidebarEconomy() {
  const house = new HouseEconomy(10000);
  house.power = 100; house.drain = 40;
  const queues = new ProductionQueues(house, [{ type: 'FACT', faction: 1, active: true }]);
  const available = ['NUKE'];
  const value = {
    faction: 1, house, queues, mode: 'normal',
    get available() { return available.map(name => PRODUCTION.get(name)!); },
    get radar() { return house.power >= house.drain; },
    scene: { scene: {
      setup: { palette: new Uint8Array(1024), spriteAtlas: { pixels: new Uint8Array(1), width: 1 } },
      cursors: { normal: { hotX: 0, hotY: 0, region: { x: 0, y: 0, width: 1, height: 1 } } },
    } },
  };
  return { economy: value as unknown as EconomyRuntime, house, available };
}
