import { createRenderer } from '../src/engine/renderer.ts';
import { loadData } from '../src/game/data-files.ts';
import { skirmishScene } from '../src/game/skirmish-scene.ts';
import { MatchRuntime } from '../src/game/match-runtime.ts';
import { GpuArmyOrders } from '../src/game/ai/army-orders.ts';
import type { ArmyOrder } from '../src/game/ai/commander.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { GpuAircraft } from '../src/game/simulation/aircraft-gpu.ts';
import { GpuAirOperations } from '../src/game/simulation/air-operations-gpu.ts';
import { GpuTransport } from '../src/game/simulation/transport-gpu.ts';
import { GpuServices } from '../src/game/simulation/services-gpu.ts';
import { GpuTiberium } from '../src/game/simulation/tiberium-gpu.ts';
import { GpuHarvest } from '../src/game/simulation/harvest-gpu.ts';
import { GpuBuildingEffects } from '../src/game/simulation/building-effects-gpu.ts';
import { GpuSight } from '../src/game/simulation/sight.ts';
import { stepBattle } from '../src/game/simulation/tick.ts';
import { MOVEMENT } from '../src/game/data/movement.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import { HBASE, HWORDS, HMODE, HLOAD, HREF, HTIMER, HGOAL, HGEN } from '../src/game/simulation/harvest-cpu.ts';
import { AIR_WORDS, AMISSION, ASTATUS } from '../src/game/simulation/aircraft-cpu.ts';

export interface MatchSimulationOptions {
  seed: number;
  ticks: number;
  /** Diagnostic sampling only; every logic tick still runs. */
  progressEvery?: number;
  /** Diagnostic only: issue an explicit all-armed-units attack after this tick. */
  forceAttackAt?: number;
}

/** No RAF, presentation, audio, wall-clock multiplier or timer sleeps. */
export async function runMatchSimulation(options: MatchSimulationOptions,
  progress?: (frame: number, snapshot: object) => void | Promise<void>) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:1px;height:1px';
  document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!wrapper) throw new Error('WebGPU is required');
  const renderer = wrapper.three;
  renderer.setAnimationLoop(null);
  renderer.render = () => { throw new Error('A logic-only match must not render'); };

  const world = skirmishScene(await loadData(false, true, true), {
    seed: options.seed, credits: 10000,
  });
  const battle = new GpuCombat(renderer, world.setup);
  const economy = new MatchRuntime(battle, world);
  const orders: ArmyOrder[] = [];
  for (const commander of economy.commanders) {
    const step = commander.step.bind(commander);
    commander.step = current => {
      const order = step(current);
      if (order) { orders.push(order); if (orders.length > 32) orders.shift(); }
      return order;
    };
  }
  const aircraft = new GpuAircraft(battle.movement);
  const airOperations = new GpuAirOperations(battle, aircraft, world.playable);
  const transport = new GpuTransport(battle, aircraft, world.playable, economy.transportState);
  const services = new GpuServices(battle, economy.serviceState);
  const ore = new GpuTiberium(renderer, world.tiberium, battle.movement.occupancy);
  ore.connect(battle, world.baseLand, () => economy.placement.bibs);
  const harvest = new GpuHarvest(economy, ore);
  const opposingSight = new GpuSight(renderer, world.setup.grid.width, world.setup.grid.height,
    battle.units, 1, world.setup.bounds);
  // Fires are simulation, not just pictures: their damage must run in logic-only checks too.
  const buildingEffects = new GpuBuildingEffects(battle, world.scene.animation!.frames);
  const forced = options.forceAttackAt === undefined ? undefined : new GpuArmyOrders(battle);
  const systems = { battle, economy, aircraft, airOperations, transport, services, ore,
    harvest, opposingSight, buildingEffects };
  economy.lifecycle.useAircraft(aircraft.state);
  economy.lifecycle.validateTerrain(ore.amount);

  try {
    battle.movement.enableOccupancyEdits();
    await battle.prepareForPlay();
    await renderer.compileComputeAsync(aircraft.kernels);
    await renderer.compileComputeAsync([...airOperations.beforePass, airOperations.afterPass]);
    await renderer.compileComputeAsync(transport.kernels);
    await renderer.compileComputeAsync(services.kernels);
    await renderer.compileComputeAsync(harvest.kernels);
    await ore.prepareForPlay();
    await buildingEffects.prepareForPlay();
    await economy.prepareForPlay();
    await forced?.prepare();

    const started = performance.now();
    const inspect = async () => {
      const elapsedMs = performance.now() - started;
      const [units, combat, goals, mining, air, paths] = await Promise.all([
        battle.units, battle.state, battle.movement.goals, economy.miningState, aircraft.state, battle.movement.pathGoals,
      ].map(async buffer => new Int32Array(await renderer.getArrayBufferAsync(buffer))));
      const actors = Array.from({ length: world.setup.units.length }, (_, id) => {
        const at = id * U.WORDS, state = id * C.CWORDS;
        return {
          id, type: MOVEMENT[units[at + U.UTYPE]].name, owner: units[at + U.UOWNER],
          health: units[at + U.UHEALTH], cell: units[at + U.UCELL], destination: units[at + U.UDEST],
          goal: goals[id], pathGoal: paths[id], target: combat[state + C.CTARGET], mission: combat[state + C.CMISSION],
          guardCell: combat[state + C.CGUARD_CELL] - 1, suspendedMission: combat[state + C.CSUSPENDED_MISSION] - 1,
          obstruction: units[at + U.UOBSTRUCTION] - 1,
          attached: units[at + U.UATTACHED], enter: units[at + U.UENTER],
          wait: units[at + U.UWAIT], retries: units[at + U.URETRIES],
          localRoute: combat[state + C.CLOCAL_ROUTE], localDestination: combat[state + C.CLOCAL_DEST],
          origin: units[at + U.UORIGIN], ammo: combat[state + C.CAMMO],
          generation: units[at + U.UGENERATION], facing: units[at + U.UFACE], desiredFacing: units[at + U.UDESIRED],
          track: units[at + U.UTRACK], trackStep: units[at + U.UTRACK_STEP], speed: units[at + U.USPEED],
          harvestMode: mining[HBASE + id * HWORDS + HMODE], load: mining[HBASE + id * HWORDS + HLOAD],
          refinery: mining[HBASE + id * HWORDS + HREF], harvestGoal: mining[HBASE + id * HWORDS + HGOAL],
          harvestTimer: mining[HBASE + id * HWORDS + HTIMER], harvestGeneration: mining[HBASE + id * HWORDS + HGEN],
          airMission: air[id * AIR_WORDS + AMISSION], airStatus: air[id * AIR_WORDS + ASTATUS],
        };
      }).filter(actor => actor.health > 0);
      return {
        options, frame: battle.frame, outcome: economy.outcome ?? null, elapsedMs,
        ticksPerSecond: battle.frame * 1000 / elapsedMs, drawCalls: 0,
        houses: economy.houses.map(house => ({
          owner: house.owner, money: house.economy.money,
          harvested: house.economy.harvested, lost: house.lost,
          production: [...house.queues.items.values()].map(item => ({
            name: item.type.name, stage: item.stage, suspended: item.suspended,
          })),
          supers: Object.entries(economy.supers.charges[house.owner]).map(([name, charge]) => ({
            name, present: charge.present, ready: charge.ready, remaining: charge.remaining(economy.frame),
          })),
        })),
        actors, orders: [...orders],
        structures: [...economy.buildings.values()].map(b => ({ id: b.id, type: b.type, cell: b.cell,
          owner: b.owner, active: b.active, health: b.health, started: b.started, duration: b.duration })),
      };
    };
    while (battle.frame < options.ticks) {
      if (!economy.beginTick()) {
        if (economy.outcome !== undefined) break;
        throw new Error('A completed economy report did not permit the next tick');
      }
      stepBattle(systems);
      if (forced && battle.frame === options.forceAttackAt) {
        for (const owner of [0, 1]) forced.issue({ owner, frame: battle.frame, attack: true, forced: true });
      }
      await economy.endTick();
      if (progress && battle.frame % (options.progressEvery ?? 3000) === 0) await progress(battle.frame, await inspect());
    }
    return await inspect();
  } finally {
    forced?.dispose();
    opposingSight.dispose();
    buildingEffects.dispose();
    harvest.dispose();
    ore.dispose();
    services.dispose();
    transport.dispose();
    airOperations.dispose();
    aircraft.dispose();
    economy.dispose();
    battle.dispose();
    world.scene.setup.displacement?.dispose();
    wrapper.dispose();
    canvas.remove();
  }
}
