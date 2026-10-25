import { createRenderer } from '../src/engine/renderer.ts';
import { CampaignAssets } from '../src/game/campaign/assets.ts';
import { readCampaignScenario } from '../src/game/campaign/scenario.ts';
import { campaignScene } from '../src/game/campaign/scene.ts';
import { CampaignRuntime } from '../src/game/campaign/runtime.ts';
import { startPreparedGame, type Game } from '../src/game/game.ts';
import { canPlaceBuilding } from '../src/game/simulation/building-rules.ts';
import { TARGET, DESTINATION } from '../src/game/simulation/lifecycle-gpu.ts';
import { MOVEMENT } from '../src/game/data/movement.ts';
import * as U from '../src/game/simulation/units-state.ts';

/** A player issues ordinary production/attack orders; original triggers alone decide victory. */
export async function playFirstMission() {
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:960px;height:600px'; document.body.append(canvas);
  const renderer = await createRenderer(canvas, { onDeviceLost: message => { throw new Error(message); } });
  if (!renderer) throw new Error('WebGPU is required');
  let game: Game | undefined;
  try {
    const assets = await CampaignAssets.open(), archives = ['gdi/general.mix', 'general.mix'];
    const [ini, bin, files] = await Promise.all([assets.bytes('SCG01EA.INI', archives), assets.bytes('SCG01EA.BIN', archives), assets.mission('gdi', 'TEMPERATE')]);
    const mission = readCampaignScenario(new TextDecoder().decode(ini), bin), world = campaignScene(files, mission, 0x1995, 96);
    let runtime!: CampaignRuntime, target = 0, reached: (() => void) | undefined, result: number | undefined;
    game = await startPreparedGame(renderer, canvas, files, { kind: 'combat', scene: world.scene, setup: world.setup, economy: world, decalStart: world.decalStart }, {
      createEconomy: battle => runtime = new CampaignRuntime(battle, world, mission),
      onStats: frame => { if (frame === target) { game!.setPaused(true); reached?.(); } },
      onOutcome: winner => { result = winner; reached?.(); },
    });
    game.setPaused(true); game.setSimulationSpeed(100);
    // Clear the landing party from the construction yard's deployment footprint first.
    for (const id of [2, 3, 4, 5]) runtime.lifecycle.edit(id, DESTINATION, 3450);
    const events: { name: string; frame: number }[] = [];
    const event = runtime.onEvent; runtime.onEvent = (name, owner) => { event?.(name, owner); if (name === 'reinforcements') events.push({ name, frame: runtime.frame }); };
    let trained = 0;
    for (target = 120; target <= 12000 && result === undefined; target += 120) {
      const done = new Promise<void>(resolve => { reached = resolve; }); game.setPaused(false); await done;
      if (result !== undefined) break;
      await runtime.saveState();
      const units = (await runtime.battle.snapshot())[1];
      const ownBuildings = [...runtime.buildings.values()].filter(b => b.owner === 0 && b.health > 0);
      if (!ownBuildings.some(b => b.type === 'FACT')) runtime.deploy(0);
      const nextBuilding = ['NUKE', 'PYLE'].find(name => !ownBuildings.some(b => b.type === name));
      const construction = runtime.queues.items.get('building');
      if (construction?.complete) {
        const cell = Array.from(world.playable.keys()).find(cell => canPlaceBuilding(runtime.placement, construction.type.name, cell, 0));
        if (cell === undefined) throw new Error('No legal first-mission construction location');
        runtime.command(() => runtime.place(construction.type.name, cell));
      } else if (!construction && nextBuilding) runtime.choose(nextBuilding);
      if (!runtime.queues.items.has('infantry') && ownBuildings.some(b => b.type === 'PYLE' && b.active) && runtime.house.money >= 100) { runtime.choose('E1'); trained++; }
      const army: number[] = [], enemies: number[] = [];
      for (let id = 0; id < world.setup.units.length; id++) {
        const at = id * U.WORDS;
        if (units[at + U.UHEALTH] <= 0 || units[at + U.UATTACHED]) continue;
        if (units[at + U.UOWNER] === 1) enemies.push(id);
        else if (['E1', 'JEEP'].includes(MOVEMENT[units[at + U.UTYPE]].name)) army.push(id);
      }
      if (target >= 1680 && army.length && enemies.length) {
        const centerX = Math.trunc(army.reduce((sum, id) => sum + units[id * U.WORDS + U.UX], 0) / army.length);
        const centerY = Math.trunc(army.reduce((sum, id) => sum + units[id * U.WORDS + U.UY], 0) / army.length);
        enemies.sort((a, b) => Math.abs(units[a * U.WORDS] - centerX) + Math.abs(units[a * U.WORDS + 1] - centerY)
          - Math.abs(units[b * U.WORDS] - centerX) - Math.abs(units[b * U.WORDS + 1] - centerY));
        for (const id of army) runtime.lifecycle.edit(id, TARGET, enemies[0]);
      }
      if (target === 12000) throw new Error(`First mission did not end: ${JSON.stringify({ trained, army, enemies, buildings: ownBuildings.map(b => b.type), triggers: runtime.saveCampaign() })}`);
    }
    if (result !== 0) throw new Error(`First-mission player lost at tick ${runtime.frame}`);
    if (events.length < 4 || trained < 1) throw new Error(`Victory journey did not exercise all timed reinforcements and production: ${JSON.stringify({ frame: runtime.frame, trained, events, buildings: [...runtime.buildings.values()], money: runtime.house.money, available: runtime.available.map(t => t.name), queues: runtime.queues.saveState() })}`);
    return { result, frame: runtime.frame, trained, reinforcements: events, remainingMoney: runtime.house.money };
  } finally { game?.dispose(); renderer.dispose(); canvas.remove(); }
}
