import type { MixSet } from '../formats/mix.ts';
import { readScenario } from '../formats/scenario.ts';
import { buildScene } from '../scene.ts';
import { movementType } from '../data/movement.ts';
import { combatTypes, bullets, animations, weapons, ANIMATION_IDS } from '../data/combat.ts';
import { movementMap } from './map.ts';
import type { UnitPlacement } from './units-state.ts';
import type { CombatSetup } from './combat-state.ts';
import { deathAnimation } from './combat-effects.ts';
export function combatScene(mix: MixSet) {
  const scenario = readScenario(new TextDecoder('latin1').decode(mix.require('SCG08EB.INI')), mix.require('SCG08EB.BIN'));
  scenario.units = [];
  scenario.infantry = [];
  scenario.buildings = [];
  const { grid, land, passable } = movementMap(mix, scenario), home = scenario.waypoints.get(26)!;
  const used = new Set<number>(), units: UnitPlacement[] = [], crewParents: number[] = [];
  const choose = (owner: number) => {
    const x = Math.min(scenario.x + scenario.width - 5, home % grid.width + owner * 14);
    const y = Math.floor(home / grid.width);
    const cells = Array.from(passable.keys()).filter(c => passable[c] && !used.has(c));
    cells.sort((a, b) => (a % grid.width - x) ** 2 + (Math.floor(a / grid.width) - y) ** 2 -
      (b % grid.width - x) ** 2 - (Math.floor(b / grid.width) - y) ** 2 || a - b);
    used.add(cells[0]);
    return cells[0];
  };
  for (let owner = 0; owner < 2; owner++)
    for (const name of owner ? ['LTNK', 'LTNK', 'FTNK', 'BGGY', 'BIKE', 'ARTY'] : ['MTNK', 'MTNK', 'HTNK', 'JEEP', 'APC', 'MSAM']) {
      const cell = choose(owner), facing = owner ? 192 : 64;
      scenario.units.push({ cell, type: name, house: owner ? 'BadGuy' : 'GoodGuy', strength: 256, facing, mission: 'Guard' });
      units.push({ cell, type: movementType(name), owner, facing });
      crewParents.push(-1);
    }
  for (let owner = 0; owner < 2; owner++)
    for (const name of owner ? ['E1', 'E3', 'E4', 'E5'] : ['E1', 'E2', 'E3', 'RMBO']) {
      const cell = choose(owner);
      for (let slot = 1; slot <= 2; slot++) {
        scenario.infantry.push({ cell, spot: slot, type: name, house: owner ? 'BadGuy' : 'GoodGuy', strength: 256, facing: owner ? 192 : 64, mission: 'Guard' });
        units.push({ cell, slot, type: movementType(name), owner, facing: owner ? 192 : 64 });
        crewParents.push(-1);
      }
    }
  const originals = units.length;
  for (let parent = 0; parent < originals; parent++) {
    const type = combatTypes[units[parent].type];
    if (!type.crew || type.transport)
      continue;
    const name = type.primary < 0 ? 'C1' : 'E1', owner = units[parent].owner!, cell = choose(owner);
    scenario.infantry.push({ cell, spot: 0, type: name, house: owner ? 'BadGuy' : 'GoodGuy', strength: 0, facing: 0, mission: 'Guard' });
    units.push({ cell, type: movementType(name), owner, health: 0 });
    crewParents.push(parent);
  }
  const animationIds = new Set<number>([ANIMATION_IDS.ANIM_SMOKE_M, ANIMATION_IDS.ANIM_SMOKE_PUFF, ANIMATION_IDS.ANIM_NAPALM1, ANIMATION_IDS.ANIM_CHEM_BALL]);
  const bulletIds = new Set<number>();
  for (const unit of units) {
    const type = combatTypes[unit.type];
    for (const ammo of [0,1]) {
      const death = deathAnimation(unit.type,ammo);
      if (death >= 0) animationIds.add(death);
    }
    if (type.explosion >= 0)
      animationIds.add(type.explosion);
    for (const w of [type.primary, type.secondary])
      if (w >= 0) {
        bulletIds.add(weapons[w].bullet);
        const a = weapons[w].animation;
        if (a >= 0) {
          for (let i = 0; i < (([ANIMATION_IDS.ANIM_GUN_N, ANIMATION_IDS.ANIM_FLAME_N, ANIMATION_IDS.ANIM_CHEM_N] as number[]).includes(a) ? 8 : 1); i++)
            animationIds.add(a + i);
        }
      }
  }
  for (const b of bulletIds)
    if (bullets[b].explosion >= 0)
      animationIds.add(bullets[b].explosion);
  const extra = new Set<string>([...bulletIds].filter(b => !bullets[b].invisible).map(b => bullets[b].name));
  extra.add('SQUISH');
  for (const a of animationIds)
    extra.add(animations[a].name);
  for (let i = 1; i <= 6; i++) {
    extra.add(`CR${i}`);
    extra.add(`SC${i}`);
  }
  const scene = buildScene(mix, scenario, 'normal', true, [...extra]);
  const decalStart = scene.objects[0]?.first ?? scene.sprites.length;
  const blank = { x: 0, y: 0, region: { x: 0, y: 0, width: 0, height: 0 }, remap: scene.plainRemap, shadow: false };
  scene.sprites.splice(decalStart, 0, ...Array.from({ length: grid.edges.length }, () => ({ ...blank })));
  for (const object of scene.objects)
    object.first += grid.edges.length;
  const setup: CombatSetup = { grid, land, passable, units, crewParents, seed: 0x1995 };
  return { scene, setup, passable, decalStart };
}
