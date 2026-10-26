<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Loading from './Loading.svelte';
  import { createRenderer, finishGpuSetup, type Renderer } from './engine/renderer.ts';
  import { PalettePipeline } from './engine/indexed/pipeline.ts';
  import { loadData } from './game/data-files.ts';
  import type { MixSet } from './game/formats/mix.ts';
  import { buildScene } from './game/scene.ts';
  import { PaletteCycle } from './game/palette-cycle.ts';
  import { CELL_LEPTONS } from './game/coord.ts';
  import { collectMapSamples, type MapSamples } from './game/map-generator/samples.ts';
  import { generateMap, invalidMapEdges, type GeneratedMap, type MapRectangle } from './game/map-generator/generator.ts';

  const query = new URLSearchParams(location.search);
  const zooms = ['fit', '1/8', '1/4', '1/2', '1', '2', '3'];
  let canvas: HTMLCanvasElement;
  let seed = $state(Number(query.get('seed') ?? 1995) >>> 0);
  const sizes = ['384x256', '512x256', '640x320'];
  let dimensions = $state(sizes.includes(query.get('size') ?? '') ? query.get('size')! : '512x256');
  let zoom = $state('fit'), zones = $state(true);
  let generated = $state.raw<GeneratedMap | null>(null);
  let ready = $state(false), error = $state(''), loadingMessage = $state('Checking graphics support');
  let camera = $state({ x: 0, y: 0, factor: 1 });
  let centerX = 0, centerY = 0, deviceWidth = 1, deviceHeight = 1;
  let renderer: Renderer | null = null, pipeline: PalettePipeline | null = null, palette: PaletteCycle | null = null;
  let mix: MixSet | null = null, samples: MapSamples | null = null;
  let disposed = false, version = 0, firstFrame = false;
  let drag: { x: number; y: number; centerX: number; centerY: number } | null = null;

  function sampling(value = zoom) {
    const map = generated?.scenario;
    const step = value === 'fit' ? Math.max(1, Math.ceil(Math.max((map?.width ?? 512) * 24 / deviceWidth, (map?.height ?? 256) * 24 / deviceHeight)))
      : value.startsWith('1/') ? Number(value.slice(2)) : 1;
    return { step, scale: value === 'fit' || value.includes('/') ? 1 : Number(value) };
  }

  function overview() {
    zoom = 'fit';
    if (generated) { centerX = generated.scenario.width * 12; centerY = generated.scenario.height * 12; }
  }

  async function rebuild() {
    if (!renderer || !mix || !samples || disposed) return;
    const request = ++version;
    ready = false; error = ''; loadingMessage = 'Generating terrain from original map samples';
    await tick();
    try {
      const [width, height] = dimensions.split('x').map(Number);
      const next = generateMap(samples, { seed, width, height });
      const invalid = invalidMapEdges(samples, next.scenario);
      if (invalid.length) throw new Error(`The generated map has ${invalid.length} unobserved tile joins.`);
      const scene = buildScene(mix, next.scenario);
      pipeline?.dispose(); pipeline = null;
      pipeline = new PalettePipeline(renderer.three, { ...scene.setup, spriteCapacity: scene.sprites.length });
      pipeline.setSprites(scene.sprites);
      palette = new PaletteCycle(scene.setup.palette);
      generated = next; overview(); firstFrame = true;
      const url = new URL(location.href); url.searchParams.set('seed', String(next.seed)); url.searchParams.set('size', dimensions);
      history.replaceState(null, '', url);
      loadingMessage = 'Preparing the Ultra map';
    } catch (reason) {
      if (request === version) error = String(reason);
    }
  }

  function changeZoom(value: string, mouseX = deviceWidth / 2, mouseY = deviceHeight / 2) {
    const before = sampling();
    const worldX = camera.x + mouseX * before.step / before.scale;
    const worldY = camera.y + mouseY * before.step / before.scale;
    zoom = value;
    const after = sampling();
    centerX = worldX - (mouseX - deviceWidth / 2) * after.step / after.scale;
    centerY = worldY - (mouseY - deviceHeight / 2) * after.step / after.scale;
    if (value === 'fit') overview();
  }

  function wheel(event: WheelEvent) {
    event.preventDefault();
    const current = sampling(), magnification = current.scale / current.step;
    // Whole-map magnification depends on the viewport and DPR; it is not always below 1:8.
    const levels = zooms.map(value => { const sample = sampling(value); return { value, factor: sample.scale / sample.step }; })
      .sort((a, b) => a.factor - b.factor);
    const next = event.deltaY < 0 ? levels.find(level => level.factor > magnification)
      : levels.reverse().find(level => level.factor < magnification);
    if (!next) return;
    const rect = canvas.getBoundingClientRect();
    changeZoom(next.value, (event.clientX - rect.left) * window.devicePixelRatio, (event.clientY - rect.top) * window.devicePixelRatio);
  }

  function pointerDown(event: PointerEvent) {
    canvas.focus(); canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, centerX, centerY };
  }
  function pointerMove(event: PointerEvent) {
    if (!drag) return;
    const { step, scale } = sampling(), factor = window.devicePixelRatio * step / scale;
    centerX = drag.centerX - (event.clientX - drag.x) * factor;
    centerY = drag.centerY - (event.clientY - drag.y) * factor;
  }
  function keyDown(event: KeyboardEvent) {
    const amount = 192 * sampling().step;
    if (event.key === 'ArrowLeft') centerX -= amount;
    else if (event.key === 'ArrowRight') centerX += amount;
    else if (event.key === 'ArrowUp') centerY -= amount;
    else if (event.key === 'ArrowDown') centerY += amount;
    else if (event.key === 'Home') overview();
    else return;
    event.preventDefault();
  }
  function jump(coast: boolean) {
    if (!generated) return;
    const x = Math.trunc(generated.scenario.width / 2);
    const cliff = generated.cliffs[Math.trunc(generated.cliffs.length / 2)].bounds;
    centerX = (coast ? x : cliff.x + Math.trunc(cliff.width / 2)) * 24;
    centerY = (coast ? generated.shoreline[x] : cliff.y + Math.trunc(cliff.height / 2)) * 24;
    zoom = '1';
  }
  function screenRect(rect: MapRectangle) {
    return { x: (rect.x * 24 - camera.x) * camera.factor, y: (rect.y * 24 - camera.y) * camera.factor,
      width: rect.width * 24 * camera.factor, height: rect.height * 24 * camera.factor };
  }

  onMount(() => {
    (async () => {
      const created = await createRenderer(canvas, { onDeviceLost: message => {
        error = `WebGPU device lost: ${message}`; ready = false; renderer = null;
      } });
      if (disposed) { created?.dispose(); return; }
      if (!created) { error = 'Ultra requires WebGPU.'; return; }
      renderer = created;
      loadingMessage = 'Loading original temperate maps and graphics';
      mix = await loadData();
      if (disposed) return;
      samples = collectMapSamples(mix);
      created.setFrame((width, height, time) => {
        if (!pipeline || !generated || error) return;
        deviceWidth = width; deviceHeight = height;
        const { step, scale } = sampling(), viewWidth = Math.max(1, Math.ceil(width / scale)), viewHeight = Math.max(1, Math.ceil(height / scale));
        const worldWidth = generated.scenario.width * 24, worldHeight = generated.scenario.height * 24;
        const halfWidth = viewWidth * step / 2, halfHeight = viewHeight * step / 2;
        centerX = halfWidth * 2 >= worldWidth ? worldWidth / 2 : Math.max(halfWidth, Math.min(worldWidth - halfWidth, centerX));
        centerY = halfHeight * 2 >= worldHeight ? worldHeight / 2 : Math.max(halfHeight, Math.min(worldHeight - halfHeight, centerY));
        const x = Math.floor(centerX - halfWidth), y = Math.floor(centerY - halfHeight), factor = scale / step / window.devicePixelRatio;
        if (camera.x !== x || camera.y !== y || camera.factor !== factor) camera = { x, y, factor };
        if (palette?.update(time)) pipeline.setPalette(palette.colors);
        pipeline.render({ x, y, width: viewWidth, height: viewHeight }, scale, step);
        if (firstFrame) {
          firstFrame = false; const request = version;
          void finishGpuSetup(created.three).then(() => { if (!disposed && request === version) ready = true; },
            reason => { if (!disposed) error = String(reason); });
        }
      });
      await rebuild();
    })().catch(reason => { if (!disposed) error = String(reason); });
    return () => { disposed = true; version++; renderer?.setFrame(null); pipeline?.dispose(); renderer?.dispose(); };
  });
</script>

<main>
  <header>
    <div class="title"><a href="./">Back</a><h1>Ultra</h1></div>
    <div class="controls">
      <form onsubmit={(event) => { event.preventDefault(); void rebuild(); }}>
        <label>Seed <input aria-label="Seed" type="number" min="0" max="4294967295" step="1" required bind:value={seed} /></label>
        <label>Size <select aria-label="Map size" bind:value={dimensions}>
          <option value="384x256">384 × 256</option><option value="512x256">512 × 256</option><option value="640x320">640 × 320</option>
        </select></label>
        <button disabled={!ready} type="submit">Generate</button>
        <button disabled={!ready} type="button" onclick={() => { seed = (seed + 1) >>> 0; void rebuild(); }}>Next seed</button>
      </form>
      <label>View <select aria-label="Zoom" value={zoom} onchange={(event) => changeZoom(event.currentTarget.value)}>
        <option value="fit">Whole map</option><option value="1/8">1:8</option><option value="1/4">1:4</option>
        <option value="1/2">1:2</option><option value="1">1× original pixels</option><option value="2">2×</option><option value="3">3×</option>
      </select></label>
      <button onclick={overview}>Overview</button><button onclick={() => jump(true)}>Coast</button><button onclick={() => jump(false)}>Northern terrain</button>
      <button aria-pressed={zones} onclick={() => zones = !zones}>Layout guides</button>
    </div>
    <p>West / east deployment · coastal flank within gunboat range · drag to pan, scroll to zoom · arrow keys to move, Home for overview</p>
  </header>
  <div class="viewport">
    <canvas bind:this={canvas} data-status={ready ? 'ultra' : 'starting'} tabindex="0" aria-label="Generated temperate map"
      onwheel={wheel} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={() => drag = null}
      onpointercancel={() => drag = null} onkeydown={keyDown}></canvas>
    {#if generated && zones}
      <div class="zones" aria-hidden="true">
        {#each [...generated.deployments, ...generated.support] as rect, i}
          {@const projected = screenRect(rect)}
          <div class:west={i === 0} class:east={i === 1} class:support={i > 1} class="zone"
            style:left="{projected.x}px" style:top="{projected.y}px" style:width="{projected.width}px" style:height="{projected.height}px">
            <span>{i === 0 ? 'WEST' : i === 1 ? 'EAST' : 'SUPPORT'}{i < 2 ? ` · ${generated.deploymentCapacity[i]} vehicle cells` : ''}</span>
          </div>
        {/each}
        {#each [generated.navalSupport.front, generated.navalSupport.patrol] as rect, i}
          {@const projected = screenRect(rect)}
          <div class="zone" class:coastal-front={i === 0} class:patrol={i === 1}
            style:left="{projected.x}px" style:top="{projected.y}px" style:width="{projected.width}px" style:height="{projected.height}px">
            <span>{i === 0 ? 'COASTAL FRONT' : `GUNBOAT PATROL · ${generated.navalSupport.range / CELL_LEPTONS}-cell weapon range`}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
  <footer>
    {#if generated}<span>Seed {generated.seed} · {generated.scenario.width} × {generated.scenario.height} · {generated.sampleCount} original map samples</span>{/if}
    <span>Terrain only. Vehicle cells exclude support and mineral reserves. Battle performance not yet validated.</span>
  </footer>
  {#if !ready && !error}<Loading message={loadingMessage} />{/if}
  {#if error}<div class="error" role="alert">{error}<button onclick={() => location.reload()}>Restart Ultra</button></div>{/if}
</main>

<style>
  main { position: fixed; inset: 0; display: flex; flex-direction: column; background: #0f151b; color: #e5edf4; font: 14px system-ui, sans-serif; }
  header { padding: 14px 20px 10px; border-bottom: 1px solid #36444e; background: #19232c; }
  .title, .controls, form, label { display: flex; align-items: center; gap: 10px; }
  .title { gap: 18px; margin-bottom: 12px; } h1 { margin: 0; font-size: 18px; font-weight: 600; }
  a { color: #9bd6ff; }
  .controls { flex-wrap: wrap; gap: 8px 16px; } form { flex-wrap: wrap; }
  input, select, button { font: inherit; color: inherit; background: #25333e; border: 1px solid #536b7d; border-radius: 4px; padding: 5px 9px; }
  input { width: 110px; } button { cursor: pointer; } button:disabled { opacity: .4; cursor: default; }
  button[aria-pressed='true'] { border-color: #9bd6ff; background: #2a4357; }
  p { color: #a5bac9; font-size: 12px; margin: 9px 0 0; }
  .viewport { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
  canvas:active { cursor: grabbing; } canvas:focus { outline: none; } canvas:focus-visible { outline: 2px solid #9bd6ff; outline-offset: -2px; }
  .zones { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .zone { position: absolute; border: 1px dashed; box-sizing: border-box; color: #e7c66e; }
  .zone.east { color: #ed9293; } .zone.support { color: #8bcbd6; }
  .zone span { position: absolute; left: 0; top: 0; padding: 3px 6px; font-size: 10px; white-space: nowrap; background: #10171bd9; }
  .zone.coastal-front { color: #92e6cc; background: #4eb98b26; }
  .zone.patrol { color: #95cfff; border-width: 1px 0 0; }
  .coastal-front span, .patrol span { left: 50%; transform: translateX(-50%); }
  .coastal-front span { top: auto; bottom: 100%; }
  footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 16px; padding: 8px 16px; font-size: 11px; color: #a5bac9; border-top: 1px solid #36444e; }
  .error { position: absolute; inset: 40% 10% auto; padding: 24px; background: #392a2a; color: #ffc0b8; }
  .error button { margin-left: 20px; }
</style>
