<script lang="ts">
  let { message = 'Starting the game' }: { message?: string } = $props();
</script>

<div class="loading" role="status" aria-live="polite" aria-busy="true">
  <div class="card">
    <div class="brand">C&amp;C ULTRA</div>
    <h1>Loading</h1>
    <p data-loading-stage>{message}</p>
    <div class="track" aria-hidden="true"><span></span></div>
    <div class="hint">The battlefield will appear when it is ready.</div>
  </div>
</div>

<style>
  .loading { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; background: #0b1118; color: #e4eaf0; }
  .card { width: min(340px, calc(100vw - 64px)); }
  .brand { color: #e4be69; font-size: 12px; letter-spacing: 0.22em; }
  h1 { font-size: 30px; font-weight: 500; margin: 16px 0 10px; }
  p { min-height: 1.5em; color: #c5d2de; font-size: 14px; margin: 0 0 24px; }
  .track { height: 3px; background: #283542; overflow: hidden; }
  .track span { display: block; height: 100%; width: 40%; background: #e4be69; animation: progress 1.5s ease-in-out infinite alternate; }
  .hint { color: #8594a3; font-size: 12px; margin-top: 16px; }
  @keyframes progress { from { transform: translateX(-100%); } to { transform: translateX(350%); } }
  @media (prefers-reduced-motion: reduce) { .track span { animation: none; width: 100%; opacity: 0.6; } }
</style>
