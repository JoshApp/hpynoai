<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Engine } from '@engine/engine';
  import type { SessionDirector, DirectorSnapshot } from '../session-director';
  import { content } from '../content.svelte';
  import { settings } from '../settings.svelte';
  import { router } from '../router.svelte';
  import { formatTime } from '@player/persistence';
  import HoldRing from '../ui/HoldRing.svelte';
  import { handoff } from '../session.svelte';

  interface Props { engine: Engine; id: string; mode: 'watch' | 'listen' }
  const { engine, id, mode }: Props = $props();

  let director = $state<SessionDirector | null>(null);
  let phase = $state<'loading' | 'running' | 'error'>('loading');
  let error = $state<string | null>(null);
  let snap = $state<DirectorSnapshot>({ state: 'idle', position: 0, duration: 0, gate: null, stage: '', breathing: false, intensity: 0 });
  let controls = $state(false);
  let screenOff = $state(false);
  let scrubbing = $state(false);
  let scrubValue = $state(0);
  let volumes = $state(false);
  let title = $state('');
  let hideTimer = 0;
  let pollTimer = 0;

  onMount(async () => {
    controls = true;
    try {
      const adopted = handoff.take(id);
      if (adopted) {
        director = adopted;
        title = adopted.player.pkg.title;
        phase = 'running';
        scheduleHide();
      } else {
        // Reload or deep link: no gesture to start audio with. Back to the
        // selector with this session chosen; saved progress offers Continue.
        router.go(`/s/${encodeURIComponent(id)}`, true);
        return;
      }
      if (import.meta.env.DEV) (window as unknown as { __director: unknown }).__director = director;
      pollTimer = window.setInterval(() => { if (director) snap = { ...director.snapshot }; }, 100);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      phase = 'error';
    }
  });

  onDestroy(() => {
    clearInterval(pollTimer);
    clearTimeout(hideTimer);
    director?.dispose();
    content.refreshProgress();
  });

  $effect(() => {
    const s = settings.value;
    director?.setOptions({ voiceVolume: s.voiceVolume, bedVolume: s.bedVolume, showText: s.showText, textMode: s.textMode, textLead: s.textLead, textScale: s.textScale, reduceFlash: s.reduceFlash });
  });

  $effect(() => {
    if (snap.state === 'ended') router.go(`/end/${encodeURIComponent(id)}`, true);
  });

  function scheduleHide(): void {
    clearTimeout(hideTimer);
    if (mode === 'watch') hideTimer = window.setTimeout(() => { if (!scrubbing && !volumes) controls = false; }, 3200);
  }

  function tapStage(): void {
    if (!director || phase !== 'running') return;
    if (snap.gate && mode === 'listen') { void director.answer(); return; }
    if (screenOff) { screenOff = false; director.setScreenOff(false); controls = true; scheduleHide(); return; }
    if (mode === 'watch') { controls = !controls; if (controls) scheduleHide(); }
  }

  function toggleScreenOff(): void {
    if (!director) return;
    screenOff = !screenOff;
    director.setScreenOff(screenOff);
    controls = !screenOff;
  }

  function onScrubInput(e: Event): void { scrubbing = true; scrubValue = Number((e.target as HTMLInputElement).value); }
  function onScrubChange(e: Event): void {
    scrubbing = false;
    void director?.seek(Number((e.target as HTMLInputElement).value));
    scheduleHide();
  }

  function exit(): void { router.go('/', true); }

  function keys(e: KeyboardEvent): void {
    if (phase !== 'running' || !director) return;
    if (e.key === ' ') { e.preventDefault(); if (snap.gate) void director.answer(); else void director.toggle(); }
    else if (e.key === 'Escape') exit();
    else if (e.key === 'ArrowRight') void director.seek(snap.position + 15);
    else if (e.key === 'ArrowLeft') void director.seek(snap.position - 15);
  }

  const pos = $derived(scrubbing ? scrubValue : snap.position);
</script>

<svelte:window onkeydown={keys} />

<section class="player" class:listen={mode === 'listen'} class:screenoff={screenOff}>
  <!-- tap layer -->
  <button class="stage" aria-label={snap.gate && mode === 'listen' ? 'Tap to say yes' : 'Show controls'} onclick={tapStage}></button>

  {#if phase === 'loading'}
    <div class="center"><p class="muted">preparing…</p></div>
  {:else if phase === 'error'}
    <div class="center glass card"><p class="eyebrow">could not start</p><p class="muted">{error}</p><button class="btn" onclick={exit}>back</button></div>
  {:else}
    {#if mode === 'listen'}
      <div class="listen-face" aria-hidden="true">
        <div class="glow" style="--b: {engine.inputs.breath.value}"></div>
      </div>
      <div class="listen-ui">
        <p class="eyebrow">{snap.stage}</p>
        <h1>{title}</h1>
        {#if snap.gate}
          <p class="prompt">{snap.gate.prompt}</p>
          <p class="muted small">tap anywhere to say yes</p>
        {:else}
          <p class="muted small">{snap.state === 'paused' ? 'paused' : 'listening'}</p>
        {/if}
      </div>
    {/if}

    {#if snap.gate && mode === 'watch' && !screenOff}
      <div class="gate fade-in">
        <HoldRing remaining={snap.gate.remaining} total={snap.gate.total} onconfirm={() => { void director?.answer(); }} />
      </div>
    {/if}

    {#if snap.state === 'paused' && !controls}
      <div class="center paused-hint"><p class="eyebrow">paused · tap</p></div>
    {/if}

    <div class="bar glass" class:hidden={!controls} aria-hidden={!controls}>
      <div class="scrub">
        <span class="t">{formatTime(pos)}</span>
        <input class="slider" type="range" min="0" max={snap.duration || 1} step="0.5" value={pos} oninput={onScrubInput} onchange={onScrubChange} aria-label="Position" />
        <span class="t">{formatTime(snap.duration)}</span>
      </div>
      <div class="actions">
        <button class="btn btn-ghost btn-icon" aria-label="Exit" onclick={exit}>✕</button>
        <button class="btn btn-primary btn-icon big" aria-label={snap.state === 'playing' ? 'Pause' : 'Play'} onclick={() => { void director?.toggle(); scheduleHide(); }}>
          {#if snap.state === 'playing'}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
          {:else}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          {/if}
        </button>
        {#if mode === 'watch'}
          <button class="btn btn-ghost btn-icon" aria-label="Screen off" onclick={toggleScreenOff}>☾</button>
        {:else}
          <span class="btn btn-ghost btn-icon" aria-hidden="true"></span>
        {/if}
        <button class="btn btn-ghost btn-icon" aria-label="Volume" class:on={volumes} onclick={() => { volumes = !volumes; scheduleHide(); }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>
        </button>
      </div>
      {#if volumes}
        <div class="vols fade-in">
          <label><span class="eyebrow">voice</span><input class="slider" type="range" min="0" max="1" step="0.02" value={settings.value.voiceVolume} oninput={(e) => settings.set('voiceVolume', Number((e.target as HTMLInputElement).value))} /></label>
          <label><span class="eyebrow">ambience</span><input class="slider" type="range" min="0" max="1" step="0.02" value={settings.value.bedVolume} oninput={(e) => settings.set('bedVolume', Number((e.target as HTMLInputElement).value))} /></label>
          <div class="row seg"><span class="eyebrow">words</span>
            <button class="btn" class:btn-primary={!settings.value.showText} onclick={() => settings.set('showText', false)}>off</button>
            <button class="btn" class:btn-primary={settings.value.showText && settings.value.textMode === 'word'} onclick={() => { settings.set('showText', true); settings.set('textMode', 'word'); }}>one word</button>
            <button class="btn" class:btn-primary={settings.value.showText && settings.value.textMode === 'line'} onclick={() => { settings.set('showText', true); settings.set('textMode', 'line'); }}>line</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .player { position: absolute; inset: 0; }
  .stage { position: absolute; inset: 0; background: transparent; border: 0; padding: 0; cursor: default; appearance: none; }
  .center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); text-align: center; pointer-events: none; }
  .center.card, .center .btn { pointer-events: auto; }
  .card { width: min(380px, calc(100vw - 2.5rem)); padding: 1.6rem 1.4rem; display: flex; flex-direction: column; gap: 0.6rem; align-items: center; }
  h1 { font-family: var(--font-display); font-weight: 400; font-size: 2.2rem; margin: 0; line-height: 1.05; }
  .small { font-size: 0.85rem; line-height: 1.5; margin: 0 0 0.4rem; }
  .paused-hint { opacity: 0.7; }

  .gate { position: absolute; left: 50%; bottom: calc(12% + var(--safe-bottom)); transform: translateX(-50%); }

  .bar { position: absolute; left: 50%; bottom: calc(0.75rem + var(--safe-bottom)); transform: translateX(-50%);
    width: min(560px, calc(100vw - 1.5rem)); padding: 0.5rem 0.75rem 0.6rem; display: flex; flex-direction: column; gap: 0.25rem;
    transition: opacity var(--dur-ui) var(--ease-out), transform var(--dur-ui) var(--ease-out); }
  .bar.hidden { opacity: 0; transform: translate(-50%, 12px); pointer-events: none; }
  .scrub { display: flex; align-items: center; gap: 0.5rem; }
  .scrub .t { font-size: 0.72rem; color: var(--ash); min-width: 2.6em; text-align: center; font-variant-numeric: tabular-nums; }
  .actions { display: flex; justify-content: space-between; align-items: center; }
  .big { width: 56px; height: 56px; }
  .on { background: rgba(233,228,240,0.12); }
  .vols { display: flex; flex-direction: column; gap: 0.1rem; padding: 0.25rem 0.25rem 0; }
  .vols label { display: flex; flex-direction: column; }
  .seg { gap: 0.4rem; min-height: var(--tap); }
  .seg .btn { min-height: 32px; padding: 0 0.7rem; font-size: 0.78rem; }

  .listen-face { position: absolute; inset: 0; background: var(--bg); pointer-events: none; }
  .glow { position: absolute; left: 50%; top: 42%; width: 42vmin; height: 42vmin; transform: translate(-50%, -50%) scale(calc(0.8 + var(--b) * 0.35));
    border-radius: 50%; background: radial-gradient(circle, rgba(255,154,168,0.16) 0%, rgba(74,15,36,0.18) 45%, transparent 70%); transition: transform 300ms linear; }
  .listen-ui { position: absolute; left: 0; right: 0; top: 60%; text-align: center; pointer-events: none; padding: 0 1.5rem; }
  .prompt { font-family: var(--font-display); font-style: italic; font-size: 1.5rem; margin: 0.6rem 0 0.2rem; }
  .screenoff .bar { opacity: 0; pointer-events: none; }
</style>
