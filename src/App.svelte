<script lang="ts">
  import { onMount } from 'svelte';
  import { createRenderer, DeviceLostError, type Renderer } from './engine/renderer.ts';

  type Status = 'starting' | 'running' | 'unsupported' | 'failed' | 'lost';

  let canvas: HTMLCanvasElement;
  let status: Status = $state('starting');
  let renderer: Renderer | null = null;
  let unmounted = false;

  function lost(message: string) {
    console.error(`WebGPU device lost: ${message}`);
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
      status = created ? 'running' : 'unsupported';
    } catch (error) {
      if (error instanceof DeviceLostError) {
        lost(error.message);
      } else {
        console.error(error);
        status = 'failed';
      }
    }
  }

  onMount(() => {
    start();
    return () => {
      unmounted = true;
      renderer?.dispose();
    };
  });
</script>

<canvas bind:this={canvas} data-status={status}></canvas>

{#if status === 'unsupported'}
  <p class="notice">This browser does not support WebGPU. Open the page in a recent Chrome or Edge.</p>
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
