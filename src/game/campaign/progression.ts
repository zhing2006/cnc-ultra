import type { CampaignSide } from './assets.ts';

/** SCENARIO.CPP Do_Win: sabotaging the airstrip in GDI 6 skips mission 7. */
export function completedMission(side: CampaignSide, level: number, sabotaged?: string) {
  return side === 'gdi' && level === 6 && sabotaged === 'AFLD' ? 7 : level;
}

/** INI.CPP Read_Scenario_Ini: convert the percentage to 8.8 before multiplying. */
export function carryCredits(credits: number, percent: number, cap: number) {
  const amount = Math.trunc((credits * Math.trunc(percent * 256 / 100) + 128) / 256);
  return cap < 0 ? amount : Math.min(amount, cap);
}
