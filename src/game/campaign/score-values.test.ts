import { expect, it } from 'vitest';
import { CampaignSession } from './session.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';

it('counts surviving Logic objects for leadership without counting wall overlays', () => {
  const inventory = new Int32Array(MOVEMENT.length * 3);
  inventory[movementType('E1')] = 1;
  inventory[movementType('FACT')] = 1;
  for (const wall of ['SBAG', 'CYCL', 'BRIK', 'BARB', 'WOOD']) inventory[movementType(wall)] = 20;
  const session = Object.assign(Object.create(CampaignSession.prototype) as CampaignSession, {
    side: 'gdi', name: 'SCG08EA', runtime: {
      inventory, houses: [{ lost: 1, buildingsLost: 1, economy: { money: 1000, harvested: 0 } }, {}, {}],
      world: { credits: 1000 }, mission: { buildLevel: 8 }, frame: 900,
    },
  });
  expect(session.score().leadership).toBe(50);
});
