import type { MixSet } from '../game/formats/mix.ts';
import { readScenario, ORIGINAL_MAP_SIZE } from '../game/formats/scenario.ts';
import { buildScene } from '../game/scene.ts';
import { CLOAK_STAGES, type CloakStage } from '../game/cloak.ts';
import { INFANTRY_SPOTS, movementMap } from '../game/simulation/map.ts';
import type { SimulationSetup } from '../engine/simulation/state.ts';

export function simulationScene(mix: MixSet, count = 320) {
  const scenario = readScenario(new TextDecoder('latin1').decode(mix.require('SCG08EB.INI')), mix.require('SCG08EB.BIN'));
  scenario.units = []; scenario.infantry = [];
  const { grid, passable } = movementMap(mix, scenario);
  const home = scenario.waypoints.get(26) ?? scenario.y * ORIGINAL_MAP_SIZE + scenario.x;
  const hx = home % grid.width, hy = Math.floor(home / grid.width);
  const range = (cell: number) => (cell % grid.width - hx) ** 2 + (Math.floor(cell / grid.width) - hy) ** 2;
  const candidates = Array.from(passable.keys()).filter(cell => passable[cell] && (cell % grid.width + Math.floor(cell / grid.width)) % 2 === 0)
    .sort((a,b) => range(a) - range(b) || a - b);
  const selected = candidates.slice(0, count + 5);
  const cloak = new Map<number, CloakStage>();
  scenario.units = selected.map((cell, i) => {
    const stationary = i < 5;
    if (stationary) cloak.set(cell, CLOAK_STAGES[i]);
    return { cell, house: stationary ? 'BadGuy' : 'GoodGuy', type: stationary ? 'STNK' : 'MTNK',
      strength: 256, facing: 0, mission: 'Guard' };
  });
  const setup: SimulationSetup = { grid, seed: 0x1995, spots: INFANTRY_SPOTS,
    units: selected.map((cell,i) => ({ cell, speed: i < 5 ? 0 : 32 })) };
  const scene = buildScene(mix, scenario, cloak);
  return { scene, setup, passable };
}
