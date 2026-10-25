import type { CampaignSide } from './assets.ts';
import { COUNTRY_ROUTES } from './map-data.ts';

/** MAPSEL.CPP Map_Selection: choose both the direction and variant before advancing. */
export function nextCampaignMission(side: CampaignSide, name: string, completed: number, choice: number) {
  const direction = name[5] === 'W' ? 1 : 0, row = COUNTRY_ROUTES[completed + (side === 'nod' ? 14 : 0)];
  const suffix = row?.choices[direction]
    ? `${row.directions[direction][choice] === 1 ? 'W' : 'E'}${String.fromCharCode(65 + row.variants[direction][choice])}`
    : name.slice(5);
  return `SC${side === 'gdi' ? 'G' : 'B'}${String(completed + 1).padStart(2, '0')}${suffix}`;
}
