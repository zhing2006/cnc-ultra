import { gridEdges } from '../engine/simulation/state.ts';
import { BUILDINGS } from './data/buildings.ts';
import { MOVEMENT, movementType } from './data/movement.ts';
import { animations, bullets, combatTypes } from './data/combat.ts';
import { PRODUCTION_TYPES } from './data/production.ts';
import type { MixSet } from './formats/mix.ts';
import type { Scenario } from './formats/scenario.ts';
import { buildScene } from './scene.ts';
import { initialCellImages } from './map-visuals.ts';
import { generateMap, type GeneratedMap, type GeneratorOptions } from './map-generator/generator.ts';
import { inside, type MapRectangle } from './map-generator/layout.ts';
import type { MapSamples } from './map-generator/samples.ts';
import { movementMap } from './simulation/map.ts';
import { placementOffsets } from './simulation/building-rules.ts';
import { initialUnits, WORDS, type UnitPlacement } from './simulation/units-state.ts';
import { GUARD, HUNT, MOVE, ATTACK, type CombatSetup } from './simulation/combat-state.ts';
import type { EconomySetup, InitialBuilding } from './simulation/economy-setup.ts';
import type { TiberiumSetup } from './simulation/tiberium-cpu.ts';
import type { NavalMap } from './campaign/naval.ts';

// The preset is scenario composition. Movement, weapons and all other unit values stay original.
const ARMIES: readonly (readonly [string, number][])[] = [
  [['JEEP', 8], ['APC', 6], ['MTNK', 22], ['HTNK', 10], ['MSAM', 6], ['E1', 24], ['E2', 12], ['E3', 10], ['E6', 1], ['RMBO', 1]],
  [['BIKE', 12], ['BGGY', 8], ['LTNK', 16], ['FTNK', 6], ['STNK', 6], ['ARTY', 6], ['MLRS', 6], ['E1', 18], ['E3', 10], ['E4', 5], ['E5', 5], ['E6', 1], ['RMBO', 1]],
];

/** Keep original naval edge cells outside the playable rectangle, including a southern landing row. */
function borderedScenario(source: Scenario): Scenario {
  const width = source.width + 2, height = source.height + 2;
  const templates = new Uint8Array(width * height), icons = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const old = Math.max(0, Math.min(source.height - 1, y - 1)) * source.width + Math.max(0, Math.min(source.width - 1, x - 1));
    templates[y * width + x] = source.templates[old]; icons[y * width + x] = source.icons[old];
  }
  const cell = (old: number) => (Math.trunc(old / source.width) + 1) * width + old % source.width + 1;
  const shift = <T extends { cell: number }>(items: T[]) => items.map(item => ({ ...item, cell: cell(item.cell) }));
  return { ...source, mapWidth: width, mapHeight: height, x: 1, y: 1, templates, icons,
    terrain: shift(source.terrain), overlays: shift(source.overlays), smudges: shift(source.smudges),
    units: [], infantry: [], buildings: [], aircraft: [], waypoints: new Map() };
}

export interface UltraOptions extends GeneratorOptions { armySize?: number }

/** Both armies deploy once; after the opening Hunt mission only standard unit AI and player orders act. */
export function ultraScene(mix: MixSet, samples: MapSamples, options: UltraOptions) {
  const generated = generateMap(samples, options), scenario = borderedScenario(generated.scenario);
  const width = scenario.mapWidth!, height = scenario.mapHeight!, cells = width * height;
  const armySize = options.armySize ?? 10000;
  const shift = (rect: MapRectangle) => ({ ...rect, x: rect.x + 1, y: rect.y + 1 });
  const deployments = generated.deployments.map(shift), support = generated.support.map(shift);
  const excluded = [...support, ...generated.mineralFields.flat().map(shift)];
  const full = movementMap(mix, { ...scenario, x: 0, y: 0, width, height });
  const map = movementMap(mix, scenario), basePassable = map.passable.slice();
  const baseLand = movementMap(mix, { ...scenario, x: 0, y: 0, width, height, overlays: scenario.overlays.filter(o => !/^TI\d+$/.test(o.type)) }).land;
  const playable = new Int32Array(cells), buildable = new Int32Array(cells);
  for (let y = 1; y <= scenario.height; y++) for (let x = 1; x <= scenario.width; x++) {
    const cell = y * width + x; playable[cell] = 1; buildable[cell] = Number(!!basePassable[cell] && [0, 1, 5].includes(baseLand[cell]));
  }
  const tiberium: TiberiumSetup = { width, height, seed: options.seed, amount: new Int32Array(cells).fill(-1),
    variants: new Int32Array(cells), clear: Int32Array.from(buildable, (value, cell) => Number(!!value && [0, 5].includes(baseLand[cell]))), blossom: new Int32Array(cells), playable };
  for (const overlay of initialCellImages(scenario).overlays) if (/^TI\d+$/.test(overlay.type)) {
    tiberium.amount[overlay.cell] = overlay.frame; tiberium.variants[overlay.cell] = Number(overlay.type.slice(2)) - 1;
  }
  const units: UnitPlacement[] = [], buildings: InitialBuilding[] = [], missions: number[] = [], crewParents: number[] = [];
  const used = new Uint8Array(cells), navalIds: number[] = [];
  const add = (name: string, cell: number, owner: number, mission = HUNT, attached = 0) => {
    const id = units.length;
    units.push({ cell, type: movementType(name), owner, facing: owner ? 192 : 64, attached });
    missions.push(mission); crewParents.push(-1); return id;
  };
  for (let owner = 0; owner < 2; owner++) {
    const area = support[owner];
    const facility = (name: string) => {
      const offsets = placementOffsets(name);
      for (let y = area.y; y < area.y + area.height; y++) for (let x = area.x; x < area.x + area.width; x++) {
        if (!offsets.every(([dx, dy]) => inside(x + dx, y + dy, area) && buildable[(y + dy) * width + x + dx] && !used[(y + dy) * width + x + dx])) continue;
        const cell = y * width + x, id = add(name, cell, owner, GUARD);
        buildings.push({ id, type: name, cell, owner, faction: owner + 1 });
        for (const [dx, dy] of offsets) for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) used[(y + dy + yy) * width + x + dx + xx] = 1;
        return;
      }
      throw new Error(`No deployment space for ${name}`);
    };
    facility('NUK2'); facility('NUK2'); facility('HQ'); facility('FIX');
    for (let i = 0; i < 12; i++) facility('HPAD');
    const start = units.length, army = deployments[owner];
    const airCount = Math.min(12, Math.max(2, Math.trunc(armySize / 100)));
    for (let i = 0; i < airCount + 2; i++) {
      const x = owner ? army.x + army.width : army.x - 1;
      add(i < airCount ? owner ? 'HELI' : 'ORCA' : 'TRAN', (army.y + 2 + i) * width + x, owner);
    }
    // UNIT.CPP Per_Cell_Process turns each boat at the east/west edge of its row.
    for (let i = 0; i < 2; i++) navalIds.push(add('BOAT', (generated.navalSupport.patrol.y + 1 + i) * width + Math.trunc(width / 2) + (owner ? 8 : -8), owner, GUARD));
    const landing = add('LST', (height - 1) * width + army.x + Math.trunc(army.width / 2), owner, GUARD);
    navalIds.push(landing);
    for (let i = 0; i < 5; i++) add('E1', units[landing].cell, owner, HUNT, landing + 1);
    const remaining = armySize - (units.length - start), names: string[] = [];
    for (let i = 0, cumulative = 0; i < ARMIES[owner].length; i++) {
      const [name, weight] = ARMIES[owner][i]; cumulative += weight;
      while (names.length < Math.trunc(remaining * cumulative / 100)) names.push(name);
    }
    names.sort((a, b) => MOVEMENT[movementType(b)].speed - MOVEMENT[movementType(a)].speed);
    const slots: number[] = [];
    for (let column = 0; column < army.width; column++) {
      const x = owner ? army.x + column : army.x + army.width - 1 - column;
      for (let y = army.y; y < army.y + army.height; y++) if (basePassable[y * width + x] && !used[y * width + x] && !excluded.some(rect => inside(x, y, rect))) slots.push(y * width + x);
    }
    if (slots.length < names.length) throw new Error('The army does not fit its deployment region');
    for (let i = 0; i < names.length; i++) add(names[i], slots[i], owner);
  }
  const initialCount = units.length;
  // TECHNO.CPP Crew_Type / combat's crew allocation retain a private survivor slot for each vehicle.
  for (let parent = 0; parent < initialCount; parent++) {
    const unit = units[parent], type = combatTypes[unit.type];
    if (!type.crew || type.transport || MOVEMENT[unit.type].domain === 2) continue;
    units.push({ cell: unit.cell, type: movementType(type.primary < 0 ? 'C1' : 'E1'), owner: unit.owner, health: 0 });
    crewParents.push(parent); missions.push(GUARD);
  }
  const reserveStart = units.length;
  for (let i = 0; i < 256; i++) { units.push({ cell: 0, type: movementType('E1'), health: 0 }); crewParents.push(-1); missions.push(GUARD); }
  const passable = basePassable.slice();
  for (const b of buildings) for (const [dx, dy] of BUILDINGS.get(b.type)!.occupy) passable[b.cell + dy * width + dx] = 0;
  const bounds = { x: scenario.x, y: scenario.y, width: scenario.width, height: scenario.height };
  const setup: CombatSetup = { grid: gridEdges(width, height, passable, true), bounds, land: full.land, passable, units, seed: options.seed,
    multiplayer: true, ultraHunt: true, missions, crewParents };
  const extra = new Set<string>([...units.map(unit => MOVEMENT[unit.type].name), ...bullets.filter(b => !b.invisible).map(b => b.name), ...animations.map(a => a.name),
    ...PRODUCTION_TYPES.filter(t => t.category === 'building').map(t => `${t.name}MAKE`), 'WEAP2', 'WAKE', 'RROTOR', 'LROTOR', 'BIB1', 'BIB2', 'BIB3', 'SQUISH', 'SELECT']);
  for (let i = 1; i <= 12; i++) extra.add(`TI${i}`);
  for (let i = 1; i <= 6; i++) { extra.add(`CR${i}`); extra.add(`SC${i}`); }
  const scene = buildScene(mix, { ...scenario, overlays: scenario.overlays.filter(o => !/^TI\d+$/.test(o.type)) }, 'normal', true, [...extra]);
  const first = scene.objects[0]?.first ?? scene.sprites.length;
  const blank = { x: 0, y: 0, region: { x: 0, y: 0, width: 0, height: 0 }, remap: scene.plainRemap, shadow: false };
  scene.sprites = [...scene.sprites.slice(0, first), ...Array.from({ length: cells * 3 }, () => ({ ...blank })), ...scene.sprites.slice(first)];
  for (const object of scene.objects) object.first += cells * 3;
  const state = initialUnits(setup), region = scene.animation!.frames.get('MTNK')![0];
  for (let id = 0; id < units.length; id++) {
    const first = scene.sprites.length, type = MOVEMENT[units[id].type], b = BUILDINGS.get(type.name);
    for (let part = 0; part < 6; part++) scene.sprites.push(part < 4 ? { ...blank, region, remap: units[id].owner ?? 0, shadow: true } : { ...blank });
    const offset = b ? type.name === 'FIX' ? -384 : Math.trunc(b.height * 256 / 3) : type.infantry ? 48 : 128;
    scene.objects.push({ key: `live:${id}`, first, count: 6, sortX: state[id * WORDS] + (type.name === 'FIX' ? -384 : 0), sortY: state[id * WORDS + 1] + offset });
  }
  const objects = scene.objects.map((object, index) => ({ object, index, sprites: scene.sprites.slice(object.first, object.first + object.count) }))
    .sort((a, b) => a.object.sortY - b.object.sortY || a.object.sortX - b.object.sortX || a.index - b.index);
  scene.sprites.length = first + cells * 3; scene.objects.length = 0;
  for (const item of objects) { item.object.first = scene.sprites.length; scene.sprites.push(...item.sprites); scene.objects.push(item.object); }
  scene.home = (generated.battlefield.y + 1) * width + Math.trunc(width / 2);
  const navalMap: NavalMap = { width, land: full.land, clear: full.passable, bounds, desert: false };
  // Aircraft receive ordinary opening orders. A fixed target survives the flight
  // from the rear, unlike the leading vehicles that meet and die before arrival.
  const openingOrders = units.flatMap((unit, id) => {
    if (MOVEMENT[unit.type].domain !== 1 || unit.health === 0) return [];
    if (MOVEMENT[unit.type].name === 'TRAN') return [{ id, mission: MOVE, target: -1,
      cell: Math.trunc(unit.cell / width) * width + (unit.owner ? deployments[0].x + deployments[0].width - 1 : deployments[1].x) }];
    return [{ id, mission: ATTACK, target: buildings.find(b => b.owner !== unit.owner && b.type === 'HQ')!.id, cell: -1 }];
  });
  return { scene, setup, generated, armySize, reserveStart, navalIds, navalMap, openingOrders, passable, basePassable, baseLand, buildable, playable, tiberium, buildings,
    credits: 10000, houses: [{ faction: 1, credits: 10000 }, { faction: 2, credits: 10000 }], remaps: [{ unit: 0, building: 0 }, { unit: 1, building: 1 }],
    oreStart: first, bibStart: first + cells, decalStart: first + cells * 2 } satisfies EconomySetup & {
      generated: GeneratedMap; armySize: number; reserveStart: number; navalIds: number[]; navalMap: NavalMap; openingOrders: { id: number; mission: number; target: number; cell: number }[];
    };
}
