<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { createRenderer, DeviceLostError, type Renderer } from './engine/renderer.ts';
  import { MissingDataError } from './game/data-files.ts';
  import { startGame, type Game } from './game/game.ts';
  import Preview from './demo/Preview.svelte';
  import DebugPanel from './demo/DebugPanel.svelte';
  import { demoConfig, startDemo, type DemoGame, type DemoConfig } from './demo/game.ts';
  import Loading from './Loading.svelte';
  import DebugMenu from './game/DebugMenu.svelte';

  const preview = new URLSearchParams(location.search).get('preview') === 'assets';
  let demo = $state.raw(demoConfig(location.search));
  let outcome = $state<number | undefined>(undefined);
  let demoGame = $state.raw<DemoGame | null>(null);
  let frame = $state(0), digest = $state(''), actualSpeed = $state(0);

  type Status = 'starting' | 'running' | 'unsupported' | 'nodata' | 'failed' | 'lost';

  let canvas = $state<HTMLCanvasElement>(null!);
  let status: Status = $state('starting');
  let loadingMessage = $state('Checking graphics support');
  let renderer: Renderer | null = null;
  let game = $state.raw<Game | null>(null);
  let unmounted = false;

  function stopGame() {
    game?.dispose();
    game = null;
    demoGame = null;
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
      const created = renderer ?? await createRenderer(canvas, { onDeviceLost: lost });
      if (unmounted) {
        created?.dispose();
        return;
      }
      renderer = created;
      if (!created) {
        status = 'unsupported';
        return;
      }
      const callbacks = {
        onProgress: showProgress,
        onStats: (value: number, checksum: string) => { frame = value; digest = checksum; },
        onSpeed: (actual: number) => { actualSpeed = actual; },
        onOutcome: (winner: number) => { outcome = winner; },
      };
      const startedDemo = demo ? await startDemo(created, canvas, demo, callbacks) : null;
      const started = startedDemo ?? await startGame(created, canvas, callbacks);
      if (unmounted || renderer !== created) {
        started.dispose();
        return;
      }
      game = started;
      demoGame = startedDemo;
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

  async function restartDemo(config: DemoConfig) {
    stopGame(); demo = config; frame = 0; digest = ''; actualSpeed = 0; outcome = undefined;
    await start();
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

{#if demo && demoGame && !preview && status === 'running'}
  <DebugPanel config={demo} game={demoGame} {frame} {digest} {actualSpeed} {outcome} onRestart={restartDemo} />
{/if}
<DebugMenu game={status === 'running' ? game : undefined} />

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
