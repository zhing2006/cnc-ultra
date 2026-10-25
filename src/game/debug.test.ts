import { describe, expect, it } from 'vitest';
import { gridEdges } from '../engine/simulation/state.ts';
import { DAMAGE_SCALE, scaleIncomingDamage } from './debug.ts';
import { movementType } from './data/movement.ts';
import { CpuCombat } from './simulation/combat-cpu.ts';
import { HouseEconomy, ProductionQueues } from './simulation/economy.ts';
import * as U from './simulation/units-state.ts';
import * as C from './simulation/combat-state.ts';
import { campaignEvents,GpuCampaignEvents,ATTACKED } from './campaign/events.ts';

describe('Debug adjustments', () => {
  it('retains attacked events and retaliation when Debug prevents health loss',()=>{
    const setup={grid:gridEdges(20,12,new Uint8Array(240).fill(1),true),land:new Uint8Array(240),seed:1995,
      units:[{type:movementType('MTNK'),cell:105},{type:movementType('MTNK'),cell:107,owner:1}]};
    const battle=new CpuCombat(setup),previous=GpuCampaignEvents.initial(setup);
    battle.debugDamageOwner=0;battle.debugDamageScale=0;
    battle.state[C.CSCAN]=100;
    battle.queueExplosions([{frame:1,x:battle.units[U.UX],y:battle.units[U.UY],damage:100,warhead:3,source:1}]);
    battle.step();
    expect(battle.units[U.UHEALTH]).toBe(400);
    expect(campaignEvents(battle,previous)[0]&ATTACKED).toBe(ATTACKED);
    expect(battle.state[C.CTARGET]).toBe(1);
  });
  it.each([0, 250, 500, 1000])('scales player blast damage to %i thousandths without changing enemy damage', scale => {
    const setup = { grid: gridEdges(20, 12, new Uint8Array(240).fill(1), true), land: new Uint8Array(240), seed: 1995,
      units: [{ type: movementType('MCV'), cell: 42 }, { type: movementType('MCV'), cell: 198, owner: 1 }] };
    const battle = new CpuCombat(setup); battle.debugDamageOwner = 0; battle.debugDamageScale = scale;
    battle.queueExplosions([0, 1].map(id => ({ frame: 1, x: battle.units[id * U.WORDS], y: battle.units[id * U.WORDS + 1], damage: 100, warhead: 3, source: -1 })));
    battle.step();
    const enemyDamage = 600 - battle.units[U.WORDS + U.UHEALTH];
    expect(enemyDamage).toBe(69); // CONST.CPP: fire/aluminum is 176/256, rounded by Fixed_To_Cardinal.
    expect(600 - battle.units[U.UHEALTH]).toBe(scale ? Math.max(1, Math.trunc(69 * scale / DAMAGE_SCALE)) : 0);
  });
  it.each([0, 500, 1000])('applies %i thousandths to crushing', scale => {
    const battle = new CpuCombat({ grid: gridEdges(12, 8, new Uint8Array(96).fill(1), true), land: new Uint8Array(96), seed: 1995,
      units: [{ type: movementType('MTNK'), cell: 26, owner: 1 }, { type: movementType('C1'), cell: 27 }] });
    battle.debugDamageOwner = 0; battle.debugDamageScale = scale; battle.movement.frame = 1;
    battle.units[U.UOVERRUN_CELL] = 27; battle.units[U.UOVERRUN_X] = battle.units[U.WORDS]; battle.units[U.UOVERRUN_Y] = battle.units[U.WORDS + 1];
    battle.resolveStep();
    expect(battle.units[U.WORDS + U.UHEALTH]).toBe(25 - Math.trunc(25 * scale / DAMAGE_SCALE));
    expect(battle.state[C.CWORDS + C.CDEATH]).toBe(scale === 1000 ? 1 : -1);
  });
  it('uses integer scaling without overflowing large hits', () => {
    expect(scaleIncomingDamage(2147483647, 0, 0, 500)).toBe(1073741823);
    expect(scaleIncomingDamage(1, 0, 0, 1)).toBe(1);
    expect(scaleIncomingDamage(0, 0, 0, 1000)).toBe(0);
  });
  it('edits available money without inventing ore or harvest statistics', () => {
    const house = new HouseEconomy(200); house.capacity = 1000; house.harvest(800);
    house.setDebugMoney(12345);
    expect([house.money, house.tiberium, house.harvested]).toEqual([12345, 800, 800]);
    house.setDebugMoney(100);
    expect([house.money, house.tiberium, house.credits, house.harvested]).toEqual([100, 0, 100, 800]);
  });
  it.each([1, 10, 100])('accelerates production %i times while charging the original price', speed => {
    const make = () => {
      const house = new HouseEconomy(10000); house.power = 100;
      const queue = new ProductionQueues(house, [{ type: 'PYLE', faction: 1, active: true }, { type: 'NUKE', faction: 1, active: true }]);
      expect(queue.begin('E1')).toBe(true); return { house, queue };
    };
    const normal = make(), fast = make();
    for (let tick = 0; tick < 3; tick++) { fast.queue.step(speed); for (let step = 0; step < speed; step++) normal.queue.step(); }
    expect(fast.queue.saveState()).toEqual(normal.queue.saveState());
    expect(fast.house.money).toBe(normal.house.money);
    while (!fast.queue.items.get('infantry')!.complete) fast.queue.step(speed);
    expect(fast.house.money).toBe(9900);
  });
});
