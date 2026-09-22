<script lang="ts">
  import { content } from '../content.svelte';
  import { router } from '../router.svelte';
  import { settings, haptic } from '../settings.svelte';
  import { handoff } from '../session.svelte';
  import { SessionDirector } from '../session-director';
  import { formatTime } from '@player/persistence';
  import type { Engine } from '@engine/engine';
  import type { LoadedPackage } from '@content/loader';

  interface Props { engine: Engine; selectedId?: string }
  const { engine, selectedId }: Props = $props();

  let index = $state(0);
  let loaded = $state<LoadedPackage | null>(null);
  let loadError = $state<string | null>(null);
  let dragX = $state(0);
  let dragging = $state(false);
  let dir = $state(1);

  const sessions = $derived(content.sessions);
  const current = $derived(sessions[index] ?? null);
  const saved = $derived(current && content.progress?.sessionId === current.id ? content.progress : null);
  const pkg = $derived(loaded && current && loaded.pkg.id === current.id ? loaded.pkg : null);
  const gates = $derived(pkg?.cues.filter(c => c.type === 'gate').length ?? 0);
  const breathing = $derived(pkg?.cues.some(c => c.type === 'breath') ?? false);

  $effect(() => { void content.init(); });

  // Deep link → selection
  $effect(() => {
    if (!selectedId || sessions.length === 0) return;
    const i = sessions.findIndex(s => s.id === selectedId);
    if (i >= 0) index = i;
  });

  // Load the selected package (for description + chips) and drive the portal
  $effect(() => {
    const s = current;
    if (!s) return;
    loadError = null;
    content.package(s.id).then(l => { if (l.pkg.id === s.id) loaded = l; }).catch(e => { loadError = e instanceof Error ? e.message : String(e); });
    if (s.themePreview) engine.world.tunnel.setPortal(s.themePreview.c1, s.themePreview.c2, 0.85);
    engine.world.wisp.pulse(1.2);
  });

  function select(i: number): void {
    if (sessions.length === 0) return;
    const next = (i + sessions.length) % sessions.length;
    dir = next > index || (index === sessions.length - 1 && next === 0) ? 1 : -1;
    index = next;
    haptic(6);
    router.go(`/s/${encodeURIComponent(sessions[next]!.id)}`, true);
  }

  function start(mode: 'watch' | 'listen', resume: boolean): void {
    if (!loaded || !current || loaded.pkg.id !== current.id) return;
    const s = settings.value;
    const director = new SessionDirector(engine, loaded, mode, {
      voiceVolume: s.voiceVolume, bedVolume: s.bedVolume, showText: s.showText, textMode: s.textMode, textLead: s.textLead, textScale: s.textScale, reduceFlash: s.reduceFlash, haptic,
    });
    void director.start(resume && saved ? saved.position : 0);
    handoff.pending = director;
    engine.world.tunnel.setPortal([0, 0, 0], [0, 0, 0], 0);
    router.go(`/play/${encodeURIComponent(current.id)}?mode=${mode}`, true);
  }

  // Swipe
  let startX = 0;
  function down(e: PointerEvent): void { if ((e.target as HTMLElement).closest('button')) return; dragging = true; startX = e.clientX; dragX = 0; }
  function move(e: PointerEvent): void { if (dragging) dragX = e.clientX - startX; }
  function up(): void {
    if (!dragging) return;
    dragging = false;
    if (dragX < -60) select(index + 1); else if (dragX > 60) select(index - 1);
    dragX = 0;
  }
  function keys(e: KeyboardEvent): void {
    if (e.key === 'ArrowRight') select(index + 1);
    else if (e.key === 'ArrowLeft') select(index - 1);
  }
  const dots = (n: number): string => '●'.repeat(n) + '○'.repeat(5 - n);
</script>

<svelte:window onkeydown={keys} />

<section class="library">
  <header class="fade-in">
    <span class="wordmark">HPYNO</span>
    <button class="btn btn-ghost btn-icon" aria-label="Settings" onclick={() => router.openSettings()}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
    </button>
  </header>

  <div class="stage">
    {#if content.status === 'error'}
      <div class="glass card"><p class="eyebrow">could not load sessions</p><p class="muted">{content.error}</p></div>
    {:else if !current}
      <p class="muted">…</p>
    {:else}
      {#if sessions.length > 1}
        <button class="btn btn-ghost btn-icon arrow left" aria-label="Previous session" onclick={() => select(index - 1)}>‹</button>
        <button class="btn btn-ghost btn-icon arrow right" aria-label="Next session" onclick={() => select(index + 1)}>›</button>
      {/if}

      <div class="deck" role="group" aria-roledescription="carousel" aria-label="Session" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} style="--dx: {dragX}px" class:dragging>
        {#key current.id}
          <article class="glass card" class:from-right={dir === 1} class:from-left={dir === -1}>
            <div class="top">
              <span class="eyebrow">{current.tags.slice(0, 3).join(' · ') || 'session'}</span>
              <span class="eyebrow">{formatTime(current.durationSec)}</span>
            </div>
            <h1>{current.title}</h1>
            <p class="sub">{current.subtitle}</p>
            {#if pkg?.description}<p class="body">{pkg.description}</p>{/if}
            <div class="meta">
              <span class="dotsI" title="intensity {current.intensity} of 5">{dots(current.intensity)}</span>
              <ul class="expect">
                {#if breathing}<li>guided breathing</li>{/if}
                {#if gates > 0}<li>{gates} moment{gates > 1 ? 's' : ''} ask for your yes</li>{/if}
                <li>headphones</li>
              </ul>
            </div>
            {#if loadError}
              <p class="muted small">{loadError}</p>
            {:else if saved}
              <button class="btn btn-primary wide" disabled={!pkg} onclick={() => start(saved.mode, true)}>Continue at {formatTime(saved.position)}</button>
              <div class="split">
                <button class="btn" disabled={!pkg} onclick={() => start('watch', false)}>Watch from start</button>
                <button class="btn" disabled={!pkg} onclick={() => start('listen', false)}>Listen from start</button>
              </div>
            {:else}
              <div class="split">
                <button class="btn btn-primary" disabled={!pkg} onclick={() => start('watch', false)}>
                  <span class="mode-title">Watch</span><span class="mode-sub">eyes on the light</span>
                </button>
                <button class="btn btn-primary" disabled={!pkg} onclick={() => start('listen', false)}>
                  <span class="mode-title">Listen</span><span class="mode-sub">lock the phone, close your eyes</span>
                </button>
              </div>
            {/if}
          </article>
        {/key}
      </div>

      <nav class="overview" aria-label="All sessions">
        {#each sessions as s, i (s.id)}
          {@const cont = content.progress?.sessionId === s.id}
          <button class="tile glass" class:on={i === index} aria-current={i === index ? 'true' : undefined} onclick={() => select(i)}
            style="--c1: rgb({(s.themePreview?.c1 ?? [0.3, 0.06, 0.14]).map(v => Math.round(v * 255 + 40)).join(',')})">
            <span class="swatch"></span>
            <span class="tile-text">
              <span class="tile-title">{s.title}</span>
              <span class="tile-meta">{formatTime(s.durationSec)}{cont ? ' · continue' : ''}</span>
            </span>
          </button>
        {/each}
      </nav>
    {/if}
  </div>
</section>

<style>
  .library { position: absolute; inset: 0; display: flex; flex-direction: column; padding: max(0.75rem, var(--safe-top)) 0 max(1rem, var(--safe-bottom)); }
  header { display: flex; align-items: center; justify-content: space-between; padding: 0.25rem 1rem 0 1.25rem; }
  .wordmark { font-size: 1rem; }

  .stage { flex: 1; position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.9rem; padding: 0 1rem; min-height: 0; }
  .deck { width: min(520px, 100%); touch-action: pan-y; transform: translateX(var(--dx)); transition: transform 0s; }
  .deck:not(.dragging) { transition: transform var(--dur-ui) var(--ease-out); }

  .card { padding: 1.4rem 1.4rem 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; text-align: left; }
  .card.from-right { animation: slideIn var(--dur-ui) var(--ease-out) both; }
  .card.from-left { animation: slideInL var(--dur-ui) var(--ease-out) both; }
  @keyframes slideIn { from { opacity: 0; transform: translateX(28px); } to { opacity: 1; transform: none; } }
  @keyframes slideInL { from { opacity: 0; transform: translateX(-28px); } to { opacity: 1; transform: none; } }

  .top { display: flex; justify-content: space-between; align-items: center; }
  h1 { font-family: var(--font-display); font-weight: 400; font-size: clamp(2.2rem, 7vw, 3rem); line-height: 1; margin: 0.2rem 0 0; }
  .sub { margin: 0; color: var(--ash); }
  .body { margin: 0.25rem 0 0; font-size: 0.92rem; line-height: 1.55; }
  .meta { display: flex; flex-direction: column; gap: 0.5rem; margin: 0.4rem 0 0.6rem; }
  .dotsI { font-size: 0.6rem; letter-spacing: 0.25em; color: var(--blush); opacity: 0.85; }
  .expect { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .expect li { font-size: 0.72rem; padding: 0.28rem 0.6rem; border-radius: 999px; border: 1px solid var(--glass-border); color: var(--ash); }
  .small { font-size: 0.8rem; }

  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
  .split .btn { min-height: 64px; min-width: 0; flex-direction: column; gap: 0.15rem; padding: 0.6rem; text-align: center; }
  .wide { width: 100%; margin-bottom: 0.1rem; }
  .mode-title { font-family: var(--font-display); font-size: 1.35rem; }
  .mode-sub { font-size: 0.68rem; color: rgba(233,228,240,0.7); font-weight: 400; line-height: 1.2; }
  .btn:disabled { opacity: 0.55; cursor: progress; }

  .arrow { position: absolute; top: 50%; transform: translateY(-50%); font-size: 2rem; color: var(--ash); width: 48px; height: 64px; border-radius: 12px; display: none; }
  .arrow.left { left: max(0.5rem, calc(50% - 260px - 64px)); }
  .arrow.right { right: max(0.5rem, calc(50% - 260px - 64px)); }
  @media (min-width: 720px) and (hover: hover) { .arrow { display: inline-flex; } }

  .overview { width: min(720px, 100%); display: flex; gap: 0.5rem; overflow-x: auto; padding: 0.25rem 0.25rem 0.5rem; justify-content: safe center; scrollbar-width: none; }
  .overview::-webkit-scrollbar { display: none; }
  .tile { flex: 0 0 auto; display: flex; align-items: center; gap: 0.6rem; min-height: var(--tap); padding: 0.45rem 0.8rem 0.45rem 0.5rem; border-radius: 999px; color: var(--silver); cursor: pointer; appearance: none;
    transition: border-color var(--dur-fast), background var(--dur-fast), transform var(--dur-fast); }
  .tile:hover { transform: translateY(-1px); }
  .tile.on { border-color: rgba(255,154,168,0.5); background: rgba(74,15,36,0.35); }
  .tile:focus-visible { outline: 2px solid var(--blush); }
  .swatch { width: 26px; height: 26px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, rgba(255,255,255,0.35), transparent 45%), var(--c1); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08); }
  .tile-text { display: flex; flex-direction: column; line-height: 1.15; text-align: left; }
  .tile-title { font-family: var(--font-display); font-size: 1.05rem; }
  .tile-meta { font-size: 0.68rem; color: var(--ash); letter-spacing: 0.04em; }
</style>
