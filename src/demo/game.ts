import type { Renderer } from '../engine/renderer.ts';
import { loadData } from '../game/data-files.ts';
import { startPreparedGame, type Game, type GameOptions } from '../game/game.ts';
import type { PreparedGame } from '../game/game-setup.ts';
import { simulationScene } from './simulation-scene.ts';
import { unitsScene } from './units-scene.ts';
import { combatScene } from './combat-scene.ts';
import { economyScene } from './economy-scene.ts';
import { DemoEconomyRuntime } from './economy-runtime.ts';
import type { DemoSpeed } from './production.ts';
import { skirmishScene } from '../game/skirmish-scene.ts';
import { MatchRuntime } from '../game/match-runtime.ts';
import { DEFAULT_MATCH_SEED, parseSeed } from './match-seed.ts';

export type DemoName = 'simulation' | 'units' | 'combat' | 'buildings' | 'economy' | 'match';
export interface DemoConfig { name: DemoName; faction: number; seed?: number }
export interface DemoGame extends Game {
  setWaves(enabled: boolean): void;
  setProductionSpeed(speed: DemoSpeed): void;
}

export function demoConfig(search: string): DemoConfig | undefined {
  const params = new URLSearchParams(search), name = params.get('demo');
  if (name !== 'simulation' && name !== 'units' && name !== 'combat' && name !== 'buildings' && name !== 'economy' && name !== 'match') return;
  return { name, faction: params.get('faction') === 'nod' ? 2 : 1,
    ...(name === 'match' ? { seed: parseSeed(params.get('seed') ?? '') ?? DEFAULT_MATCH_SEED } : {}) };
}

/** Demo-only forces, starting funds and controls; the core game receives prepared state. */
export async function startDemo(renderer: Renderer, canvas: HTMLCanvasElement, config: DemoConfig,
  options: GameOptions = {}): Promise<DemoGame> {
  const economic = config.name === 'buildings' || config.name === 'economy' || config.name === 'match';
  await options.onProgress?.('Loading game files');
  const data = await loadData(false, config.name !== 'simulation', economic);
  await options.onProgress?.('Building the battlefield');
  let world: PreparedGame;
  let economy: DemoEconomyRuntime | undefined;
  let createEconomy: GameOptions['createEconomy'];
  if (config.name === 'match') {
    const scene = skirmishScene(data, { seed: config.seed!, credits: 10000 });
    world = { kind: 'combat', ...scene, economy: scene };
    createEconomy = battle => new MatchRuntime(battle, scene);
    const url = new URL(location.href); url.searchParams.set('seed', String(config.seed));
    history.replaceState(null, '', url);
  } else if (economic) {
    const scene = economyScene(data, config.name === 'buildings');
    world = { kind: 'combat', ...scene, economy: scene, faction: config.faction };
    createEconomy = battle => economy = new DemoEconomyRuntime(battle, scene, config.faction, config.name === 'buildings');
  } else if (config.name === 'simulation') {
    let target: number | undefined;
    world = { kind: 'simulation', ...simulationScene(data),
      onMapClick(cell) { target = cell; },
      commands(frame) { const result = target === undefined ? [] : [{ frame, target }]; target = undefined; return result; },
    };
  } else {
    world = { kind: 'combat', ...(config.name === 'combat' ? combatScene(data) : unitsScene(data, true, true)) };
  }
  const game = await startPreparedGame(renderer, canvas, data, world, { ...options, createEconomy });
  if (config.name === 'match') game.setPerspective('all');
  return { ...game,
    setWaves(enabled) { if (economy) economy.waves = enabled; },
    setProductionSpeed(speed) { economy?.setProductionSpeed(speed); },
  };
}
