// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { BODY_SHAPE, facingTo32 } from './coord.ts';
import { BUILDINGS, type BuildingType } from './data/buildings.ts';
import { buildableTemplate } from './data/land.ts';
import { OVERLAYS } from './data/overlays.ts';
import { bibWidth } from './data/smudges.ts';
import { TEMPLATES } from './data/templates.ts';
import { TERRAIN } from './data/terrain.ts';
import { ORIGINAL_MAP_SIZE, type PlacedBuilding, type PlacedSmudge, type Scenario } from './formats/scenario.ts';

/** A cell graphic, with the frame selected by the original's initial placement rules. */
export interface CellImage { type: string; cell: number; frame: number }

const ADJACENT = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const DENSITY = [0, 1, 3, 4, 6, 7, 8, 10, 11];

/**
 * Ported from BUILDING.CPP, BuildingClass::Mark; OVERLAY.CPP, OverlayClass::Mark;
 * SMUDGE.CPP, SmudgeClass::Mark/Read_INI; CELL.CPP, Wall_Update/Tiberium_Adjust; and MAP.CPP, Overpass.
 * ScenarioInit makes Is_Generally_Clear true while loading, even underneath other objects.
 */
export function initialCellImages(scenario: Scenario): { smudges: CellImage[]; overlays: CellImage[] } {
  const mapWidth = scenario.mapWidth ?? ORIGINAL_MAP_SIZE;
  const mapHeight = scenario.mapHeight ?? ORIGINAL_MAP_SIZE;
  const neighbor = (cell: number, dx: number, dy: number): number => {
    const x = cell % mapWidth + dx;
    const y = Math.floor(cell / mapWidth) + dy;
    return x < 0 || y < 0 || x >= mapWidth || y >= mapHeight ? -1 : y * mapWidth + x;
  };
  const smudges = new Map<number, CellImage>();
  const overlays = new Map<number, CellImage>();
  const trees = new Set<number>();
  const inside = (cell: number) => {
    const x = cell % mapWidth, y = Math.floor(cell / mapWidth);
    return x >= scenario.x && x < scenario.x + scenario.width && y >= scenario.y && y < scenario.y + scenario.height;
  };
  for (const object of scenario.terrain) {
    for (const [x, y] of TERRAIN.get(object.type.toUpperCase())?.occupy ?? []) trees.add(neighbor(object.cell, x, y));
  }
  const putSmudge = ({ type, cell, frame }: PlacedSmudge) => {
    type = type.toUpperCase();
    const width = bibWidth(type);
    if (width) {
      for (let y = 0; y < 2; y++) for (let x = 0; x < width; x++) {
        const at = neighbor(cell, x, y);
        if (inside(at)) smudges.set(at, { type, cell: at, frame: y * width + x });
      }
    } else if (inside(cell)) {
      const old = smudges.get(cell);
      if (type.startsWith('CR') && old?.type.startsWith('CR')) old.frame = Math.min(old.frame + 1, 4);
      // Cell_Coord is at the centre, so Spot_Index chooses CR1 for a newly placed crater.
      if (!old) smudges.set(cell, { type: type.startsWith('CR') ? 'CR1' : type, cell, frame: 0 });
    }
    const image = smudges.get(cell);
    if (image?.type === type && frame) image.frame = frame;
  };
  for (const building of scenario.buildings) {
    const type = BUILDINGS.get(building.type.toUpperCase());
    if (!type) throw new Error(`unknown building type ${building.type}`);
    if (OVERLAYS.get(type.name)?.wall) overlays.set(building.cell, { type: type.name, cell: building.cell, frame: 0 });
    if (type.bib && type.width >= 2 && type.width <= 4) {
      putSmudge({ type: `BIB${5 - type.width}`, cell: neighbor(building.cell, 0, type.height - 1), frame: 0 });
    }
  }
  const density = (cell: number) => DENSITY[ADJACENT.filter(([x, y]) => {
    const other = overlays.get(neighbor(cell, x, y));
    return other && OVERLAYS.get(other.type)?.tiberium;
  }).length];
  for (const entry of scenario.overlays) {
    const type = OVERLAYS.get(entry.type.toUpperCase());
    if (!type) throw new Error(`unknown overlay type ${entry.type}`);
    const old = overlays.get(entry.cell);
    if (type.wall || ((!old || old.type === 'SQUISH') && !trees.has(entry.cell)
      && buildableTemplate(TEMPLATES[scenario.templates[entry.cell]]?.name ?? 'CLEAR1', scenario.icons[entry.cell]))) {
      overlays.set(entry.cell, { type: type.name, cell: entry.cell, frame: type.tiberium ? density(entry.cell) : 0 });
    }
  }
  for (const image of overlays.values()) {
    const type = OVERLAYS.get(image.type)!;
    if (type.wall) {
      image.frame = ADJACENT.reduce((bits, [x, y], i) => bits | (i % 2 === 0
        && overlays.get(neighbor(image.cell, x, y))?.type === image.type ? 1 << (i / 2) : 0), 0);
    } else if (type.tiberium && inside(image.cell)
      && Math.floor(image.cell / mapWidth) < scenario.y + scenario.height - 1) {
      image.frame = density(image.cell);
    }
  }
  // The original picks one of twelve equally likely images in Tiberium_Adjust(true).
  // This fixed seed and cell hash replace its global RNG for a repeatable static view (technical art. 16).
  for (const image of overlays.values()) if (OVERLAYS.get(image.type)!.tiberium
    && inside(image.cell) && Math.floor(image.cell / mapWidth) < scenario.y + scenario.height - 1) {
    let hash = (image.cell ^ 0x95c0ffee) >>> 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
    hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
    image.type = `TI${((hash ^ (hash >>> 16)) >>> 0) % 12 + 1}`;
  }
  for (const smudge of scenario.smudges) putSmudge(smudge);
  return { smudges: [...smudges.values()], overlays: [...overlays.values()] };
}

/** Ported from BUILDING.CPP, BuildingClass::Draw_It, with idle animations stopped at their first frame. */
export function buildingFrame(building: PlacedBuilding, type: BuildingType, count: number): number {
  // BuildingClass::Read_INI uses COORDA.ASM, Fixed_To_Cardinal, which rounds to the nearest integer.
  const hp = (type.strength * Math.min(building.strength, 256) + 0x80) >> 8;
  const damaged = Math.floor(hp * 256 / type.strength) < 128;
  if (type.turret) return (type.name === 'SAM' ? 0 : BODY_SHAPE[facingTo32(building.facing)]) + (damaged ? 64 : 0);
  if (hp <= 1) return count - 1;
  if (type.name === 'WEAP') return damaged ? 1 : 0;
  if (type.name === 'SILO') return damaged ? 5 : 0;
  return damaged ? (type.simpleDamage ? count - 2 : type.damageOffset) : 0;
}

/** Ported from BUILDING.CPP, CenterOffset and BuildingClass::Sort_Y (coordinates in leptons).
 * mapWidth is the storage stride, not the playable rectangle's width. */
export function buildingPosition(building: PlacedBuilding, type: BuildingType, mapWidth = ORIGINAL_MAP_SIZE) {
  const x = (building.cell % mapWidth) * 256;
  const y = Math.floor(building.cell / mapWidth) * 256;
  const centerX = x + (type.width === 2 ? 255 : type.width * 128);
  const centerY = y + (type.height === 2 ? 255 : type.height * 128);
  return {
    centerX, centerY,
    sortX: type.name === 'FIX' ? x : centerX,
    sortY: type.name === 'FIX' ? y : centerY + (type.name === 'PYLE' || type.name === 'PROC' ? 0 : Math.floor(type.height * 256 / 3)),
  };
}
