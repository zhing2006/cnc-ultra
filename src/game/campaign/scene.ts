import { gridEdges } from '../../engine/simulation/state.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { PRODUCTION_TYPES } from '../data/production.ts';
import { animations, bullets } from '../data/combat.ts';
import { initialCellImages } from '../map-visuals.ts';
import { buildScene } from '../scene.ts';
import { movementMap } from '../simulation/map.ts';
import { initialUnits, UX, UY, WORDS, type UnitPlacement } from '../simulation/units-state.ts';
import { GUARD, GUARD_AREA, HUNT, SLEEP, STICKY, AMBUSH, HARVEST, type CombatSetup } from '../simulation/combat-state.ts';
import type { EconomySetup, InitialBuilding } from '../simulation/economy-setup.ts';
import type { TiberiumSetup } from '../simulation/tiberium-cpu.ts';
import type { MixSet } from '../formats/mix.ts';
import type { CampaignScenario } from './scenario.ts';
import type { NavalMap } from './naval.ts';
import { REMAP_NAMES, unitRemap, buildingRemap } from '../data/houses.ts';

/** Scenario objects keep their INI order and strength fractions; no skirmish opening is substituted. */
export function campaignScene(mix: MixSet, mission: CampaignScenario, seed = 0x1995, capacity = 512) {
  const scenario = mission.scenario, width = 64, cells = width * width;
  const bare = { ...scenario, units: [], infantry: [], buildings: [], aircraft: [] };
  const map = movementMap(mix, bare), images = initialCellImages(scenario);
  const fullMap = movementMap(mix, { ...bare, x: 0, y: 0, width, height: width });
  const baseLand = movementMap(mix, { ...bare, x: 0, y: 0, width, height: width, overlays: bare.overlays.filter(o => !/^TI\d+$/.test(o.type)) }).land;
  const basePassable = map.passable.slice(), playable = new Int32Array(cells), buildable = new Int32Array(cells);
  for (let y = scenario.y; y < scenario.y + scenario.height; y++) for (let x = scenario.x; x < scenario.x + scenario.width; x++) {
    const cell = y * width + x; playable[cell] = 1; buildable[cell] = Number(!!basePassable[cell] && [0, 1, 5].includes(baseLand[cell]));
  }
  const tiberium: TiberiumSetup = { width, height: width, seed, amount: new Int32Array(cells).fill(-1), variants: new Int32Array(cells),
    clear: Int32Array.from(buildable, (value, cell) => Number(!!value && [0, 5].includes(baseLand[cell]))), blossom: new Int32Array(cells), playable };
  for (const overlay of images.overlays) if (/^TI\d+$/.test(overlay.type)) {
    tiberium.amount[overlay.cell] = overlay.frame; tiberium.variants[overlay.cell] = Number(overlay.type.slice(2)) - 1;
  }
  for (const tree of scenario.terrain) if (tree.type === 'SPLIT2' || tree.type === 'SPLIT3') tiberium.blossom[tree.cell + width] = 1;
  const houseNames = [mission.player, mission.player === 'GoodGuy' ? 'BadGuy' : 'GoodGuy', 'Neutral', 'Special'];
  const owner = (house: string) => houseNames.indexOf(house);
  const units: UnitPlacement[] = [], buildings: InitialBuilding[] = [], missions: number[] = [];
  const extra = new Set<string>();
  for (const placed of [...scenario.units, ...scenario.infantry, ...scenario.buildings]) {
    const type = movementType(placed.type);
    if (type < 0) throw new Error(`Unsupported campaign unit: ${placed.type}`);
    const id = units.length, faction = placed.house === 'GoodGuy' ? 1 : placed.house === 'BadGuy' ? 2 : 0;
    extra.add(placed.type);
    units.push({ type, cell: placed.cell, owner: owner(placed.house), facing: placed.facing, slot: 'spot' in placed && typeof placed.spot === 'number' ? placed.spot : 0,
      // UNIT/INFANTRY/BUILDING.CPP Read_INI use Fixed_To_Cardinal's +0x80 rounding.
      health: Math.max(placed.strength > 0 ? 1 : 0, Math.trunc((MOVEMENT[type].strength * (MOVEMENT[type].domain===2?Math.min(256,placed.strength):placed.strength)+128) / 256)) });
    const order = 'mission' in placed && typeof placed.mission === 'string' ? placed.mission.toLowerCase() : 'guard';
    missions.push(({hunt:HUNT,'area guard':GUARD_AREA,sleep:SLEEP,sticky:STICKY,ambush:AMBUSH,harvest:HARVEST} as Record<string,number>)[order]??GUARD);
    if (MOVEMENT[type].domain === 2) buildings.push({ id, type: placed.type, cell: placed.cell, owner: owner(placed.house), faction });
  }
  while (units.length < capacity) units.push({ type: movementType('MTNK'), cell: 0, health: 0 });
  if (mission.buildLevel >= 5 || mission.triggers.some(trigger => trigger.action === 'Airstrike') || mission.teams.some(team => team.members.some(member => MOVEMENT[movementType(member.type)]?.domain === 1)))
    units[capacity - 1] = { type: movementType('C17'), cell: 0, health: 0 };
  const passable = movementMap(mix, { ...scenario, units: [], infantry: [] }).passable;
  const setup: CombatSetup = { grid: gridEdges(width, width, passable, true), bounds: { x: scenario.x, y: scenario.y, width: scenario.width, height: scenario.height },
    passable, land: fullMap.land, units, seed, dynamicTypes: true, multiplayer: false, missions, houseCount: houseNames.length,
    campaignLevel: mission.buildLevel, campaignRouting: mission.teams.some(team=>team.roundabout), goodOwner: owner('GoodGuy'),
    houseEdges: houseNames.map(name=>({north:0,east:64,south:128,west:192}[mission.houses.find(h=>h.name===name)!.edge.toLowerCase()]??0)),
    allies: houseNames.map(name => mission.houses.find(h => h.name === name)!.allies.reduce((mask, ally) => mask | (owner(ally) < 0 ? 0 : 1 << owner(ally)), 1 << owner(name))) };
  for (const team of mission.teams) for (const member of team.members) extra.add(member.type);
  if(mission.player==='BadGuy'&&mission.buildLevel===10)extra.add('CHAN');
  if (mission.triggers.some(trigger => trigger.action === 'Airstrike')) extra.add('A10');
  for (const type of PRODUCTION_TYPES) if (type.level <= mission.buildLevel) { extra.add(type.name); if (type.category === 'building') extra.add(`${type.name}MAKE`); }
  for (const name of ['MTNK', 'C17', 'E1', 'E6', 'FACT', 'FACTMAKE', 'HARV', 'WAKE', 'WEAP2', 'RROTOR', 'LROTOR', 'BIB1', 'BIB2', 'BIB3', 'SQUISH', 'SELECT', ...bullets.filter(b => !b.invisible).map(b => b.name), ...animations.map(a => a.name)]) extra.add(name);
  for (const name of ['C1', 'C7']) extra.add(name);
  if (scenario.buildings.some(building => building.house === 'Neutral')) for (let civilian = 1; civilian <= 9; civilian++) extra.add(`C${civilian}`);
  for (let i = 1; i <= 12; i++) extra.add(`TI${i}`);
  for (let i = 1; i <= 6; i++) { extra.add(`CR${i}`); extra.add(`SC${i}`); }
  const scenery={ ...bare, overlays: bare.overlays.filter(o => !/^TI\d+$/.test(o.type)) };
  const groundImages=initialCellImages(scenery);
  const crates=new Map(groundImages.overlays.flatMap((overlay,index)=>/^[WS]CRATE$/.test(overlay.type)?[[overlay.cell,{sprite:groundImages.smudges.length+index,steel:overlay.type==='SCRATE'}] as const]:[]));
  const scene = buildScene(mix, scenery, 'normal', true, [...extra]);
  scene.scenario = scenario;
  const first = scene.objects[0]?.first ?? scene.sprites.length;
  const blank = { x: 0, y: 0, region: { x: 0, y: 0, width: 0, height: 0 }, remap: scene.plainRemap, shadow: false };
  scene.sprites.splice(first, 0, ...Array.from({ length: cells * 3 }, () => ({ ...blank })));
  for (const object of scene.objects) object.first += cells * 3;
  const state = initialUnits(setup), region = scene.animation!.frames.get('MTNK')![0];
  // UNIT.CPP Draw_It: a hovercraft draws up to five infantry after its hull.
  const parts = extra.has('LST') ? 6 : 4;
  for (let id = 0; id < capacity; id++) {
    const first = scene.sprites.length, type = MOVEMENT[units[id].type], building = BUILDINGS.get(type.name);
    for (let part = 0; part < parts; part++) scene.sprites.push(part < 4 ? { ...blank, region, remap: 0, shadow: true } : { ...blank });
    const offset = building ? type.name === 'FIX' ? -384 : type.name === 'PYLE' || type.name === 'PROC' ? 0 : Math.trunc(building.height * 256 / 3) : type.infantry ? 48 : 128;
    scene.objects.push({ key: `live:${id}`, first, count: parts, sortX: state[id * WORDS + UX] + (type.name === 'FIX' ? -384 : 0), sortY: state[id * WORDS + UY] + offset });
  }
  const ordered = scene.objects.map((object, index) => ({ object, index, sprites: scene.sprites.slice(object.first, object.first + object.count) }))
    .sort((a, b) => a.object.sortY - b.object.sortY || a.object.sortX - b.object.sortX || a.index - b.index);
  scene.sprites.length = first + cells * 3; scene.objects.length = 0;
  for (const item of ordered) { item.object.first = scene.sprites.length; scene.sprites.push(...item.sprites); scene.objects.push(item.object); }
  const credits = mission.houses.find(h => h.name === mission.player)!.credits;
  const navalMap: NavalMap = { width, land: fullMap.land, clear: fullMap.passable, bounds: setup.bounds!, desert: scenario.theater.toUpperCase() === 'DESERT' };
  return { scene, setup, passable, basePassable, baseLand, buildable, playable, tiberium, buildings, credits, navalMap,
    remaps: houseNames.map(name => ({ unit: REMAP_NAMES.indexOf(unitRemap(name)), building: REMAP_NAMES.indexOf(buildingRemap(name)) })),
    houseNames, crates, houses: houseNames.map(name => ({ faction: name === 'GoodGuy' ? 1 : name === 'BadGuy' ? 2 : 0, credits: mission.houses.find(h => h.name === name)!.credits })),
    oreStart: first, bibStart: first + cells, decalStart: first + cells * 2 } satisfies EconomySetup & { navalMap: NavalMap; houseNames: string[]; crates: typeof crates };
}
