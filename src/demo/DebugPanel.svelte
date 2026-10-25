<script lang="ts">
  import { untrack } from 'svelte';
  import type { DemoConfig, DemoGame } from './game.ts';
  import { DEMO_SPEEDS, type DemoSpeed } from './production.ts';
  import type { SightPerspective } from '../game/simulation/sight-view.ts';
  import { parseSeed, randomSeed } from './match-seed.ts';

  let { config, game, frame, digest, actualSpeed, outcome, onRestart }: {
    config: DemoConfig; game: DemoGame; frame: number; digest: string; actualSpeed: number;
    outcome?: number; onRestart: (config: DemoConfig) => void;
  } = $props();
  const titles = {
    buildings: 'Buildings · MCV sandbox', economy: 'Economy · MCV opening',
    combat: 'Ground combat · GDI vs Nod', units: 'Units and controls · Vehicles, infantry and aircraft',
    simulation: 'GPU simulation · 320 tanks', match: 'Match · GDI vs Nod · Green Acres',
  };
  const economic = $derived(config.name === 'buildings' || config.name === 'economy' || config.name === 'match');
  let controlsOpen = $state(untrack(() => config.name !== 'buildings' && config.name !== 'economy'));
  let flow = $state(false), vision = $state(false), paused = $state(false);
  let waves = $state(false), density = $state(false);
  let productionSpeed = $state<DemoSpeed>(1), simulationSpeed = $state<DemoSpeed>(1);
  let perspective = $state<SightPerspective>(untrack(() => config.name === 'match' ? 'all' : 0));
  let controller = $state<number | null>(null);
  let seed = $state(untrack(() => String(config.seed ?? 0)));
  const parsedSeed = $derived(parseSeed(seed));
</script>

<aside class="simulation-controls" aria-label="Simulation demo">
  <details bind:open={controlsOpen}>
    <summary>{titles[config.name]}</summary>
    {#if config.name === 'match'}
      <div class="controls">
        <label>Control
          <select aria-label="Control" bind:value={controller} disabled={outcome !== undefined} onchange={() => game.setController(controller)}>
            <option value={null}>Observe</option><option value={0}>Take over GDI</option><option value={1}>Take over Nod</option>
          </select>
        </label>
      </div>
      <div class="controls">
        <label>Seed <input bind:value={seed} inputmode="numeric" size="11" /></label>
        <button type="button" disabled={parsedSeed === undefined} onclick={() => onRestart({ ...config, seed: parsedSeed })}>Start with seed</button>
        <button type="button" onclick={() => onRestart(config)}>Restart same seed</button>
        <button type="button" onclick={() => onRestart({ ...config, seed: randomSeed() })}>Random new match</button>
      </div>
      {#if parsedSeed === undefined}<div>Enter an integer from 0 to 4294967295.</div>{/if}
      {#if outcome !== undefined}<div role="status" data-outcome={outcome}>{outcome === 0 ? 'GDI wins' : outcome === 1 ? 'Nod wins' : 'Draw'}</div>{/if}
    {/if}
    {#if economic && (config.name !== 'match' || controller !== null)}<div>Select the MCV and press D to deploy. Use the sidebar to build. Right-click a cameo to hold, then again to cancel.</div>{/if}
    {#if config.name === 'match' && controller === null}
      <div>Both armies are controlled by AI. Move the camera, change the map view, or take over either side.</div>
    {:else if config.name !== 'simulation'}
      <div>Click to capture the pointer. Left-click or drag to select, then left-click ground to move. {#if config.name === 'combat'}Left-click enemies to attack; Ctrl+click forces an attack. Nod positions are to the east.{/if} Right-click clears the selection. Esc releases the pointer.</div>
    {:else}
      <div>Click the map to capture the pointer, then click open ground to move all tanks. Esc releases the pointer.</div>
    {/if}
    <div class="controls">
      <button type="button" aria-pressed={flow} onclick={() => { flow = !flow; game.setFlow(flow); }}>Flow field</button>
      {#if config.name === 'units' || config.name === 'combat'}<button type="button" aria-pressed={vision} onclick={() => { vision = !vision; game.setVision(vision); }}>Sight</button>{/if}
      <button type="button" disabled={outcome !== undefined} aria-pressed={paused} onclick={() => { paused = !paused; game.setPaused(paused); }}>{paused ? 'Resume' : 'Pause'}</button>
      {#if config.name === 'buildings'}<button type="button" aria-pressed={waves} onclick={() => { waves = !waves; game.setWaves(waves); }}>{waves ? 'Stop reinforcements' : 'Start reinforcements'}</button>{/if}
      {#if economic}<button type="button" aria-pressed={density} onclick={() => { density = !density; game.setDensity(density); }}>Ore density</button>{/if}
      {#if config.name !== 'match'}<a href={`?demo=${config.name}${economic ? `&faction=${config.faction === 2 ? 'nod' : 'gdi'}` : ''}`}>Reset</a>{/if}
      <a href="?">Original map</a>
    </div>
    <div class="controls" role="group" aria-label="Simulation speed">
      <span>Simulation speed</span>
      {#each DEMO_SPEEDS as speed}
        <button type="button" aria-pressed={simulationSpeed === speed} onclick={() => { simulationSpeed = speed; game.setSimulationSpeed(speed); }}>{speed}×</button>
      {/each}
      <span data-actual-speed={actualSpeed}>Actual {actualSpeed.toFixed(1)}×</span>
    </div>
    {#if config.name !== 'simulation'}
      <div class="controls">
        <label>Map view
          <select bind:value={perspective} onchange={() => game.setPerspective(perspective)}>
            <option value={0}>{config.name === 'match' ? 'GDI' : 'Own side'}</option>
            <option value={1}>{config.name === 'match' ? 'Nod' : 'Other side'}</option>
            <option value="all">Full map</option>
          </select>
        </label>
      </div>
    {/if}
    {#if economic && config.name !== 'match'}
      <div class="controls" role="group" aria-label="Production speed">
        <span>Production speed</span>
        {#each DEMO_SPEEDS as speed}
          <button type="button" aria-pressed={productionSpeed === speed} onclick={() => { productionSpeed = speed; game.setProductionSpeed(speed); }}>×{speed}</button>
        {/each}
      </div>
    {/if}
    <div>Tick <span data-tick={frame}>{frame}</span> · 15 ticks/s at 1× · pauses in the background</div>
    {#if simulationSpeed !== 1}<div>Fast-forward audio is muted.</div>{/if}
    {#if digest}<code title="Asynchronous simulation checksum">{digest}</code>{/if}
  </details>
</aside>

<style>
  .simulation-controls {
    position: absolute;
    top: 12px;
    left: 12px;
    max-width: 420px;
    padding: 12px 16px;
    background: #101b25ed;
    border: 1px solid #527184;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.7;
  }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 8px 0; }
  summary { cursor: pointer; font-weight: 600; }
  .controls button { cursor: pointer; padding: 4px 8px; }
  .controls button[aria-pressed='true'] { background: #82ddd8; }
  .controls a { color: #a8e2ff; }
  code { color: #9cbdc9; font-size: 10px; }
</style>
