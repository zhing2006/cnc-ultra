<script lang="ts">
  import { onMount } from 'svelte';
  import { createRenderer, type Renderer } from './engine/renderer.ts';

  type Status = 'starting' | 'running' | 'unsupported' | 'failed';

  let canvas: HTMLCanvasElement;
  let status: Status = $state('starting');

  onMount(() => {
    let renderer: Renderer | null = null;
    let unmounted = false;

    createRenderer(canvas).then(
      (created) => {
        if (unmounted) {
          created?.dispose();
          return;
        }
        renderer = created;
        status = created ? 'running' : 'unsupported';
      },
      (error: unknown) => {
        console.error(error);
        status = 'failed';
      },
    );

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
