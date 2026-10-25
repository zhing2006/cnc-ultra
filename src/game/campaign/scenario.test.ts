import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MixFile, MixSet } from '../formats/mix.ts';
import { readCampaignScenario, readBriefing } from './scenario.ts';
import { campaignScene } from './scene.ts';
import { areAllied } from '../simulation/alliances.ts';

it('uses numbered mission text, falling back to the original shared briefing file', () => {
  expect(readBriefing('SCG01EA', '[Briefing]\n1=Establish a base.\n2=Destroy the enemy.', '')).toBe('Establish a base. Destroy the enemy.');
  expect(readBriefing('SCG01EA', '', '[SCG01EA]\n1=Establish a base.')).toBe('Establish a base.');
});
it('keeps the original default team flags when optional fields are absent',()=>{
  const mission=readCampaignScenario('[Basic]\nPlayer=GoodGuy\n[Map]\nTheater=TEMPERATE\n[TeamTypes]\nTEST=BadGuy,0,0,0,0,0,7,1,0,0,1,E1:2,1,Guard:1',new Uint8Array(8192));
  expect(mission.teams[0].reinforcable).toBe(true);expect(mission.teams[0].prebuilt).toBe(true);
});

if (existsSync('data/nod/general.mix')) describe('Original campaign world data', () => {
  const load = (name: string) => new MixFile(readFileSync(existsSync(`assets/dev/${name}`) ? `assets/dev/${name}` : `data/${name}`));
  const common = ['update.mix', 'updatec.mix', 'conquer.mix', 'cclocal.mix', 'sounds.mix', 'speech.mix'].map(load);
  const theaters = new Map<string, MixFile[]>([
    ['TEMPERATE', ['temperat.mix', 'tempicnh.mix'].map(load)],
    ['DESERT', ['desert.mix', 'deseicnh.mix'].map(load)],
    ['WINTER', ['winter.mix', 'winticnh.mix'].map(load)],
  ]);
  it('rounds initial strength like Fixed_To_Cardinal and clamps buildings',()=>{
    const archive=load('gdi/general.mix');
    const mission=readCampaignScenario(new TextDecoder().decode(archive.get('SCG01EA.INI')),archive.get('SCG01EA.BIN')!);
    mission.scenario.units=[{type:'MTNK',house:'GoodGuy',cell:3450,strength:200,facing:0,mission:'Guard'}];
    mission.scenario.infantry=[];mission.scenario.buildings=[{type:'NUKE',house:'GoodGuy',cell:3400,strength:300,facing:0}];
    const world=campaignScene(new MixSet([...common,archive,...theaters.get('TEMPERATE')!]),mission);
    expect(world.setup.units[0].health).toBe(313);expect(world.setup.units[1].health).toBe(400);
  });
  let count = 0;
  for (const [side, letter, maximum] of [['gdi', 'G', 15], ['nod', 'B', 13]] as const) {
    const archive = load(`${side}/general.mix`);
    for (let level = 1; level <= maximum; level++) for (const direction of ['E', 'W']) for (const variant of 'ABCDE') {
      const name = `SC${letter}${String(level).padStart(2, '0')}${direction}${variant}`, ini = archive.get(`${name}.INI`), bin = archive.get(`${name}.BIN`);
      if (!ini || !bin) continue;
      count++;
      it(`${name} retains all original objects and their houses`, () => {
        const mission = readCampaignScenario(new TextDecoder().decode(ini), bin); mission.buildLevel = level;
        const world = campaignScene(new MixSet([...common, archive, ...theaters.get(mission.scenario.theater.toUpperCase())!]), mission);
        const original = [...mission.scenario.units, ...mission.scenario.infantry, ...mission.scenario.buildings];
        expect(world.setup.units.filter(unit => unit.health! > 0)).toHaveLength(original.length);
        original.forEach((unit, index) => {
          expect(world.houseNames[world.setup.units[index].owner!]).toBe(unit.house);
          expect(world.setup.units[index].cell).toBe(unit.cell);
          expect(world.scene.animation!.frames.has(unit.type)).toBe(true);
        });
        expect(areAllied(world.setup, 0, 0)).toBe(true);
        expect(areAllied(world.setup, 0, 2)).toBe(mission.houses.find(house => house.name === mission.player)!.allies.includes('Neutral'));
      });
    }
  }
  it('covers all 51 original campaign maps', () => { expect(count).toBe(51); });
});
