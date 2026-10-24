<script lang="ts">
  import { onMount } from 'svelte';
  import { createRenderer, DeviceLostError, type Renderer } from './engine/renderer.ts';
  import { MissingDataError } from './game/data-files.ts';
  import { startGame, type Game } from './game/game.ts';
  import Preview from './Preview.svelte';

  const preview = new URLSearchParams(location.search).get('preview') === 'assets';
  const simulation = new URLSearchParams(location.search).get('demo') === 'simulation';
  const units = new URLSearchParams(location.search).get('demo') === 'units';
  let vision = $state(false);
  let flow = $state(false), paused = $state(false), frame = $state(0), digest = $state('');

  type Status = 'starting' | 'running' | 'unsupported' | 'nodata' | 'failed' | 'lost';

  let canvas = $state<HTMLCanvasElement>(null!);
  let status: Status = $state('starting');
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
      const started = await startGame(created, canvas, { simulation, units,
        onStats: (value, checksum) => { frame = value; digest = checksum; } });
      if (unmounted || renderer !== created) {
        started.dispose();
        return;
      }
      game = started;
      game.setFlow(flow);
      game.setVision(vision);
      game.setPaused(paused);
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
{/if}

{#if (simulation || units) && !preview && status === 'running'}
  <aside class="simulation-controls" aria-label="Simulation demo">
    <strong>{units ? 'Units and controls · 28 vehicles, 35 infantry' : 'GPU simulation · 320 tanks'}</strong>
    {#if units}
      <div>Click to capture the pointer. Left-click or drag to select, then left-click ground to move. Right-click clears the selection. Esc releases the pointer.</div>
    {:else}
      <div>Click the map to capture the pointer, then click open ground to move all tanks. Esc releases the pointer.</div>
    {/if}
    <div class="controls">
      <button type="button" aria-pressed={flow} onclick={() => { flow = !flow; game?.setFlow(flow); }}>Flow field</button>
      {#if units}<button type="button" aria-pressed={vision} onclick={() => { vision = !vision; game?.setVision(vision); }}>Sight</button>{/if}
      <button type="button" aria-pressed={paused} onclick={() => { paused = !paused; game?.setPaused(paused); }}>{paused ? 'Resume' : 'Pause'}</button>
      <a href={units ? '?demo=units' : '?demo=simulation'}>Reset</a>
      <a href="?">Original map</a>
    </div>
    <div>Tick <span data-tick={frame}>{frame}</span> · 15 ticks/s · pauses in the background</div>
    {#if digest}<code title="Asynchronous simulation checksum">{digest}</code>{/if}
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
