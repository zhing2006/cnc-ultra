import { expect, it } from 'vitest';
import { demoConfig } from './game.ts';

it('starts an unspecified match with seed 1995', () => {
  expect(demoConfig('?demo=match')?.seed).toBe(1995);
});

it.each([0, 42, 4294967295])('honors explicit URL seed %i', seed => {
  expect(demoConfig(`?demo=match&seed=${seed}`)?.seed).toBe(seed);
});
