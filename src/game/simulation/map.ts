// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { gridEdges } from '../../engine/simulation/state.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { TERRAIN } from '../data/terrain.ts';
import { OVERLAYS } from '../data/overlays.ts';
import { TEMPLATES } from '../data/templates.ts';
import { templateLand, WALKABLE_LAND } from '../data/land.ts';
import { decodeIconSet } from '../formats/icons.ts';
import { ORIGINAL_MAP_SIZE, TEMPLATE_NONE, type Scenario } from '../formats/scenario.ts';
import type { MixSet } from '../formats/mix.ts';
import { initialCellImages } from '../map-visuals.ts';

// Ported from CONST.CPP, StoppingCoordAbs; and DEFINES.H, TICKS_PER_SECOND.
export const INFANTRY_SPOTS: readonly (readonly [number, number])[] = [[128,128],[64,64],[192,64],[64,192],[192,192]];
export const LOGIC_HZ = 15;

/**
 * Ported from CELL.CPP, Recalc_Attributes; UNIT.CPP/INFANTRY.CPP, Can_Enter_Cell;
 * TERRAIN.CPP/BUILDING.CPP, Occupy_List. Combat and building entry are not part of this movement demo.
 */
export function movementMap(mix: MixSet, scenario: Scenario) {
  const width = ORIGINAL_MAP_SIZE, passable = new Uint8Array(width * width);
  const lands = new Uint8Array(width * width);
  const suffix = scenario.theater.toUpperCase() === 'TEMPERATE' ? 'TEM' : scenario.theater.toUpperCase().slice(0,3);
  const maps = new Map<number, Uint8Array>();
  for (let y = scenario.y; y < scenario.y + scenario.height; y++) for (let x = scenario.x; x < scenario.x + scenario.width; x++) {
    const cell = y * width + x, template = scenario.templates[cell];
    let land = 0;
    if (template !== TEMPLATE_NONE && template !== 0) {
      const type = TEMPLATES[template];
      if (type) {
        if (!maps.has(template)) {
          const data = mix.get(`${type.name}.${suffix}`);
          maps.set(template, data ? decodeIconSet(data).map : new Uint8Array());
        }
        const map = maps.get(template)!;
        // Ported from MAP.CPP, Read_Binary: absent icons become clear cells.
        const icon = scenario.icons[cell];
        if (icon < map.length && map[icon] !== 255) land = templateLand(type.name, icon);
      }
    }
    passable[cell] = WALKABLE_LAND[land] ? 1 : 0;
    lands[cell] = land;
  }
  const block = (cell: number, offsets: readonly (readonly [number, number])[]) => {
    const x = cell % width, y = Math.floor(cell / width);
    for (const [dx,dy] of offsets) if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < width) passable[(y + dy) * width + x + dx] = 0;
  };
  // Non-clear overlays replace the underlying land type before object occupancy is checked.
  for (const overlay of initialCellImages(scenario).overlays) {
    const type = OVERLAYS.get(overlay.type)!;
    // ODATA.CPP: V12..V18 are rock; road, concrete and tiberium replace the underlying ground.
    if (type.wall || /^V1[2-8]$/.test(type.name)) passable[overlay.cell] = 0;
    else if (type.tiberium || type.name === 'ROAD' || type.name === 'CONC') passable[overlay.cell] = 1;
    if (type.wall) lands[overlay.cell] = 4;
    else if (/^V1[2-8]$/.test(type.name)) lands[overlay.cell] = 3;
    else if (type.tiberium) lands[overlay.cell] = 5;
    else if (type.name === 'ROAD' || type.name === 'CONC') lands[overlay.cell] = 1;
  }
  for (const object of scenario.terrain) block(object.cell, TERRAIN.get(object.type.toUpperCase())!.occupy);
  for (const object of scenario.buildings) block(object.cell, BUILDINGS.get(object.type.toUpperCase())!.occupy);
  // UnitClass::Can_Enter_Cell ignores facing. DriveClass::Start_Of_Move checks the destination
  // cell for diagonal steps as well; it does not require both orthogonal neighbors to be clear.
  return { passable, land: lands, grid: gridEdges(width, width, passable, true) };
}
