import { Ini } from './ini.ts';

/** Original maps are always 64×64 cells, and a cell number packs y * 64 + x (MAP_CELL_W in DEFINES.H). */
export const ORIGINAL_MAP_SIZE = 64;

/** The template value a map file uses for a cell without a template (TEMPLATE_NONE in DEFINES.H). */
export const TEMPLATE_NONE = 255;

export interface PlacedUnit {
  house: string;
  type: string;
  strength: number;
  cell: number;
  facing: number;
  mission: string;
}

export interface PlacedInfantry extends PlacedUnit {
  /** Which of the five spots in the cell: centre, upper left, upper right, lower left, lower right. */
  spot: number;
}

export interface PlacedBuilding {
  house: string;
  type: string;
  strength: number;
  cell: number;
  facing: number;
}

export interface PlacedTerrain { type: string; cell: number }
export interface PlacedSmudge extends PlacedTerrain { frame: number }

/** A scenario's initial, static map contents. */
export interface Scenario {
  theater: string;
  /** Storage dimensions, distinct from the playable rectangle below; omitted axes default to 64.
   * Cell numbers index row-major storage as y * mapWidth + x. */
  mapWidth?: number;
  mapHeight?: number;
  /** The playable area in cells (DisplayClass::Read_INI reads it from [MAP]). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Template type and icon for each storage cell; original BIN files contain 64 × 64 cells. */
  templates: Uint8Array;
  icons: Uint8Array;
  units: PlacedUnit[];
  infantry: PlacedInfantry[];
  buildings: PlacedBuilding[];
  terrain: PlacedTerrain[];
  overlays: PlacedTerrain[];
  smudges: PlacedSmudge[];
  /** Parked aircraft for static previews; campaign aircraft arrive later as reinforcements. */
  aircraft?: PlacedUnit[];
  /** Waypoint number to cell number, for the waypoints that are set. */
  waypoints: Map<number, number>;
}

/**
 * Reads a scenario from its INI text and BIN data. The fields and their order follow INI.CPP,
 * Read_Scenario_Ini, DisplayClass::Read_INI in DISPLAY.CPP, MapClass::Read_Binary in MAP.CPP and the
 * Read_INI functions of UnitClass and InfantryClass. Units come before infantry, in file order, which
 * is the order the original reads them in.
 */
export function readScenario(iniText: string, bin: Uint8Array): Scenario {
  const ini = new Ini(iniText);
  const cellCount = ORIGINAL_MAP_SIZE * ORIGINAL_MAP_SIZE;
  if (bin.length < cellCount * 2) throw new Error('a map BIN file holds two bytes for each of the 64 × 64 cells');
  const templates = new Uint8Array(cellCount);
  const icons = new Uint8Array(cellCount);
  for (let cell = 0; cell < cellCount; cell++) {
    templates[cell] = bin[cell * 2];
    icons[cell] = bin[cell * 2 + 1];
  }

  const units = ini.entries('UNITS').map(([, value]) => {
    const [house, type, strength, cell, facing, mission] = value.split(',');
    return { house, type, strength: Number(strength), cell: Number(cell), facing: Number(facing), mission };
  });
  const infantry = ini.entries('INFANTRY').map(([, value]) => {
    const [house, type, strength, cell, spot, mission, facing] = value.split(',');
    return {
      house, type, strength: Number(strength), cell: Number(cell), spot: Number(spot), mission, facing: Number(facing),
    };
  });
  const waypoints = new Map<number, number>();
  for (const [key, value] of ini.entries('Waypoints')) {
    const cell = Number(value);
    if (cell >= 0) waypoints.set(Number(key), cell);
  }

  return {
    theater: ini.get('MAP', 'Theater') ?? 'DESERT',
    mapWidth: ORIGINAL_MAP_SIZE,
    mapHeight: ORIGINAL_MAP_SIZE,
    x: ini.int('MAP', 'X', 1),
    y: ini.int('MAP', 'Y', 1),
    width: ini.int('MAP', 'Width', ORIGINAL_MAP_SIZE - 2),
    height: ini.int('MAP', 'Height', ORIGINAL_MAP_SIZE - 2),
    templates,
    icons,
    units,
    infantry,
    // Ported from BUILDING.CPP, TERRAIN.CPP, OVERLAY.CPP and SMUDGE.CPP, Read_INI.
    buildings: ini.entries('STRUCTURES').map(([, value]) => {
      const [house, type, strength, cell, facing] = value.split(',');
      return { house, type, strength: Number(strength), cell: Number(cell), facing: Number(facing) };
    }),
    terrain: ini.entries('TERRAIN').map(([cell, value]) => ({ cell: Number(cell), type: value.split(',')[0] })),
    overlays: ini.entries('OVERLAY').map(([cell, type]) => ({ cell: Number(cell), type })),
    smudges: ini.entries('SMUDGE').map(([, value]) => {
      const [type, cell, frame = '0'] = value.split(',');
      return { type, cell: Number(cell), frame: Number(frame) };
    }),
    waypoints,
  };
}
