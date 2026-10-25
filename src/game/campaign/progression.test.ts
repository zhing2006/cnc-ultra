import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MixFile } from '../formats/mix.ts';
import { COUNTRY_ROUTES } from './map-data.ts';
import { carryCredits, completedMission } from './progression.ts';
import { nextCampaignMission } from './country-route.ts';

it('retains the original eastern and western GDI branches and the airstrip skip', () => {
  expect([0,1,2].map(choice=>nextCampaignMission('gdi','SCG03EA',3,choice))).toEqual(['SCG04WA','SCG04WB','SCG04EA']);
  expect(nextCampaignMission('gdi','SCG04WA',4,1)).toBe('SCG05WB');
  // MAPSEL.CPP deliberately assigns variant A to both eastern mission-4 choices.
  expect(nextCampaignMission('gdi','SCG04EA',4,1)).toBe('SCG05EA');
  expect(nextCampaignMission('gdi','SCG06EA',completedMission('gdi',6,'AFLD'),1)).toBe('SCG08EB');
  expect(completedMission('gdi',6,'HAND')).toBe(6);
  expect(completedMission('nod',6,'AFLD')).toBe(6);
});

it('uses the original fixed-point carry percentage, rounding and destination cap', () => {
  expect(carryCredits(12345,33,-1)).toBe(4051);
  expect(carryCredits(3,50,-1)).toBe(2);
  expect(carryCredits(12345,100,3000)).toBe(3000);
});

if(existsSync('data/nod/general.mix'))it('resolves every reachable original campaign branch to a real map through both finales', () => {
  for(const [side,first,last] of [['gdi','SCG01EA',15],['nod','SCB01EA',13]] as const){
    const archive=new MixFile(readFileSync(`data/${side}/general.mix`)),seen=new Set<string>(),queue=[first as string];
    while(queue.length){
      const name=queue.shift()!;if(seen.has(name))continue;seen.add(name);
      expect(archive.get(`${name}.INI`),name).toBeDefined();expect(archive.get(`${name}.BIN`),name).toBeDefined();
      const level=Number(name.slice(3,5));if(level===last)continue;
      for(let choice=0;choice<COUNTRY_ROUTES[level+(side==='nod'?14:0)].choices[name[5]==='W'?1:0];choice++)queue.push(nextCampaignMission(side,name,level,choice));
    }
    expect(seen.size).toBe(25);
    expect([...seen].filter(name=>Number(name.slice(3,5))===last).sort()).toEqual(['A','B','C'].map(variant=>`${first.slice(0,3)}${last}E${variant}`));
    if(side==='gdi'){expect(archive.get('SCG05EB.INI')).toBeDefined();expect(seen.has('SCG05EB')).toBe(false);}
  }
});
