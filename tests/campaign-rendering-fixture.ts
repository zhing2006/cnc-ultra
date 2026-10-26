import { createRenderer } from '../src/engine/renderer.ts';
import { PalettePipeline } from '../src/engine/indexed/pipeline.ts';
import { CampaignAssets } from '../src/game/campaign/assets.ts';
import { readCampaignScenario } from '../src/game/campaign/scenario.ts';
import { campaignScene } from '../src/game/campaign/scene.ts';
import { GpuNaval, NAVAL_WORDS, stepNaval, landingCell } from '../src/game/campaign/naval.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { EconomyRuntime } from '../src/game/simulation/economy-runtime.ts';
import { GpuTiberium } from '../src/game/simulation/tiberium-gpu.ts';
import { GpuGround, groundLayout, updateGroundKeys, groundLayers, transitionGround, bubbleGround } from '../src/game/simulation/ground.ts';
import { CombatView, combatExtraSprites } from '../src/game/simulation/combat-view.ts';
import { BuildingView } from '../src/game/simulation/building-view.ts';
import { REMAP_NAMES } from '../src/game/data/houses.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';

/** Campaign draw records must preserve house colors and the original disembarking order. */
export async function campaignRendering() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:480px;height:320px'; document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => { throw new Error(message); } });
  if (!wrapper) throw new Error('WebGPU is required');
  const renderer = wrapper.three;
  try {
    const assets = await CampaignAssets.open(), archives = ['gdi/general.mix', 'general.mix'];
    const [ini, bin, files] = await Promise.all([
      assets.bytes('SCG01EA.INI', archives), assets.bytes('SCG01EA.BIN', archives), assets.mission('gdi', 'TEMPERATE'),
    ]);
    const mission = readCampaignScenario(new TextDecoder().decode(ini), bin);
    const enemy = mission.scenario.infantry.find(unit => unit.house === 'BadGuy')!;
    const placement = { house: 'GoodGuy', strength: 256, facing: 0, mission: 'Sleep', cell: 0 };
    mission.scenario.units = [{ ...placement, type: 'LST' }];
    mission.scenario.infantry = [...Array.from({ length: 3 }, () => ({ ...placement, type: 'E1', spot: 0 })), { ...enemy, mission: 'Sleep' }];
    mission.scenario.buildings = [];
    const world = campaignScene(files, mission, 1995, 8), { scene, setup } = world;
    for (let id = 1; id <= 3; id++) setup.units[id].attached = 1;
    setup.units[4].cell = landingCell(world.navalMap, () => false) - setup.grid.width * 2;
    const cpu = new CpuCombat(setup), battle = new GpuCombat(renderer, setup);
    const economy = new EconomyRuntime(battle, world), naval = new GpuNaval(battle, world.navalMap);
    const navalState = new Int32Array(setup.units.length * NAVAL_WORDS);
    const ore = new GpuTiberium(renderer, world.tiberium);
    const layout = groundLayout(scene, U.initialUnits(setup), U.WORDS);
    const pipeline = new PalettePipeline(renderer, { ...scene.setup,
      spriteCapacity: layout.count + combatExtraSprites(setup, scene), dynamicSprites: { maxWidth: 128, maxHeight: 128 },
    });
    const ground = new GpuGround(renderer, battle, pipeline, layout, scene, undefined, true);
    const combat = new CombatView(renderer, battle, ground, pipeline, scene, world.decalStart, true);
    const buildings = new BuildingView(economy, ground, pipeline, ore);
    const failures = new Set<string>(), screenshots: { name: string; data: string }[] = [];
    const draw = async () => {
      ground.updateSprites(false); combat.update(false); buildings.update(); pipeline.updateGpuSprites(combat.count);
      return new Float32Array(await renderer.getArrayBufferAsync(pipeline.spriteBuffer));
    };
    const capture = (name: string, x: number, y: number) => {
      pipeline.render({ x: x - 60, y: y - 40, width: 120, height: 80 }, 4);
      screenshots.push({ name, data: canvas.toDataURL('image/png').split(',')[1] });
    };
    try {
      await battle.prepareForPlay(); await naval.prepare();
      const order = new Uint32Array(await renderer.getArrayBufferAsync(ground.order.order));
      const previousLayers = groundLayers(layout, cpu.units), cpuOrder = order.slice();
      const enemySlot = order.findIndex(entry => layout.bindings[entry * 5] === 4);
      const record = (layout.first + enemySlot * layout.slots) * 12;
      const units = battle.units.array as Int32Array, state = battle.state.array as Int32Array;
      // INFANTRY.CPP Draw_It -> TECHNO.CPP Techno_Draw_Object uses the same
      // House->Remap_Table for walking, firing and every frame of a death sequence.
      for (const [owner, color] of [[1, 'blue'], [0, 'yellow']] as const) {
        units[4 * U.WORDS + U.UOWNER] = owner;
        for (const age of [-1, 0, 2, 8]) {
          units[4 * U.WORDS + U.UHEALTH] = age < 0 ? 50 : 0;
          state[4 * C.CWORDS + C.CDEATH] = age < 0 ? -1 : 0;
          (battle.movement.control.array as Int32Array)[0] = Math.max(age, 0);
          battle.units.needsUpdate = battle.state.needsUpdate = battle.movement.control.needsUpdate = true;
          const sprites = await draw();
          if (sprites[record + 2] <= 0 || sprites[record + 6] !== REMAP_NAMES.indexOf(color))
            failures.add(`${color} infantry at death age ${age}: remap ${sprites[record + 6]}`);
          if (owner === 1 && age === 2) capture('campaign-infantry-death', Math.round(units[4 * U.WORDS] * 24 / 256), Math.round(units[4 * U.WORDS + 1] * 24 / 256));
        }
      }
      cpu.units[4 * U.WORDS + U.UHEALTH] = 0;
      units.set(cpu.units); state.set(cpu.state); (battle.movement.control.array as Int32Array).fill(0);
      battle.units.needsUpdate = battle.state.needsUpdate = battle.movement.control.needsUpdate = true;
      let unloading = false, released = false;
      for (let tick = 0; tick < 600 && !released; tick++) {
        // Match game.ts: naval delivery, ground sort, then movement and combat.
        stepNaval(cpu, navalState, world.navalMap); cpu.movement.occupy();
        const beforeMovement = cpu.units.slice(), cpuKeys = layout.keys.slice();
        updateGroundKeys(layout, beforeMovement, cpuKeys);
        const detached = transitionGround(layout, beforeMovement, cpuKeys, cpuOrder, previousLayers);
        for (let sweep = 0; sweep < (detached ? 3 : 1); sweep++) bubbleGround(cpuOrder, cpuKeys);
        naval.step(); ground.sort(); cpu.step(); battle.step();
        if (navalState[0] !== 3 && !(unloading && navalState[0] >= 4)) continue;
        const keys = new Int32Array(await renderer.getArrayBufferAsync(ground.keys));
        if (keys.some((value, i) => value !== cpuKeys[i])) failures.add('CPU/GPU ground keys differ during disembarking');
        const sorted = new Uint32Array(await renderer.getArrayBufferAsync(ground.order.order));
        if (sorted.some((value, i) => value !== cpuOrder[i])) failures.add('CPU/GPU draw order differs during disembarking');
        const unitKeys = new Map<number, number>();
        for (let entry = 0; entry < layout.bindings.length / 5; entry++) unitKeys.set(layout.bindings[entry * 5], keys[entry * 2 + 1]);
        // UNIT.CPP Sort_Y: tethered hovercraft sorts half a cell above its center.
        const tethered = navalState[0] === 3;
        if (unitKeys.get(0) !== beforeMovement[U.UY] + (tethered ? -128 : 128)) failures.add('Hovercraft does not sort behind disembarking passengers');
        for (let id = 1; id <= 3; id++) {
          // FOOT.CPP Sort_Y / Per_Cell_Process: IsUnloading adds a full cell
          // until the passenger reaches its first destination; normal infantry adds 0x30.
          const aboardCell = beforeMovement[id * U.WORDS + U.UCELL] === beforeMovement[U.UCELL];
          if (unitKeys.get(id) !== beforeMovement[id * U.WORDS + U.UY] + (aboardCell ? 256 : 48)) failures.add('Infantry does not retain its unloading sort offset until reaching land');
        }
        if (!unloading) {
          const sprites = await draw();
          const boatSlot = sorted.findIndex(entry => layout.bindings[entry * 5] === 0);
          for (let id = 1; id <= 3; id++) {
            const slot = sorted.findIndex(entry => layout.bindings[entry * 5] === id), at = (layout.first + slot * layout.slots) * 12;
            if (slot < boatSlot || sprites[at + 2] <= 0) failures.add(`A disembarking passenger is drawn underneath the hovercraft: passenger ${id}, slot ${slot}, boat slot ${boatSlot}, width ${sprites[at + 2]}`);
          }
          capture('campaign-hovercraft-unloading', Math.round(cpu.units[U.UX] * 24 / 256), Math.round(cpu.units[U.UY] * 24 / 256));
        }
        unloading = true; released = !tethered;
      }
      if (!unloading || !released) failures.add('The hovercraft did not finish unloading');
      const actual = new Int32Array(await renderer.getArrayBufferAsync(battle.units));
      if (actual.some((value, i) => value !== cpu.units[i])) failures.add('CPU/GPU units differ after unloading');
      return { failures: [...failures], screenshots };
    } finally {
      buildings.dispose(); combat.dispose(); ground.dispose(); pipeline.dispose(); ore.dispose(); naval.dispose(); economy.dispose(); battle.dispose();
    }
  } finally { wrapper.dispose(); canvas.remove(); }
}
