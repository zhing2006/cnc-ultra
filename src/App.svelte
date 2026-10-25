<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { createRenderer, DeviceLostError, type Renderer } from './engine/renderer.ts';
  import { MissingDataError } from './game/data-files.ts';
  import { startGame, type Game } from './game/game.ts';
  import Preview from './Preview.svelte';
  import Loading from './Loading.svelte';

  const preview = new URLSearchParams(location.search).get('preview') === 'assets';
  const simulation = new URLSearchParams(location.search).get('demo') === 'simulation';
  const combat = new URLSearchParams(location.search).get('demo') === 'combat';
  const units = new URLSearchParams(location.search).get('demo') === 'units';
  const buildings=new URLSearchParams(location.search).get('demo')==='buildings';
  const economy=new URLSearchParams(location.search).get('demo')==='economy';
  const faction=new URLSearchParams(location.search).get('faction')==='nod'?2:1;
  let waves=$state(false);
  let density=$state(false);
  const productionSpeeds=[1,10,100] as const;
  let productionSpeed=$state<1|10|100>(1);
  let controlsOpen=$state(!buildings&&!economy);
  let vision = $state(false);
  let flow = $state(false), paused = $state(false), frame = $state(0), digest = $state('');

  type Status = 'starting' | 'running' | 'unsupported' | 'nodata' | 'failed' | 'lost';

  let canvas = $state<HTMLCanvasElement>(null!);
  let status: Status = $state('starting');
  let loadingMessage = $state('Checking graphics support');
  let renderer: Renderer | null = null;
  let game: Game | null = null;
  let unmounted = false;

  function stopGame() {
    game?.dispose();
    game = null;
  }

  function lost(message: string) {
    console.error(`WebGPU device lost: ${message}`);
    stopGame();
    renderer = null;
    status = 'lost';
  }

  async function start() {
    status = 'starting';
    try {
      await showProgress('Checking graphics support');
      const created = await createRenderer(canvas, { onDeviceLost: lost });
      if (unmounted) {
        created?.dispose();
        return;
      }
      renderer = created;
      if (!created) {
        status = 'unsupported';
        return;
      }
      const started = await startGame(created, canvas, { simulation, units, combat, buildings, economy, faction,
        onProgress: showProgress,
        onStats: (value, checksum) => { frame = value; digest = checksum; } });
      if (unmounted || renderer !== created) {
        started.dispose();
        return;
      }
      game = started;
      game.setFlow(flow);
      game.setVision(vision);
      game.setPaused(paused);
      game.setWaves(waves);
      game.setProductionSpeed(productionSpeed);
      status = 'running';
    } catch (error) {
      if (error instanceof DeviceLostError) {
        lost(error.message);
      } else if (error instanceof MissingDataError) {
        console.warn(error.message);
        status = 'nodata';
      } else {
        console.error(error);
        status = 'failed';
      }
    }
  }

  async function showProgress(message: string) {
    loadingMessage = message;
    await tick();
    // Let the browser paint the new stage before CPU-heavy scene and shader preparation.
    await new Promise<void>(resolve => {
      if (document.hidden) setTimeout(resolve, 0);
      else requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  }

  onMount(() => {
    if (preview) return;
    start();
    return () => {
      unmounted = true;
      stopGame();
      renderer?.dispose();
    };
  });
</script>

{#if preview}
  <Preview />
{:else}
  <canvas bind:this={canvas} data-status={status}></canvas>
  {#if status === 'starting'}<Loading message={loadingMessage} />{/if}
{/if}

{#if (simulation || units || combat || buildings || economy) && !preview && status === 'running'}
  <aside class="simulation-controls" aria-label="Simulation demo">
    <details bind:open={controlsOpen}>
    <summary>{buildings?'Buildings · MCV sandbox':economy?'Economy · MCV opening':combat ? 'Ground combat · GDI vs Nod' : units ? 'Units and controls · Vehicles, infantry and aircraft' : 'GPU simulation · 320 tanks'}</summary>
    {#if buildings || economy}<div>Select the MCV and press D to deploy. Use the sidebar to build. Right-click a cameo to hold, then again to cancel.</div>{/if}
    {#if units || combat || buildings || economy}
      <div>Click to capture the pointer. Left-click or drag to select, then left-click ground to move. {#if combat}Left-click enemies to attack; Ctrl+click forces an attack. Nod positions are to the east.{/if} Right-click clears the selection. Esc releases the pointer.</div>
    {:else}
      <div>Click the map to capture the pointer, then click open ground to move all tanks. Esc releases the pointer.</div>
    {/if}
    <div class="controls">
      <button type="button" aria-pressed={flow} onclick={() => { flow = !flow; game?.setFlow(flow); }}>Flow field</button>
      {#if units || combat}<button type="button" aria-pressed={vision} onclick={() => { vision = !vision; game?.setVision(vision); }}>Sight</button>{/if}
      <button type="button" aria-pressed={paused} onclick={() => { paused = !paused; game?.setPaused(paused); }}>{paused ? 'Resume' : 'Pause'}</button>
      {#if buildings}<button type="button" aria-pressed={waves} onclick={()=>{waves=!waves;game?.setWaves(waves);}}>{waves?'Stop reinforcements':'Start reinforcements'}</button>{/if}
      {#if buildings||economy}<button type="button" aria-pressed={density} onclick={()=>{density=!density;game?.setDensity(density);}}>Ore density</button>{/if}
      <a href={buildings?'?demo=buildings':economy?`?demo=economy&faction=${faction===2?'nod':'gdi'}`:combat ? '?demo=combat' : units ? '?demo=units' : '?demo=simulation'}>Reset</a>
      <a href="?">Original map</a>
    </div>
    {#if buildings||economy}
      <div class="controls" aria-label="Production speed">
        <span>Production speed</span>
        {#each productionSpeeds as speed}
          <button type="button" aria-pressed={productionSpeed===speed} onclick={()=>{productionSpeed=speed;game?.setProductionSpeed(speed);}}>×{speed}</button>
        {/each}
      </div>
    {/if}
    <div>Tick <span data-tick={frame}>{frame}</span> · 15 ticks/s · pauses in the background</div>
    {#if digest}<code title="Asynchronous simulation checksum">{digest}</code>{/if}
    </details>
  </aside>
{/if}

{#if status === 'unsupported'}
  <p class="notice">This browser does not support WebGPU. Open the page in a recent Chrome or Edge.</p>
{:else if status === 'nodata'}
  <p class="notice">
    The original game data is missing. Put the C&amp;C MIX files in the data/ directory next to this page.
  </p>
{:else if status === 'failed'}
  <p class="notice">WebGPU failed to start. See the browser console for details.</p>
{:else if status === 'lost'}
  <div class="notice">
    <p>The GPU device was lost, for example because the graphics driver restarted.</p>
    <button type="button" onclick={start}>Restart</button>
  </div>
{/if}

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
  .controls { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
  summary { cursor: pointer; font-weight: 600; }
  .controls button { cursor: pointer; padding: 4px 8px; }
  .controls button[aria-pressed='true'] { background: #82ddd8; }
  .controls a { color: #a8e2ff; }
  code { color: #9cbdc9; font-size: 10px; }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }

  .notice {
    position: absolute;
    inset: 0;
    height: fit-content;
    margin: auto;
    text-align: center;
  }
</style>
