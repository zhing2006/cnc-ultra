import { expect, it } from 'vitest';
import { planBase, ratioLimit, whichZone } from './base-planning.ts';

it('uses building centers and cost weights in the imported base calculation',()=>{
  const plan=planBase([{type:'FACT',cell:2},{type:'NUKE',cell:10}],20);
  expect([plan.x,plan.y,plan.radius]).toEqual([1170,255,512]);
  expect(whichZone(plan,plan.x,plan.y)).toBe(0);
  expect(whichZone(plan,plan.x+1024,plan.y)).toBe(2);
  expect(whichZone(plan,plan.x+2049,plan.y)).toBe(-1);
});

it('preserves the remaster Round_Up helper, including its exact-integer branch',()=>{
  expect(ratioLimit(7,40)).toBe(2);
  expect(ratioLimit(32,40)).toBe(1280);
});
