<script lang="ts">
  import { onMount } from 'svelte';
  import { createRenderer, type Renderer } from './engine/renderer.ts';
  import { PalettePipeline } from './engine/indexed/pipeline.ts';
  import { loadData } from './game/data-files.ts';
  import type { MixSet } from './game/formats/mix.ts';
  import { CLOAK_STAGES, type CloakStage } from './game/cloak.ts';
  import { buildPreview, type PreviewSettings } from './game/preview.ts';
  import { PaletteCycle } from './game/palette-cycle.ts';

  let canvas: HTMLCanvasElement;
  let renderer = $state.raw<Renderer | null>(null);
  let mix = $state.raw<MixSet | null>(null);
  let error = $state('');
  let group = $state<PreviewSettings['group']>('units');
  let theater = $state<PreviewSettings['theater']>('TEMPERATE');
  let house = $state('GoodGuy');
  let facing = $state(0);
  let buildingState = $state<PreviewSettings['buildingState']>('intact');
  let cloak = $state<CloakStage>('normal');
  let zoom = $state(2);
  const ratio = window.devicePixelRatio;
  let width = $state(720), height = $state(120), stride = $state(120);
  let entries = $state<{ name: string; x: number; y: number }[]>([]);
  let ready = $state(false);

  onMount(() => {
    let disposed = false;
    let owned: Renderer | null = null;
    (async () => {
      const created = await createRenderer(canvas, { onDeviceLost: message => { error = `WebGPU device lost: ${message}`; renderer = null; } });
      owned = created;
      if (disposed) { created?.dispose(); return; }
      if (!created) { error = 'This preview requires WebGPU.'; return; }
      const data = await loadData(true);
      if (disposed) { created.dispose(); return; }
      renderer = created;
      mix = data;
    })().catch(reason => { owned?.dispose(); error = String(reason); });
    return () => { disposed = true; owned?.dispose(); };
  });

  $effect(() => {
    const active = renderer;
    if (!active || !mix) return;
    const settings = { group, theater, house, facing, buildingState, cloak };
    let pipeline: PalettePipeline | undefined;
    try {
      const gallery = buildPreview(mix, settings);
      ({ width, height, stride, entries } = gallery);
      pipeline = new PalettePipeline(active.three, { ...gallery.scene.setup, spriteCapacity: gallery.scene.sprites.length });
      pipeline.setSprites(gallery.scene.sprites);
      const palette = new PaletteCycle(gallery.scene.setup.palette);
      const scale = zoom;
      let start = -1;
      active.setFrame((_width, _height, time) => {
        if (start < 0) start = time;
        if (palette.update(time - start)) pipeline!.setPalette(palette.colors);
        pipeline!.setTime(time - start);
        pipeline!.render({ x: 0, y: 0, width: gallery.width, height: gallery.height }, scale);
      });
      ready = true;
      error = '';
    } catch (reason) {
      error = String(reason);
      ready = false;
    }
    return () => { active.setFrame(null); pipeline?.dispose(); };
  });
</script>

<main>
  <header>
    <a href="./">Back to mission</a>
    <strong>Original asset preview</strong>
    <span>{entries.length} items</span>
    <div class="controls">
      <label>Category <select aria-label="Category" bind:value={group}>
        <option value="units">Units</option><option value="buildings">Buildings</option>
        <option value="terrain">Terrain objects</option><option value="cloak">Cloaking and overlap</option>
      </select></label>
      <label>Theater <select aria-label="Theater" bind:value={theater}>
        <option value="TEMPERATE">Temperate</option><option value="DESERT">Desert</option>
      </select></label>
      <label>House <select aria-label="House" bind:value={house} disabled={group === 'terrain'}>
        <option value="GoodGuy">GDI</option><option value="BadGuy">Nod</option><option value="Neutral">Neutral</option>
        <option value="Multi1">Blue green</option><option value="Multi2">Orange</option><option value="Multi3">Green</option>
        <option value="Multi4">Blue</option><option value="Multi5">Yellow</option><option value="Multi6">Red</option>
      </select></label>
      <label>Facing <select aria-label="Facing" bind:value={facing} disabled={group === 'terrain'}>
        {#each ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as direction, i}<option value={i * 32}>{direction}</option>{/each}
      </select></label>
      <label>Building state <select aria-label="Building state" bind:value={buildingState} disabled={group !== 'buildings'}>
        <option value="intact">Intact</option><option value="damaged">Damaged</option><option value="ruined">Ruined</option>
      </select></label>
      <label>Stealth tank <select aria-label="Stealth tank" bind:value={cloak} disabled={group !== 'units'}>
        {#each CLOAK_STAGES as stage}<option value={stage}>{stage}</option>{/each}
      </select></label>
      <label>Scale <select aria-label="Scale" bind:value={zoom}>
        {#each [1, 2, 3, 4] as scale}<option value={scale}>{scale}×</option>{/each}
      </select></label>
    </div>
    <p>Nod uses blue grey for units and red for buildings. Switch theater to see its native buildings and trees.</p>
    {#if error}<p role="alert">{error} <button onclick={() => location.reload()}>Restart</button></p>{/if}
  </header>
  <div class="scroll">
    <div class="gallery" style:--gallery-width="{width * zoom / ratio}px"
      style:--screen-pixel="{1 / ratio}px" style:height="{height * zoom / ratio}px">
      <canvas bind:this={canvas} data-status={ready ? 'preview' : 'starting'}></canvas>
      {#each entries as entry}
        <div class="cell" data-asset-name={entry.name}
          style:left="{entry.x * zoom / ratio}px" style:top="{entry.y * zoom / ratio}px"
          style:width="{stride * zoom / ratio}px" style:height="{stride * zoom / ratio}px">
          <span>{entry.name}</span>
        </div>
      {/each}
    </div>
  </div>
</main>

<style>
  main { position: fixed; inset: 0; display: flex; flex-direction: column; background: #14191f; color: #edf1f6; }
  header { padding: 12px 20px; border-bottom: 1px solid #495562; }
  header > * { margin-right: 18px; }
  a { color: #9bd6ff; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px 18px; margin-top: 12px; }
  label { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  select, button { font: inherit; color: inherit; background: #26313d; padding: 4px; border: 1px solid #64778a; border-radius: 3px; }
  p { font-size: 13px; margin: 10px 0 0; color: #bcc9d6; }
  [role='alert'] { color: #ffb4a9; }
  .scroll { overflow: auto; flex: 1; padding: 16px; }
  .gallery {
    position: relative;
    width: var(--gallery-width);
    /* Keep the canvas on physical pixels, and keep its left edge reachable when it overflows. */
    margin-inline: max(0px, round(down, (100% - var(--gallery-width)) / 2, var(--screen-pixel))) auto;
  }
  canvas { display: block; width: 100%; height: 100%; }
  .cell { position: absolute; pointer-events: none; box-sizing: border-box; border: 1px solid #ffffff29; }
  .cell span { display: inline-block; margin: 5px; background: #14191fe6; padding: 2px 6px; font-size: 12px; }
</style>
