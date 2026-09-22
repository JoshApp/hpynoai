<script lang="ts">
  import { settings } from '../settings.svelte';
  import { router } from '../router.svelte';

  function enter(): void {
    settings.set('ageConfirmed', true);
    router.go('/', true);
  }
  function leave(): void { location.href = 'https://www.google.com'; }
</script>

<section class="gate">
  <div class="glass card fade-in">
    <p class="wordmark">HPYNO</p>
    <h1>An adult hypnosis experience.</h1>
    <p class="body">Erotic themes. Guided trance. Slow, flowing visuals that some photosensitive viewers may find uncomfortable.</p>
    <p class="body muted">Use headphones. Do not listen while driving or doing anything that needs your attention. You can stop at any time.</p>
    <div class="actions">
      <button class="btn btn-primary" onclick={enter}>I am 18 or older — enter</button>
      <button class="btn btn-ghost" onclick={leave}>Leave</button>
    </div>
  </div>
</section>

<style>
  .gate { position: absolute; inset: 0; display: grid; place-items: center; padding: max(1.25rem, var(--safe-top)) 1.25rem max(1.25rem, var(--safe-bottom)); }
  .card { width: min(440px, 100%); padding: 2rem 1.75rem; text-align: center; }
  .wordmark { margin: 0 0 1.25rem; font-size: 1.1rem; color: var(--ash); }
  h1 { font-family: var(--font-display); font-weight: 400; font-size: 1.9rem; line-height: 1.15; margin: 0 0 1rem; }
  .body { font-size: 0.92rem; line-height: 1.55; margin: 0 0 0.75rem; }
  .actions { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1.5rem; }
</style>
