import { expect, it } from 'vitest';
import { PRODUCTION } from '../data/production.ts';
import { canBuildCampaign } from './production.ts';

it('keeps both GDI training missions below refinery and grenadier technology', () => {
  const base = ['FACT', 'NUKE', 'PYLE'].map(type => ({ type, faction: 1, active: true }));
  for (const mission of [1, 2]) {
    expect(canBuildCampaign(PRODUCTION.get('E1')!, 1, 1, base, mission)).toBe(true);
    expect(canBuildCampaign(PRODUCTION.get('PROC')!, 1, 1, base, mission)).toBe(false);
    expect(canBuildCampaign(PRODUCTION.get('E2')!, 1, 1, base, mission)).toBe(false);
  }
  expect(canBuildCampaign(PRODUCTION.get('PROC')!, 1, 1, base, 3)).toBe(true);
  expect(canBuildCampaign(PRODUCTION.get('E2')!, 1, 1, base, 3)).toBe(true);
});

it('applies campaign faction restrictions even after capturing factories', () => {
  const base = ['FACT', 'NUKE', 'PROC', 'WEAP', 'HQ', 'PYLE', 'MISS'].map(type => ({ type, faction: 2, active: true }));
  expect(canBuildCampaign(PRODUCTION.get('OBLI')!, 2, 1, base, 15)).toBe(false);
  expect(canBuildCampaign(PRODUCTION.get('HPAD')!, 2, 2, base, 15)).toBe(false);
  expect(canBuildCampaign(PRODUCTION.get('APC')!, 2, 2, base, 15)).toBe(false);
  expect(canBuildCampaign(PRODUCTION.get('STNK')!, 2, 2, base, 11)).toBe(true);
  expect(canBuildCampaign(PRODUCTION.get('STNK')!, 2, 2, base.filter(b => b.type !== 'MISS'), 11)).toBe(false);
});
