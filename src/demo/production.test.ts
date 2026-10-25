import { expect, it } from 'vitest';
import { HouseEconomy, ProductionQueues } from '../game/simulation/economy.ts';
import { accelerateProduction } from './production.ts';

it.each([[1, 216], [10, 22], [100, 3]] as const)(
  'finishes demo production at x%i in %i ticks and charges the original price', (speed, ticks) => {
    const house = new HouseEconomy(10000);
    house.power = 100; house.drain = 40;
    const queues = new ProductionQueues(house, [{ type: 'FACT', faction: 1, active: true }]);
    queues.begin('NUKE');
    // FACTORY.CPP / STAGE.H: 108 stages at two ticks per stage, before sandbox acceleration.
    for (let tick = 1; tick < ticks; tick++) accelerateProduction(queues, speed);
    expect(queues.items.get('building')?.complete).toBe(false);
    accelerateProduction(queues, speed);
    expect(queues.items.get('building')?.complete).toBe(true);
    expect(house.money).toBe(9700);
  },
);
