<script lang="ts">
  import { router } from '../router.svelte';
  import { content } from '../content.svelte';

  interface Props { id: string }
  const { id }: Props = $props();

  let rating = $state(0);
  const title = $derived(content.summary(id)?.title ?? '');

  function rate(n: number): void {
    rating = n;
    try {
      const key = 'hpyno.ratings';
      const all = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, number[]>;
      (all[id] ??= []).push(n);
      localStorage.setItem(key, JSON.stringify(all));
    } catch { /* ok */ }
  }
</script>

<section class="end">
  <div class="glass card fade-in">
    <p class="eyebrow">{title}</p>
    <h1>Welcome back.</h1>
    <p class="muted">Take a moment. Move your fingers. Breathe.</p>
    <p class="q">How deep did you go?</p>
    <div class="hearts" role="radiogroup" aria-label="How deep did you go">
      {#each [1, 2, 3, 4, 5] as n (n)}
        <button class="heart" class:on={n <= rating} role="radio" aria-checked={n === rating} aria-label="{n} of 5" onclick={() => rate(n)}>♥</button>
      {/each}
    </div>
    <div class="actions">
      <button class="btn btn-primary" onclick={() => router.go(`/play/${encodeURIComponent(id)}?mode=watch`)}>Again</button>
      <button class="btn" onclick={() => router.go('/', true)}>Library</button>
    </div>
  </div>
</section>

<style>
  .end { position: absolute; inset: 0; display: grid; place-items: center; padding: 1.25rem; }
  .card { width: min(400px, 100%); padding: 2rem 1.6rem; text-align: center; display: flex; flex-direction: column; gap: 0.5rem; align-items: center; }
  h1 { font-family: var(--font-display); font-weight: 400; font-size: 2.4rem; margin: 0.2rem 0 0; }
  .q { margin: 1rem 0 0.2rem; }
  .hearts { display: flex; gap: 0.25rem; }
  .heart { appearance: none; background: transparent; border: 0; color: var(--ash-dim); font-size: 1.8rem; width: var(--tap); height: var(--tap); cursor: pointer; transition: color var(--dur-fast), transform var(--dur-fast); }
  .heart.on { color: var(--blush); }
  .heart:hover { transform: scale(1.15); }
  .actions { display: flex; gap: 0.6rem; margin-top: 1.25rem; }
</style>
