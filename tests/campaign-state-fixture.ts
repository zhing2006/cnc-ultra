import { createRenderer } from '../src/engine/renderer.ts';
import { loadData } from '../src/game/data-files.ts';
import { skirmishScene } from '../src/game/skirmish-scene.ts';
import { startPreparedGame, type Game, type GameState } from '../src/game/game.ts';
import { EconomyRuntime } from '../src/game/simulation/economy-runtime.ts';
import { encodeSave, decodeSave } from '../src/game/campaign/save-file.ts';
import { DEFAULT_PREFERENCES } from '../src/game/options.ts';

export async function checkSavedSimulation() {
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:640px;height:400px'; document.body.append(canvas);
  const renderer = await createRenderer(canvas, { onDeviceLost: message => { throw new Error(message); } });
  if (!renderer) throw new Error('WebGPU is required');
  const data = await loadData(false, true, true);
  let game: Game | undefined, runtime: EconomyRuntime | undefined, target = 0, reached: (() => void) | undefined;
  const start = async () => {
    const world = skirmishScene(data, { seed: 1995, starts: [0], credits: 10000, capacity: 32 });
    game = await startPreparedGame(renderer, canvas, data, { kind: 'combat', scene: world.scene, setup: world.setup, economy: world, decalStart: world.decalStart }, {
      createEconomy: (battle, setup) => runtime = new EconomyRuntime(battle, setup),
      onStats: frame => { if (frame === target) { game!.setPaused(true); reached?.(); } },
    });
    game.setPaused(true); game.setSimulationSpeed(100);
    return world.mcv;
  };
  const advance = async (frame: number) => {
    target = frame;
    const done = new Promise<void>(resolve => { reached = resolve; });
    game!.setPaused(false); await done;
    await runtime!.saveState();
  };
  try {
    const mcv = await start(); runtime!.deploy(mcv);
    game!.setSimulationSpeed(1);game!.setPreferences({...DEFAULT_PREFERENCES,gameSpeed:6});
    game!.applyDebugState(await game!.readDebugState());
    if((await game!.saveState()).debug)throw new Error('Viewing Debug locked the original game-speed slider');
    game!.setSimulationSpeed(100);
    game!.applyDebugState({ money: 12345, buildSpeed: 10, gameSpeed: 100, damageScale: 500 });
    if (runtime!.houses[1].debugBuildSpeed !== 1 || runtime!.houses[1].debugDamageScale !== 1000) throw new Error('Debug changed the opponent');
    await advance(45);
    // This contains a live construction animation and its unconsumed accounting report.
    const saved = await game!.saveState();
    await new Promise(resolve => setTimeout(resolve, 150));
    if (runtime!.battle.frame !== saved.frame || !game!.isPaused()) throw new Error('The paused mission advanced');
    const { buffers, ...metadata } = saved;
    const file = encodeSave({ metadata, buffers });
    await advance(135);
    runtime!.choose('NUKE');
    await advance(245);
    const expected = await runtime!.battle.snapshot(), expectedCpu = await runtime!.saveState();
    game!.dispose(); game = undefined;
    await start();
    const loaded = decodeSave<Omit<GameState, 'buffers'>>(file);
    game!.loadState({ ...loaded.metadata, buffers: loaded.buffers });
    const restored = await game!.readDebugState();
    if (restored.gameSpeed !== 100 || restored.buildSpeed !== 10 || restored.damageScale !== 500 || runtime!.battle.debugDamageScale.value !== 500) throw new Error('Saved Debug settings were not restored');
    await advance(135); runtime!.choose('NUKE'); await advance(245);
    const actual = await runtime!.battle.snapshot(), actualCpu = await runtime!.saveState();
    for (let b = 0; b < expected.length; b++) {
      const index = expected[b].findIndex((word, i) => word !== actual[b][i]);
      if (index >= 0) throw new Error(`Save continuation differs in simulation buffer ${b}, word ${index}: ${actual[b][index]} != ${expected[b][index]}`);
    }
    if (JSON.stringify(actualCpu) !== JSON.stringify(expectedCpu)) throw new Error('Saved CPU economy continuation differs');
    if (!runtime!.buildings.size || !runtime!.queues.items.size) throw new Error('Save journey did not exercise construction and production');
    return { frame: runtime!.battle.frame, buffers: expected.length, saveBytes: file.length };
  } finally { game?.dispose(); renderer.dispose(); canvas.remove(); }
}
