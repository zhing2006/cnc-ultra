<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Loading from './Loading.svelte';
  import { createRenderer, type Renderer } from './engine/renderer.ts';
  import { loadData } from './game/data-files.ts';
  import { collectMapSamples } from './game/map-generator/samples.ts';
  import { ultraScene } from './game/ultra-scene.ts';
  import { UltraRuntime } from './game/ultra-runtime.ts';
  import { startPreparedGame, type Game } from './game/game.ts';

  const query = new URLSearchParams(location.search);
  const seed = Number(query.get('seed') ?? 1995) >>> 0;
  const sizes = ['384x256', '512x256', '640x320'];
  const dimensions = sizes.includes(query.get('size') ?? '') ? query.get('size')! : '512x256';
  const [width, height] = dimensions.split('x').map(Number);
  let canvas: HTMLCanvasElement;
  let renderer: Renderer | null = null, game: Game | null = null, disposed = false;
  let ready = $state(false), error = $state(''), loading = $state('Checking graphics support');
  let speed = $state<1 | 10>(1), zoom = $state(1), frame = $state(0), actualSpeed = $state(0);
  let outcome = $state<number | undefined>(undefined);
  let forces = $state<[number, number]>([10000, 10000]);

  async function progress(message: string) {
    loading = message; await tick();
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }
  function play(value: 1 | 10) { speed = value; game?.setSimulationSpeed(value); }
  async function start() {
    try {
      renderer = await createRenderer(canvas, { onDeviceLost(message) {
        ready = false; error = `WebGPU device lost: ${message}`; game?.dispose(); game = null;
      } });
      if (!renderer) throw new Error('This browser does not support WebGPU. Use a recent Chrome or Edge.');
      await progress('Loading original game files');
      const mix = await loadData(false, true, true);
      await progress('Generating the battlefield and deploying 20,000 units');
      const world = ultraScene(mix, collectMapSamples(mix), { seed, width, height });
      await progress('Preparing combat');
      const started = await startPreparedGame(renderer, canvas, mix, { kind: 'combat', ...world, economy: world }, {
        createEconomy: battle => {
          const runtime = new UltraRuntime(battle, world); runtime.onForces = value => { forces = value; }; return runtime;
        }, startOverview: true, onProgress: progress,
        onStats(value) { frame = value; }, onSpeed(value) { actualSpeed = value; },
        onCamera(view) { zoom = view.scale; }, onOutcome(value) { outcome = value; },
      });
      if (disposed) { started.dispose(); return; }
      game = started; game.setPerspective('all'); game.setZoom('fit'); ready = true;
      const url = new URL(location.href); url.searchParams.set('seed', String(seed)); url.searchParams.set('size', dimensions);
      history.replaceState(null, '', url);
    } catch (reason) { if (!disposed) { console.error(reason); error = String(reason); } }
  }
  onMount(() => {
    void start();
    return () => { disposed = true; game?.dispose(); renderer?.dispose(); };
  });
</script>

<main>
  <header>
    <h1>Ultra</h1>
    <span class="gdi">GDI · {forces[0].toLocaleString('en-US')}</span><span class="nod">Nod · {forces[1].toLocaleString('en-US')}</span>
    <div class="controls">
      <button disabled={!ready} aria-label="Zoom out" onclick={() => game?.zoom(-1)}>−</button>
      <button disabled={!ready} aria-label="Whole map" onclick={() => game?.setZoom('fit')}>Whole map</button>
      <button disabled={!ready} aria-label="Zoom in" onclick={() => game?.zoom(1)}>+</button>
      <span aria-label="Zoom">{zoom >= 1 ? `${zoom}×` : `1/${Math.round(1 / zoom)}×`}</span>
      <button disabled={!ready || outcome !== undefined} aria-pressed={speed === 1} onclick={() => play(1)}>1×</button>
      <button disabled={!ready || outcome !== undefined} aria-pressed={speed === 10} onclick={() => play(10)}>10×</button>
    </div>
  </header>
  <div class="viewport">
    <canvas bind:this={canvas} data-status={ready ? 'ultra' : 'starting'} tabindex="0" aria-label="Ultra battlefield"></canvas>
  </div>
  <footer>
    <span>Seed {seed} · {width} × {height}</span>
    <span>Click to control GDI · Esc releases the mouse · arrows scroll · wheel zooms</span>
    <span>{outcome === undefined ? `Tick ${frame} · ${actualSpeed.toFixed(1)}×` : outcome === 0 ? 'GDI victorious' : outcome === 1 ? 'Nod victorious' : 'Draw'}</span>
  </footer>
  {#if !ready && !error}<Loading message={loading} />{/if}
  {#if error}<div class="error" role="alert">{error}<button onclick={() => location.reload()}>Restart</button></div>{/if}
</main>

<style>
  main { position: fixed; inset: 0; display: flex; flex-direction: column; background: #0f151b; color: #e5edf4; font: 14px system-ui, sans-serif; }
  header { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; padding: 10px 16px; border-bottom: 1px solid #36444e; background: #19232c; }
  h1 { margin: 0; font-size: 18px; } .gdi { color: #e8cc58; } .nod { color: #ef7777; }
  .controls { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  button { font: inherit; color: inherit; background: #25333e; border: 1px solid #536b7d; border-radius: 4px; padding: 5px 10px; cursor: pointer; }
  button:disabled { opacity: .4; cursor: default; } button[aria-pressed='true'] { border-color: #9bd6ff; background: #2a4357; }
  .viewport { flex: 1; min-height: 0; overflow: hidden; } canvas { display: block; width: 100%; height: 100%; touch-action: none; }
  canvas:focus { outline: none; }
  footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 16px; padding: 7px 16px; font-size: 11px; color: #a5bac9; border-top: 1px solid #36444e; }
  .error { position: absolute; inset: 40% 10% auto; padding: 24px; background: #392a2a; color: #ffc0b8; } .error button { margin-left: 20px; }
</style>
