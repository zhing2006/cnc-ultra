import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MixFile } from '../formats/mix.ts';
import { readCampaignScenario } from './scenario.ts';
import { CampaignTriggers, type TriggerHouse } from './triggers.ts';
import type { CampaignTrigger } from './scenario.ts';

const mix = new MixFile(readFileSync('assets/dev/general.mix'));
const mission = readCampaignScenario(new TextDecoder('latin1').decode(mix.get('SCG01EA.INI')), mix.get('SCG01EA.BIN')!);
const house = (name: string): TriggerHouse => ({ name, buildings: 3, units: 10, factories: 0, credits: 2000, buildingsLost: 0, unitsLost: 0, discovered: false });

it('fires a semipersistent destruction trigger only after every attached object is destroyed', () => {
  const definition: CampaignTrigger = { name: 'SAM', event: 'Destroyed', action: 'Airstrike', data: 0, house: 'None', team: 'None', persistence: 1 };
  const calls: string[] = [], trigger = new CampaignTriggers([definition], t => { calls.push(t.action); return true; }, { objects: ['SAM', 'SAM'], cells: new Map() });
  trigger.object(0, 'Attacked', 'BadGuy'); trigger.object(0, 'Destroyed', 'BadGuy');
  expect(calls).toEqual([]); expect(trigger.objects.has(0)).toBe(false);
  trigger.object(0, 'Destroyed', 'BadGuy'); trigger.object(1, 'Destroyed', 'BadGuy');
  expect(calls).toEqual(['Airstrike']); expect(trigger.state[0].active).toBe(false);
});

it('uses Any only for object events and preserves capture-before-destruction ordering', () => {
  const definition: CampaignTrigger = { name: 'TECH', event: 'Any', action: 'Cap=Win/Des=Lose', data: 0, house: 'BadGuy', team: 'None', persistence: 0 };
  const calls: string[] = [], trigger = new CampaignTriggers([definition], (_t, event) => { calls.push(event); return event === 'Player Enters' || event === 'Destroyed'; }, { objects: ['TECH'], cells: new Map() });
  trigger.tick(600, [{ ...house('BadGuy'), buildings: 0, units: 0 }]);
  trigger.object(0, 'Discovered', 'BadGuy'); trigger.object(0, 'Player Enters', 'BadGuy'); trigger.object(0, 'Destroyed', 'BadGuy');
  expect(calls).toEqual(['Discovered', 'Player Enters']);
});

it('preserves the first mission reinforcement definitions and six-second trigger countdowns', () => {
  const calls: [number, string][] = []; let frame = 0;
  const triggers = new CampaignTriggers(mission.triggers, trigger => { calls.push([frame, trigger.name]); return true; });
  const houses = [house('GoodGuy'), house('BadGuy')];
  for (frame = 1; frame <= 1500; frame++) triggers.tick(frame, houses);
  // HOUSE.CPP: TriggerTime starts at zero and is reset to TICKS_PER_MINUTE / 10.
  expect(calls).toEqual([[1, 'ATK2'], [181, 'RNF1'], [451, 'RFN2'], [811, 'RNF4'], [1351, 'RNF6']]);
  expect(mission.teams.find(team => team.name === 'GDIR1')!.members).toEqual([{ type: 'E1', count: 3 }, { type: 'LST', count: 1 }]);
  expect(mission.teams.find(team => team.name === 'NOD1')!.orders).toEqual([
    { mission: 'Move', argument: 0 }, { mission: 'Move', argument: 1 }, { mission: 'Move', argument: 2 }, { mission: 'Attack Units', argument: 6 },
  ]);
});

it('waits for the initial destruction grace period and retries failed time reinforcements', () => {
  const calls: [number, string][] = []; let frame = 0, failed = true;
  const triggers = new CampaignTriggers(mission.triggers, trigger => {
    calls.push([frame, trigger.name]);
    if (trigger.name === 'RNF1' && failed) { failed = false; return false; }
    return true;
  });
  const enemy = { ...house('BadGuy'), buildings: 0, units: 0 };
  for (frame = 1; frame <= 451; frame++) triggers.tick(frame, [house('GoodGuy'), enemy]);
  expect(calls.filter(([, name]) => name === 'RNF1')).toEqual([[181, 'RNF1'], [271, 'RNF1']]);
  expect(calls.filter(([, name]) => name === 'WIN')).toEqual([[451, 'WIN']]);
});
