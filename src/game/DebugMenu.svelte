<script lang="ts">
  import { onMount } from 'svelte';
  import type { Game } from './game.ts';
  import { DEBUG_SPEEDS, DAMAGE_SCALE, MAX_DEBUG_MONEY, type DebugSpeed } from './debug.ts';

  let { game }: { game?: Game | null } = $props();
  let dialog: HTMLDialogElement;
  let active = $state.raw<Game | undefined>();
  let wasPaused = false, generation = 0;
  let loading = $state(false), error = $state('');
  let money = $state<number | undefined>(0);
  let buildSpeed = $state<DebugSpeed>(1), gameSpeed = $state<DebugSpeed>(1), damage = $state(1);

  async function open() {
    if (!game?.canDebug()) return;
    const current = game, request = ++generation;
    wasPaused = current.isPaused(); active = current; loading = true; error = '';
    current.setPaused(true);
    if (document.pointerLockElement) void document.exitPointerLock();
    dialog.showModal();
    try {
      const value = await current.readDebugState();
      if (request !== generation) return;
      money = value.money; buildSpeed = value.buildSpeed; gameSpeed = value.gameSpeed; damage = value.damageScale / DAMAGE_SCALE;
    } catch (reason) {
      if (request === generation) error = reason instanceof Error ? reason.message : String(reason);
    } finally { if (request === generation) loading = false; }
  }
  function close(apply: boolean) {
    if (!active) return;
    if (apply) {
      if (loading || error || !dialog.querySelector('form')!.reportValidity()) return;
      try {
        active.applyDebugState({ money: money!, buildSpeed, gameSpeed, damageScale: Math.round(damage * DAMAGE_SCALE) });
      } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); return; }
    }
    const current = active; active = undefined; generation++; dialog.close();
    current.setPaused(wasPaused);
  }
  $effect(() => {
    if (active && active !== game) { active = undefined; generation++; dialog.close(); }
  });
  onMount(() => {
    const key = (event: KeyboardEvent) => {
      if (event.code === 'Backquote' || event.key === '~') {
        if (!active && !game?.canDebug()) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) { if (active) close(true); else void open(); }
      } else if (active) {
        // Keep game shortcuts out of the dialog; native input editing and Tab still work.
        event.stopImmediatePropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(false); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { generation++; window.removeEventListener('keydown', key, true); };
  });
</script>

<dialog bind:this={dialog} aria-labelledby="debug-title" oncancel={event => { event.preventDefault(); close(false); }}>
  <form onsubmit={event => { event.preventDefault(); close(true); }}>
    <div class="heading"><h1 id="debug-title">Debug</h1><span>Game paused</span></div>
    {#if loading}<p role="status">Reading mission state…</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <fieldset disabled={loading || !!error}>
      <label>Player money<input aria-label="Player money" type="number" min="0" max={MAX_DEBUG_MONEY} step="1" required bind:value={money} /></label>
      <label>Player build speed<select aria-label="Player build speed" bind:value={buildSpeed}>{#each DEBUG_SPEEDS as speed}<option value={speed}>{speed}X</option>{/each}</select></label>
      <label>Game speed<select aria-label="Game speed" bind:value={gameSpeed}>{#each DEBUG_SPEEDS as speed}<option value={speed}>{speed}X</option>{/each}</select></label>
      <label class="damage">Player damage received <output>{damage.toFixed(2)}</output>
        <input aria-label="Player damage received" type="range" min="0" max="1" step="0.01" bind:value={damage} />
      </label>
    </fieldset>
    <p class="hint">Game speed multiplies Game Controls; 1X keeps its speed.</p>
    <p class="hint">~ applies and closes · Esc cancels</p>
    <div class="actions"><button type="button" onclick={() => close(false)}>Cancel</button><button class="apply" type="submit" disabled={loading || !!error}>Apply &amp; close</button></div>
  </form>
</dialog>

<style>
  dialog { width: min(380px, calc(100vw - 48px)); padding: 24px; border: 1px solid #52657a; border-radius: 12px; color: #e8eff6; background: #14202e; box-shadow: 0 16px 70px #000a; font: 14px system-ui, sans-serif; }
  dialog::backdrop { background: #040b146e; }
  .heading, .actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  h1 { font-size: 22px; margin: 0; }
  .heading span, .hint { color: #a4b6c9; font-size: 12px; }
  fieldset { border: 0; margin: 24px 0; padding: 0; display: grid; gap: 18px; }
  label { display: grid; grid-template-columns: 1fr 130px; align-items: center; gap: 8px; }
  input, select, button { box-sizing: border-box; font: inherit; color: inherit; border: 1px solid #52657a; border-radius: 5px; background: #0c1622; padding: 8px 10px; min-width: 0; }
  input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid #79baff; outline-offset: 2px; }
  .damage { grid-template-columns: 1fr auto; }
  output { font-variant-numeric: tabular-nums; }
  input[type="range"] { grid-column: 1 / -1; width: 100%; margin: 0; padding: 0; accent-color: #79baff; }
  .actions { justify-content: flex-end; margin-top: 18px; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .apply { background: #2d648d; }
  [role="alert"] { color: #ffb7ad; }
</style>
