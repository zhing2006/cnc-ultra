<script lang="ts">
  import { onMount } from 'svelte';
  import { createRenderer, DeviceLostError, type Renderer } from './engine/renderer.ts';
  import { MissingDataError } from './game/data-files.ts';
  import { startGame, type Game } from './game/game.ts';
  import Preview from './Preview.svelte';

  const preview = new URLSearchParams(location.search).get('preview') === 'assets';

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
      const started = await startGame(created, canvas);
      if (unmounted || renderer !== created) {
        started.dispose();
        return;
      }
      game = started;
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
