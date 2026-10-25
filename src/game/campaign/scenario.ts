import { Ini } from '../formats/ini.ts';
import { readScenario } from '../formats/scenario.ts';

export interface CampaignTrigger { name: string; event: string; action: string; data: number; house: string; team: string; persistence: number }
export interface CampaignTeam {
  name: string; house: string; roundabout: boolean; learning: boolean; suicide: boolean; autocreate: boolean; mercenary: boolean;
  priority: number; maximum: number; initial: number; fear: number;
  members: { type: string; count: number }[]; orders: { mission: string; argument: number }[];
  reinforcable: boolean; prebuilt: boolean;
}

/** Ported from INI.CPP Read_Scenario_Ini, TRIGGER.CPP Fill_In and TEAMTYPE.CPP Fill_In. */
export function readCampaignScenario(text: string, bin: Uint8Array) {
  const ini = new Ini(text), scenario = readScenario(text, bin);
  const player = ini.get('Basic', 'Player') ?? 'GoodGuy';
  const triggers = ini.entries('Triggers').map(([name, value]): CampaignTrigger => {
    const [event, action, data, house, team, persistence] = value.split(',').map(s => s.trim());
    return { name: name.toUpperCase(), event, action, data: Number(data), house: house === 'None' && event === 'Player Enters' ? player : house, team: team.toUpperCase(), persistence: Number(persistence) || 0 };
  });
  const teams = ini.entries('TeamTypes').map(([name, value]): CampaignTeam => {
    const v = value.split(',').map(s => s.trim()); let at = 11;
    const members = Array.from({ length: Number(v[10]) }, () => { const [type, count] = v[at++].split(':'); return { type, count: Number(count) }; });
    const orders = Array.from({ length: Number(v[at++]) }, () => { const [mission, argument] = v[at++].split(':'); return { mission, argument: Number(argument) }; });
    return { name: name.toUpperCase(), house: v[0], roundabout: v[1] === '1', learning: v[2] === '1', suicide: v[3] === '1', autocreate: v[4] === '1', mercenary: v[5] === '1',
      priority: Number(v[6]), maximum: Number(v[7]), initial: Number(v[8]), fear: Number(v[9]), members, orders, reinforcable: v[at++] !== '0', prebuilt: v[at] !== '0' };
  });
  const movie = (key: string) => { const value = ini.get('Basic', key); return !value || value.toUpperCase() === 'X' ? undefined : value; };
  const houses = ['GoodGuy', 'BadGuy', 'Neutral', 'Special', 'Multi1', 'Multi2', 'Multi3', 'Multi4', 'Multi5', 'Multi6'].map(name => ({ name,
    maxUnits:Math.max(150,ini.int(name,'MaxUnit',150)),maxBuildings:Math.max(150,ini.int(name,'MaxBuilding',150)),
    credits: ini.int(name, 'Credits', 0) * 100, edge: ini.get(name, 'Edge') || 'North', allies: (ini.get(name, 'Allies') || (name === 'GoodGuy' ? 'GoodGuy,Neutral' : name)).split(',').map(value => value.trim()) }));
  return { scenario, player, houses, triggers, teams,
    base: Array.from({ length: ini.int('Base', 'Count', 0) }, (_, index) => {
      const [type, coordinate] = (ini.get('Base', String(index).padStart(3, '0')) ?? '').split(',');
      const packed = Number(coordinate) >>> 0;
      return { type, cell: ((packed >>> 24) & 255) * 64 + ((packed >>> 8) & 255) };
    }),
    buildLevel: ini.int('Basic', 'BuildLevel', 1), carryOverMoney: ini.int('Basic', 'CarryOverMoney', 100), carryOverCap: ini.int('Basic', 'CarryOverCap', -1),
    theme: ini.get('Basic', 'Theme') ?? 'No theme',
    movies: { intro: movie('Intro'), brief: movie('Brief'), action: movie('Action'), win: movie('Win'), lose: movie('Lose') },
    cellTriggers: new Map(ini.entries('CellTriggers').map(([cell, name]) => [Number(cell), name.toUpperCase()])),
    objectTriggers: ['UNITS', 'INFANTRY', 'STRUCTURES'].flatMap(section => ini.entries(section).map(([, value]) => value.split(',').at(-1)!.trim().toUpperCase())),
  };
}
export type CampaignScenario = ReturnType<typeof readCampaignScenario>;

/** INI.CPP Read_Scenario_Ini: numbered Briefing entries, then the shared MISSION.INI. */
export function readBriefing(name: string, scenario: string, shared = '') {
  const read = (ini: Ini, section: string) => {
    const lines: string[] = [];
    for (let index = 1; ; index++) { const line = ini.get(section, String(index)); if (!line) break; lines.push(line); }
    return lines.join(' ');
  };
  return read(new Ini(scenario), 'Briefing') || read(new Ini(shared), name);
}
