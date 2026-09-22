<script lang="ts">
  import { settings } from '../settings.svelte';
  import { router } from '../router.svelte';
  import type { Engine } from '@engine/engine';
  import { clearProgress } from '@player/persistence';
  import { content } from '../content.svelte';

  interface Props { engine: Engine }
  const { engine }: Props = $props();

  const s = $derived(settings.value);
  $effect(() => { engine.forceQuality(s.quality === 'auto' ? null : s.quality); });
  $effect(() => { if (s.motion === 'reduced') engine.forceQuality('low'); });

  function num(e: Event): number { return Number((e.target as HTMLInputElement).value); }
  function chk(e: Event): boolean { return (e.target as HTMLInputElement).checked; }
</script>

<div class="scrim" role="presentation" onclick={() => router.closeSheet()}></div>
<aside class="glass sheet fade-in" aria-label="Settings">
  <header>
    <span class="eyebrow">settings</span>
    <button class="btn btn-ghost btn-icon" aria-label="Close" onclick={() => router.closeSheet()}>✕</button>
  </header>

  <label class="field"><span>voice</span><input class="slider" type="range" min="0" max="1" step="0.02" value={s.voiceVolume} oninput={(e) => settings.set('voiceVolume', num(e))} /></label>
  <label class="field"><span>ambience</span><input class="slider" type="range" min="0" max="1" step="0.02" value={s.bedVolume} oninput={(e) => settings.set('bedVolume', num(e))} /></label>
  <label class="field"><span>word size</span><input class="slider" type="range" min="0.7" max="1.6" step="0.05" value={s.textScale} oninput={(e) => settings.set('textScale', num(e))} /></label>

  <label class="toggle"><span>show words</span><input type="checkbox" checked={s.showText} onchange={(e) => settings.set('showText', chk(e))} /></label>
  <div class="field"><span>word display</span>
    <div class="seg">
      <button class="btn" class:btn-primary={s.textMode === 'word'} onclick={() => settings.set('textMode', 'word')}>one word</button>
      <button class="btn" class:btn-primary={s.textMode === 'line'} onclick={() => settings.set('textMode', 'line')}>line, lit as spoken</button>
    </div>
  </div>
  <label class="toggle"><span>haptics</span><input type="checkbox" checked={s.haptics} onchange={(e) => settings.set('haptics', chk(e))} /></label>
  <label class="toggle"><span>reduce flashes</span><input type="checkbox" checked={s.reduceFlash} onchange={(e) => settings.set('reduceFlash', chk(e))} /></label>
  <label class="toggle"><span>reduced motion</span><input type="checkbox" checked={s.motion === 'reduced'} onchange={(e) => settings.set('motion', chk(e) ? 'reduced' : 'full')} /></label>

  <div class="field"><span>visual quality</span>
    <div class="seg">
      {#each ['auto', 'high', 'medium', 'low'] as q (q)}
        <button class="btn" class:btn-primary={s.quality === q} onclick={() => settings.set('quality', q as typeof s.quality)}>{q}</button>
      {/each}
    </div>
  </div>

  <div class="danger">
    <button class="btn btn-ghost" onclick={() => { clearProgress(); content.refreshProgress(); }}>forget saved progress</button>
    <button class="btn btn-ghost" onclick={() => { settings.reset(); router.closeSheet(); router.go('/gate', true); }}>reset everything</button>
  </div>
</aside>

<style>
  .scrim { position: absolute; inset: 0; background: rgba(7,4,10,0.35); }
  .sheet { position: absolute; right: 0; top: 0; bottom: 0; width: min(380px, 100%); padding: max(0.75rem, var(--safe-top)) 1rem max(1rem, var(--safe-bottom)); overflow-y: auto;
    border-radius: 0; border-top: 0; border-bottom: 0; border-right: 0; display: flex; flex-direction: column; gap: 0.35rem; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .field { display: flex; flex-direction: column; gap: 0.1rem; }
  .field > span, .toggle > span { font-size: 0.85rem; }
  .toggle { display: flex; justify-content: space-between; align-items: center; min-height: var(--tap); }
  .toggle input { width: 22px; height: 22px; accent-color: var(--blush); }
  .seg { display: flex; gap: 0.35rem; flex-wrap: wrap; }
  .seg .btn { min-height: 36px; padding: 0 0.8rem; font-size: 0.8rem; }
  .danger { margin-top: auto; display: flex; flex-direction: column; align-items: flex-start; padding-top: 1rem; }
</style>
