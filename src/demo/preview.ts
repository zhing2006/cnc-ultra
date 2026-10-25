import { AIRCRAFT } from '../game/data/aircraft.ts';
import { BUILDINGS } from '../game/data/buildings.ts';
import { INFANTRY } from '../game/data/infantry.ts';
import { TERRAIN } from '../game/data/terrain.ts';
import { UNITS } from '../game/data/units.ts';
import { CLOAK_STAGES, type CloakStage } from '../game/cloak.ts';
import type { MixSet } from '../game/formats/mix.ts';
import { ORIGINAL_MAP_SIZE, TEMPLATE_NONE, type PlacedUnit, type Scenario } from '../game/formats/scenario.ts';
import { buildScene } from '../game/scene.ts';

export interface PreviewSettings {
  group: 'units' | 'buildings' | 'terrain' | 'cloak';
  theater: 'TEMPERATE' | 'DESERT';
  house: string;
  facing: number;
  buildingState: 'intact' | 'damaged' | 'ruined';
  cloak: CloakStage;
}

/** A display-only scenario. No preview settings are written into the original mission. */
export function buildPreview(mix: MixSet, settings: PreviewSettings) {
  const suffix = settings.theater === 'DESERT' ? 'DES' : 'TEM';
  const unitNames = [...UNITS.keys(), ...INFANTRY.keys(), ...AIRCRAFT];
  const names = settings.group === 'units' ? unitNames
    : settings.group === 'buildings' ? [...BUILDINGS.values()].filter(t => mix.get(`${t.name}.${t.theater ? suffix : 'SHP'}`)).map(t => t.name)
    : settings.group === 'terrain' ? [...TERRAIN.keys()].filter(name => mix.get(`${name}.${suffix}`))
    : [...CLOAK_STAGES];
  const columns = settings.group === 'cloak' ? 3 : 6;
  const cellsPerItem = settings.group === 'cloak' ? 10 : 5;
  const stride = cellsPerItem * 24;
  const rows = Math.ceil(names.length / columns);
  const scenario: Scenario = {
    theater: settings.theater, x: 0, y: 0, width: columns * cellsPerItem, height: rows * cellsPerItem,
    templates: new Uint8Array(ORIGINAL_MAP_SIZE ** 2).fill(TEMPLATE_NONE),
    icons: new Uint8Array(ORIGINAL_MAP_SIZE ** 2),
    units: [], infantry: [], aircraft: [], buildings: [], terrain: [], overlays: [], smudges: [], waypoints: new Map(),
  };
  const stages = new Map<number, CloakStage>();
  const entries = names.map((name, i) => {
    const column = i % columns, row = Math.floor(i / columns);
    const x = column * cellsPerItem, y = row * cellsPerItem;
    const cell = (y + Math.floor(cellsPerItem / 2) + 1) * ORIGINAL_MAP_SIZE + x + Math.floor(cellsPerItem / 2);
    const unit: PlacedUnit = { type: name, cell, house: settings.house, strength: 256, facing: settings.facing, mission: 'Guard' };
    if (settings.group === 'buildings') {
      const type = BUILDINGS.get(name)!;
      scenario.buildings.push({ ...unit, strength: settings.buildingState === 'intact' ? 256 : settings.buildingState === 'damaged' ? 96 : 0,
        cell: (y + 1) * ORIGINAL_MAP_SIZE + x + Math.floor((cellsPerItem - type.width) / 2) });
    } else if (settings.group === 'terrain') {
      scenario.terrain.push({ type: name, cell: (y + 1) * ORIGINAL_MAP_SIZE + x + 1 });
    } else if (settings.group === 'cloak') {
      scenario.units.push({ ...unit, type: 'STNK' });
      stages.set(cell, name as CloakStage);
      const tree = settings.theater === 'DESERT' ? 'T04' : 'T01';
      scenario.terrain.push({ type: tree, cell: cell - 2 * ORIGINAL_MAP_SIZE }, { type: tree, cell: cell - 1 });
      scenario.buildings.push({ ...unit, type: 'NUKE', cell: cell - ORIGINAL_MAP_SIZE - 1 });
    } else if (INFANTRY.has(name)) {
      scenario.infantry.push({ ...unit, spot: 0 });
    } else if (UNITS.has(name)) {
      scenario.units.push(unit);
      if (name === 'STNK') stages.set(cell, settings.cloak);
    } else {
      scenario.aircraft!.push(unit);
    }
    return { name, x: column * stride, y: row * stride };
  });
  return { scene: buildScene(mix, scenario, stages), entries, width: columns * stride, height: rows * stride, stride };
}
