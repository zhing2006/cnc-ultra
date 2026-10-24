import { packAtlas, type AtlasRegion, type IndexedImage } from '../engine/indexed/atlas.ts';
import { NO_TILE, type PaletteSetup, type Sprite, type TileMap } from '../engine/indexed/pipeline.ts';
import {
  BODY_SHAPE, CELL_LEPTONS, CELL_PIXELS, dirFacing, facingDir, facingTo32, HUMAN_SHAPE, leptonToPixel, pixelToLepton, turretAdjust, movePoint,
} from './coord.ts';
import { BUILDINGS } from './data/buildings.ts';
import { INFANTRY } from './data/infantry.ts';
import { buildingRemap, REMAP_NAMES, remapTable, unitRemap } from './data/houses.ts';
import { OVERLAYS } from './data/overlays.ts';
import { TERRAIN } from './data/terrain.ts';
import { MOUSE_NORMAL, MOUSE_NO_SCROLL, MOUSE_SCROLL, type MousePointer } from './data/mouse.ts';
import { clearIcon, TEMPLATE_CLEAR1, TEMPLATES } from './data/templates.ts';
import { UNITS } from './data/units.ts';
import { decodeIconSet, type IconSet } from './formats/icons.ts';
import type { MixSet } from './formats/mix.ts';
import { gamePalette, paletteToRgba } from './formats/palette.ts';
import { ORIGINAL_MAP_SIZE, readScenario, TEMPLATE_NONE, type Scenario } from './formats/scenario.ts';
import { decodeShapeLibrary } from './formats/shapes.ts';
import { decodeShp, type Shape } from './formats/shp.ts';
import { buildingFrame, buildingPosition, initialCellImages } from './map-visuals.ts';
import { cloakDisplacement, cloakedSprites, specialGhost, type CloakStage } from './cloak.ts';

/** A theater's name in scenario files, file name root and template extension (CONST.CPP, Theaters). */
const THEATERS = [
  { name: 'DESERT', root: 'DESERT', suffix: 'DES' },
  { name: 'JUNGLE', root: 'JUNGLE', suffix: 'JUN' },
  { name: 'TEMPERATE', root: 'TEMPERAT', suffix: 'TEM' },
  { name: 'WINTER', root: 'WINTER', suffix: 'WIN' },
];

/** The waypoint a scenario's opening view looks at (WAYPT_HOME in DEFINES.H). */
const WAYPOINT_HOME = 26;

/** Where each of the five spots of a cell lies, in leptons from its top-left (CONST.CPP, StoppingCoordAbs). */
const SPOTS: [number, number][] = [[0x80, 0x80], [0x40, 0x40], [0xc0, 0x40], [0x40, 0xc0], [0xc0, 0xc0]];

/** A mouse pointer ready to draw: its atlas region and hotspot. */
export interface CursorImage {
  region: AtlasRegion;
  hotX: number;
  hotY: number;
}

export interface GameScene {
  animation?: { frames: ReadonlyMap<string, AtlasRegion[]>; mouse: AtlasRegion[]; shroud: AtlasRegion[] };
  setup: Omit<PaletteSetup, 'spriteCapacity'>;
  /** Cell graphics followed by objects in the order the original draws them. */
  sprites: Sprite[];
  /** Object draw ranges, also used to inspect their ordering in rendering checks. */
  objects: { key: string; first: number; count: number; sortX: number; sortY: number }[];
  cursors: { normal: CursorImage; scroll: CursorImage[]; blocked: CursorImage[] };
  /** The remap row for images drawn without remapping, such as the mouse pointer. */
  plainRemap: number;
  scenario: Scenario;
  /** The cell the opening view starts at. */
  home: number;
}

/** Collects images for the sprite atlas, each image once. */
class SpriteImages {
  readonly images: IndexedImage[] = [];
  private readonly ids = new Map<string, number>();

  add(key: string, image: () => IndexedImage): number {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.images.length;
      this.images.push(image());
      this.ids.set(key, id);
    }
    return id;
  }
}

/** A sprite before the atlas is packed: the image it shows instead of a region. */
interface PendingSprite extends Omit<Sprite, 'region'> {
  image: number;
}

/** A drawable object with the position the original sorts it by (ObjectClass::Sort_Y). */
interface Drawn {
  key: string;
  sortX: number;
  sortY: number;
  sprites: PendingSprite[];
}

/** Builds an original scenario, or a supplied static scenario for the asset preview. */
export function buildScene(mix: MixSet, source: string | Scenario, cloak: CloakStage | ReadonlyMap<number, CloakStage> = 'normal', animated = false, extraShapes: readonly string[] = []): GameScene {
  const scenario = typeof source === 'string'
    ? readScenario(new TextDecoder('latin1').decode(mix.require(`${source}.INI`)), mix.require(`${source}.BIN`))
    : source;
  // DisplayClass::Read_INI looks the theater up by name (CONQUER.CPP, Theater_From_Name), with the desert
  // as the default.
  const theater = THEATERS.find((entry) => entry.name === scenario.theater.toUpperCase()) ?? THEATERS[0];

  const palette = paletteToRgba(gamePalette(mix.require(`${theater.root}.PAL`)));
  // DISPLAY.CPP defines _RETRIEVE, so Init_Theater reads the unit shadow table from a file named after
  // the theater (CONQUER.CPP, Fading_Table_Name). The first 256 bytes give, for each source index, the
  // translucent table it uses or 0xFF for none; the table follows.
  const shadowFile = mix.require(`${theater.root[0]}UNITS.MRF`);
  const shadowSources = shadowFile.slice(0, 256).map((table) => (table === 0xff ? 0 : 1));
  const shadowTable = shadowFile.slice(256, 512);
  const remaps = REMAP_NAMES.map(remapTable);

  const images = new SpriteImages();
  const ground = placeCellImages(mix, scenario, images, theater.suffix);
  // INI.CPP, Read_Scenario_Ini: terrain, units, infantry, then buildings enter the ground layer.
  const drawn = [...placeTerrain(mix, scenario, images, theater.suffix), ...placeUnits(mix, scenario, images, cloak),
    ...placeInfantry(mix, scenario, images), ...placeBuildings(mix, scenario, images, theater.suffix),
    ...placeAircraft(mix, scenario, images)];
  // Ported from LAYER.CPP, LayerClass::Sorted_Add: each object goes after every one that does not sort
  // after it, so equal positions keep the order the scenario lists them in. A COORDINATE compares y
  // before x.
  const ordered = drawn.map((object, order) => ({ object, order }))
    .sort((a, b) => a.object.sortY - b.object.sortY || a.object.sortX - b.object.sortX || a.order - b.order);

  const plainRemap = REMAP_NAMES.indexOf('none');
  const mouse = decodeShapeLibrary(mix.require('MOUSE.SHP'));
  const cursorImage = (pointer: MousePointer) => ({
    image: images.add(`MOUSE.SHP:${pointer.frame}`, () => mouse[pointer.frame]),
    hotX: pointer.hotX,
    hotY: pointer.hotY,
  });
  const normal = cursorImage(MOUSE_NORMAL);
  const scroll = MOUSE_SCROLL.map(cursorImage);
  const blocked = MOUSE_NO_SCROLL.map(cursorImage);

  const frameIds = new Map<string, number[]>(), mouseIds: number[] = [], shroudIds: number[] = [];
  if (animated) {
    const loader = shapeLoader(mix, images);
    for (const name of new Set([...scenario.units, ...scenario.infantry].map(u => u.type).concat('MOVEFLSH'))) {
      const shape = loader.read(`${name}.SHP`);
      frameIds.set(name, shape.frames.map((_, i) => loader(`${name}.SHP`, i).image));
    }
    for (const name of extraShapes) {
      const file = mix.get(`${name}.SHP`) ? `${name}.SHP` : `${name}.${theater.suffix}`;
      if (!mix.get(file)) continue;
      const shape = loader.read(file);
      frameIds.set(name, shape.frames.map((_, i) => loader(file, i).image));
    }
    for (let i = 0; i < mouse.length; i++) mouseIds.push(images.add(`MOUSE.SHP:${i}`, () => mouse[i]));
    const shroud = loader.read('SHADOW.SHP');
    for (let i = 0; i < shroud.frames.length; i++) shroudIds.push(loader('SHADOW.SHP', i).image);
  }

  const { atlas, regions } = packAtlas(images.images, 2048);
  const toCursor = ({ image, hotX, hotY }: { image: number; hotX: number; hotY: number }) => ({
    region: regions[image], hotX, hotY,
  });
  const convert = ({ image, ...sprite }: PendingSprite): Sprite => ({ ...sprite, region: regions[image] });
  const sprites = ground.map(convert);
  const objects = ordered.map(({ object }) => {
    const first = sprites.length;
    sprites.push(...object.sprites.map(convert));
    return { key: object.key, first, count: object.sprites.length, sortX: object.sortX, sortY: object.sortY };
  });

  return {
    animation: animated ? { frames: new Map([...frameIds].map(([name, ids]) => [name, ids.map(i => regions[i])])),
      mouse: mouseIds.map(i => regions[i]), shroud: shroudIds.map(i => regions[i]) } : undefined,
    setup: {
      palette, shadowSources, shadowTable, remaps, tiles: terrain(mix, scenario, theater.suffix), spriteAtlas: atlas,
      indexedBlend: extraShapes.length ? mix.require(`${theater.suffix[0]}TRANS.MRF`) : undefined,
      filters: [specialGhost(mix.require(`${theater.root}.PAL`))],
      singleUseFilter: animated ? mix.require(`${theater.suffix[0]}WHITE.MRF`).slice(256,512) : undefined,
      displacement: sprites.some(sprite => sprite.displace) ? cloakDisplacement(atlas) : undefined,
    },
    sprites,
    objects,
    cursors: { normal: toCursor(normal), scroll: scroll.map(toCursor), blocked: blocked.map(toCursor) },
    plainRemap,
    scenario,
    // Ported from DISPLAY.CPP, DisplayClass::Read_INI: without a home waypoint the view starts at the
    // top-left of the playable area.
    home: scenario.waypoints.get(WAYPOINT_HOME) ?? scenario.y * ORIGINAL_MAP_SIZE + scenario.x,
  };
}

/** The tile map of a scenario's terrain. */
function terrain(mix: MixSet, scenario: Scenario, suffix: string): TileMap {
  const sets = new Map<number, IconSet | null>();
  const iconSet = (template: number) => {
    if (!sets.has(template)) {
      const type = TEMPLATES[template];
      const file = type && mix.get(`${type.name}.${suffix}`);
      sets.set(template, file ? decodeIconSet(file) : null);
    }
    return sets.get(template)!;
  };

  const tiles: Uint8Array[] = [];
  const tileIds = new Map<string, number>();
  const cells = new Uint32Array(ORIGINAL_MAP_SIZE * ORIGINAL_MAP_SIZE).fill(NO_TILE);
  for (let y = scenario.y; y < scenario.y + scenario.height; y++) {
    for (let x = scenario.x; x < scenario.x + scenario.width; x++) {
      const cell = y * ORIGINAL_MAP_SIZE + x;
      let template = scenario.templates[cell];
      let icon = scenario.icons[cell];
      // Ported from MAP.CPP, MapClass::Read_Binary: an icon the template does not have turns the cell
      // into clear terrain.
      if (template !== TEMPLATE_CLEAR1 && template !== TEMPLATE_NONE) {
        const set = iconSet(template);
        if (set && (set.map[icon] ?? 0xff) === 0xff) {
          template = TEMPLATE_NONE;
          icon = 0;
        }
      }
      // Ported from CELL.CPP, CellClass::Draw_It: a cell without a template shows a CLEAR1 icon.
      if (template === TEMPLATE_NONE) {
        template = TEMPLATE_CLEAR1;
        icon = clearIcon(x, y);
      }
      const set = iconSet(template);
      const stored = set?.map[icon] ?? 0xff;
      // Buffer_Draw_Stamp draws nothing for an icon the set does not store.
      if (!set || stored === 0xff) continue;
      const key = `${template}:${stored}`;
      let id = tileIds.get(key);
      if (id === undefined) {
        id = tiles.length;
        tiles.push(set.icons[stored]);
        tileIds.set(key, id);
      }
      cells[cell] = id;
    }
  }

  const perRow = 64;
  const width = perRow * CELL_PIXELS;
  const rows = Math.max(1, Math.ceil(tiles.length / perRow));
  const pixels = new Uint8Array(width * rows * CELL_PIXELS);
  tiles.forEach((tile, id) => {
    const left = (id % perRow) * CELL_PIXELS;
    const top = Math.floor(id / perRow) * CELL_PIXELS;
    for (let row = 0; row < CELL_PIXELS; row++) {
      pixels.set(tile.subarray(row * CELL_PIXELS, (row + 1) * CELL_PIXELS), (top + row) * width + left);
    }
  });
  return {
    tileSize: CELL_PIXELS,
    atlas: { width, height: rows * CELL_PIXELS, pixels },
    cells,
    columns: ORIGINAL_MAP_SIZE,
    rows: ORIGINAL_MAP_SIZE,
  };
}

/** Loads and caches shape files for the sprite atlas. */
function shapeLoader(mix: MixSet, images: SpriteImages) {
  const shapes = new Map<string, Shape>();
  const read = (file: string) => {
    let shape = shapes.get(file);
    if (!shape) {
      shape = decodeShp(mix.require(file));
      shapes.set(file, shape);
    }
    return shape;
  };
  return Object.assign((file: string, frame: number) => {
    const shape = read(file);
    const { width, height, frames } = shape;
    if (frame >= frames.length) throw new Error(`${file} has no frame ${frame}`);
    return { image: images.add(`${file}:${frame}`, () => ({ width, height, pixels: frames[frame] })), width, height };
  }, { read });
}

/**
 * A sprite drawn the way CC_Draw_Shape draws with SHAPE_CENTER (CONQUER.CPP and KEYFBUFF.ASM): the
 * frame's centre, rounded down to a pixel, lies on (x, y).
 */
function centred(
  shape: { image: number; width: number; height: number }, x: number, y: number, remap: number,
): PendingSprite {
  return { image: shape.image, x: x - (shape.width >> 1), y: y - (shape.height >> 1), remap, shadow: true };
}

/**
 * The vehicles of a scenario, standing still. Ported from UNIT.CPP: UnitClass::Read_INI places a
 * unit at the centre of its cell, UnitClass::Unlimbo turns it to the nearest of the 8 facings, and
 * UnitClass::Draw_It picks the frames. Turrets face the way the body does (TurretClass sets the
 * secondary facing on unlimbo). TechnoClass::Techno_Draw_Object draws every frame with the house's
 * remap table and the unit shadow.
 */
function placeUnits(mix: MixSet, scenario: Scenario, images: SpriteImages, cloak: CloakStage | ReadonlyMap<number, CloakStage>): Drawn[] {
  const shape = shapeLoader(mix, images);
  const placed: Drawn[] = [];
  for (const unit of scenario.units) {
    const type = UNITS.get(unit.type.toUpperCase());
    if (!type) throw new Error(`unknown unit type ${unit.type}`);
    const file = `${type.name}.SHP`;
    const remap = REMAP_NAMES.indexOf(unitRemap(unit.house));
    const dir = facingDir(dirFacing(unit.facing));
    const facing = facingTo32(dir);
    const cellX = unit.cell % ORIGINAL_MAP_SIZE;
    const cellY = Math.floor(unit.cell / ORIGINAL_MAP_SIZE);
    const coordX = cellX * CELL_LEPTONS + 0x80;
    const coordY = cellY * CELL_LEPTONS + 0x80;
    const x = leptonToPixel(coordX);
    const y = leptonToPixel(coordY);

    let body = BODY_SHAPE[facing];
    if (type.animating) body = 0;
    if (type.eight) {
      const eight = dirFacing(dir);
      body = eight ? BODY_SHAPE[24 + eight] : 0;
    }
    const east = dirFacing(dir) >= 1 && dirFacing(dir) <= 3;
    if (type.chunky) body = type.name === 'BOAT' ? BODY_SHAPE[facing] + (east ? 96 : 0) : 0;
    const normal = centred(shape(file, body), x, y, remap);
    const stage = typeof cloak === 'string' ? cloak : cloak.get(unit.cell) ?? 'normal';
    const sprites = type.name === 'STNK' ? cloakedSprites(normal, stage) : [normal];
    // Ported from UNIT.CPP, UnitClass::Draw_It: the gunboat includes its turret in the body frame.
    if (type.name === 'BOAT') sprites.unshift({ ...centred(shape('WAKE.SHP', east ? 0 : 6),
      x + (east ? -1 : 3), y + 3, REMAP_NAMES.indexOf('none')), shadow: false });
    if (type.radar) sprites.push(centred(shape(file, 32), x, y - 5, remap));
    if (type.turret && !type.chunky) {
      let turretX = x;
      let turretY = y;
      // The rocket launchers' turret moves with the body facing.
      if (type.name === 'MLRS' || type.name === 'MSAM') {
        const [dx, dy] = turretAdjust(dir);
        turretX += dx;
        turretY += dy;
      }
      if (type.name === 'JEEP' || type.name === 'BGGY') turretY -= 4;
      sprites.push(centred(shape(file, BODY_SHAPE[facing] + 32), turretX, turretY, remap));
    }
    // UnitClass::Sort_Y sorts by a point half a cell below the unit.
    placed.push({ key: `unit:${unit.cell}:${type.name}`, sortX: coordX, sortY: coordY + 0x80, sprites });
  }
  return placed;
}

/** Ported from AIRCRAFT.CPP, AircraftClass::Draw_It. Preview aircraft are parked, with idle rotors. */
function placeAircraft(mix: MixSet, scenario: Scenario, images: SpriteImages): Drawn[] {
  const shape = shapeLoader(mix, images);
  return (scenario.aircraft ?? []).map((aircraft) => {
    const x = (aircraft.cell % ORIGINAL_MAP_SIZE) * CELL_PIXELS + 12;
    const y = Math.floor(aircraft.cell / ORIGINAL_MAP_SIZE) * CELL_PIXELS + 12;
    const remap = REMAP_NAMES.indexOf(unitRemap(aircraft.house));
    const frame = shape(`${aircraft.type}.SHP`, BODY_SHAPE[facingTo32(aircraft.facing)]);
    const sprites = [{ ...centred(frame, x + 1, y + 2, remap), shadow: false, filter: 0 },
      centred(frame, x, y, remap)];
    if (aircraft.type === 'HELI') sprites.push(centred(shape('RROTOR.SHP', 4), x, y - 2, REMAP_NAMES.indexOf('none')));
    if (aircraft.type === 'TRAN') {
      const stretch = [8, 9, 10, 9, 8, 9, 10, 9][dirFacing(aircraft.facing)];
      const [xx, yy] = movePoint(x, y, aircraft.facing, stretch);
      const [xx2, yy2] = movePoint(xx, yy, (aircraft.facing + 128) & 255, stretch * 2);
      sprites.push(centred(shape('RROTOR.SHP', 4), xx, yy - 2, REMAP_NAMES.indexOf('none')),
        centred(shape('LROTOR.SHP', 4), xx2, yy2 - 2, REMAP_NAMES.indexOf('none')));
    }
    return { key: `aircraft:${aircraft.cell}:${aircraft.type}`, sortX: x * 256, sortY: y * 256, sprites };
  });
}

/**
 * The infantry of a scenario, standing still. Ported from INFANTRY.CPP: InfantryClass::Read_INI puts
 * an infantry on one of the five spots of its cell, and InfantryClass::Draw_It shifts it 2 pixels left
 * and 4 down and picks the DO_STAND_READY frame for its facing.
 */
function placeInfantry(mix: MixSet, scenario: Scenario, images: SpriteImages): Drawn[] {
  const shape = shapeLoader(mix, images);
  return scenario.infantry.map((infantry) => {
    const type = INFANTRY.get(infantry.type.toUpperCase());
    if (!type) throw new Error(`unknown infantry type ${infantry.type}`);
    const [spotX, spotY] = SPOTS[infantry.spot] ?? SPOTS[0];
    const coordX = (infantry.cell % ORIGINAL_MAP_SIZE) * CELL_LEPTONS + spotX;
    const coordY = Math.floor(infantry.cell / ORIGINAL_MAP_SIZE) * CELL_LEPTONS + spotY;
    const { frame, jump } = type.standReady;
    const shown = shape(`${type.name}.SHP`, frame + HUMAN_SHAPE[facingTo32(infantry.facing)] * jump);
    const remap = REMAP_NAMES.indexOf(unitRemap(infantry.house));
    const sprite = centred(shown, leptonToPixel(coordX) - 2, leptonToPixel(coordY) + 4, remap);
    // FootClass::Sort_Y sorts by a point 0x30 leptons below the infantry.
    return { key: `infantry:${infantry.cell}:${type.name}`, sortX: coordX, sortY: coordY + 0x30, sprites: [sprite] };
  });
}

/** Ported from CELL.CPP, CellClass::Draw_It, and SDATA.CPP, SmudgeTypeClass::Draw_It. */
function placeCellImages(mix: MixSet, scenario: Scenario, images: SpriteImages, suffix: string): PendingSprite[] {
  const { smudges, overlays } = initialCellImages(scenario);
  const shape = shapeLoader(mix, images);
  const remap = REMAP_NAMES.indexOf('none');
  const result: PendingSprite[] = [];
  for (const item of smudges) {
    const shown = shape(`${item.type}.${suffix}`, item.frame);
    result.push({ image: shown.image, x: (item.cell % ORIGINAL_MAP_SIZE) * CELL_PIXELS,
      y: Math.floor(item.cell / ORIGINAL_MAP_SIZE) * CELL_PIXELS, remap, shadow: false });
  }
  for (const item of overlays) {
    const type = OVERLAYS.get(item.type)!;
    const shown = shape(`${item.type}.${type.theater ? suffix : 'SHP'}`, item.frame);
    result.push(centred(shown, (item.cell % ORIGINAL_MAP_SIZE) * CELL_PIXELS + 12,
      Math.floor(item.cell / ORIGINAL_MAP_SIZE) * CELL_PIXELS + 12, remap));
  }
  return result;
}

/** Ported from TERRAIN.CPP, Draw_It; TERRAIN.H, Sort_Y/Render_Coord; and TYPE.H, Coord_Fixup. */
function placeTerrain(mix: MixSet, scenario: Scenario, images: SpriteImages, suffix: string): Drawn[] {
  const shape = shapeLoader(mix, images);
  return scenario.terrain.map((object) => {
    const type = TERRAIN.get(object.type.toUpperCase());
    if (!type) throw new Error(`unknown terrain type ${object.type}`);
    const x = object.cell % ORIGINAL_MAP_SIZE, y = Math.floor(object.cell / ORIGINAL_MAP_SIZE);
    const shown = shape(`${type.name}.${suffix}`, 0);
    return {
      key: `terrain:${object.cell}:${type.name}`,
      sortX: x * CELL_LEPTONS + pixelToLepton(type.baseX), sortY: y * CELL_LEPTONS + pixelToLepton(type.baseY),
      sprites: [{ image: shown.image, x: x * CELL_PIXELS, y: y * CELL_PIXELS,
        remap: REMAP_NAMES.indexOf('none'), shadow: true }],
    };
  });
}

/** Ported from BUILDING.CPP, Draw_It/Center_Coord/Sort_Y/Remap_Table. */
function placeBuildings(mix: MixSet, scenario: Scenario, images: SpriteImages, suffix: string): Drawn[] {
  const shape = shapeLoader(mix, images);
  const result: Drawn[] = [];
  for (const building of scenario.buildings) {
    const type = BUILDINGS.get(building.type.toUpperCase())!;
    if (OVERLAYS.get(type.name)?.wall) continue;
    const file = `${type.name}.${type.theater ? suffix : 'SHP'}`;
    const frame = buildingFrame(building, type, shape.read(file).frames.length);
    const position = buildingPosition(building, type);
    const x = leptonToPixel(position.centerX), y = leptonToPixel(position.centerY);
    const remap = REMAP_NAMES.indexOf(buildingRemap(building.house));
    const sprites = [centred(shape(file, frame), x, y, remap)];
    // BuildingClass::Read_INI uses COORDA.ASM, Fixed_To_Cardinal, before Draw_It tests hitpoints.
    const hp = (type.strength * Math.min(building.strength, 256) + 0x80) >> 8;
    if (type.name === 'WEAP' && hp > 1) {
      sprites.push(centred(shape('WEAP2.SHP', frame ? 10 : 0), x, y, remap));
    }
    result.push({ key: `building:${building.cell}:${type.name}`, sortX: position.sortX, sortY: position.sortY, sprites });
  }
  return result;
}
