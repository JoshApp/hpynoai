<script lang="ts">
  /**
   * Preview — authoring tool. Script beside the live world, click-to-seek,
   * cue timeline, cue nudging saved as overrides, free re-assemble.
   * Dev-only (#/preview/:id). Exposes window.__preview for headless driving.
   */
  import { onMount, onDestroy } from 'svelte';
  import type { Engine } from '@engine/engine';
  import { content } from '../content.svelte';
  import { settings, haptic } from '../settings.svelte';
  import { SessionDirector, type DirectorSnapshot } from '../session-director';
  import type { SessionPackage, Cue } from '@content/schema';
  import { stageStarts } from '@content/schema';
  import { formatTime } from '@player/persistence';
  import { resolveAsset } from '@content/loader';

  interface Props { engine: Engine; id: string }
  const { engine, id }: Props = $props();

  type Overrides = { cues: Record<string, { dt?: number; window?: number; dur?: number }>; silences: Record<string, number>; fx?: Record<string, Record<string, number>> };
  type FxField = { key: string; min: number; max: number; step: number; label: string };
  type FxInfo = { fields: FxField[]; stages: Record<string, { script: Record<string, number>; override: Record<string, number> }> };

  let pkg = $state<SessionPackage | null>(null);
  let baseUrl = $state('');
  let script = $state('');
  let overrides = $state<Overrides>({ cues: {}, silences: {}, fx: {} });
  let fxInfo = $state<FxInfo | null>(null);
  let showFx = $state(false);
  let dirty = $state(false);
  let busy = $state<string | null>(null);
  let log = $state('');
  let error = $state<string | null>(null);
  let director = $state<SessionDirector | null>(null);
  let started = $state(false);
  let snap = $state<DirectorSnapshot>({ state: 'idle', position: 0, duration: 0, gate: null, stage: '', breathing: false, intensity: 0 });
  let selected = $state<string | null>(null);
  let peaks = $state<Float32Array | null>(null);
  let showScript = $state(false);
  let compare = $state<{ stage: string; files: { model: string; url: string }[] } | null>(null);
  let poll = 0;

  const starts = $derived(pkg ? stageStarts(pkg) : []);
  const lines = $derived.by(() => {
    if (!pkg) return [] as { stage: string; text: string; t: number; end: number; words: { w: string; s: number; e: number }[] }[];
    const out: { stage: string; text: string; t: number; end: number; words: { w: string; s: number; e: number }[] }[] = [];
    for (const ts of pkg.text?.stages ?? []) {
      const si = pkg.audio.stages.findIndex(s => s.name === ts.name); const base = starts[si] ?? 0;
      for (const l of ts.lines) out.push({ stage: ts.name, text: l.text, t: base + l.start, end: base + l.end, words: l.words.map(w => ({ w: w.w, s: base + w.s, e: base + w.e })) });
    }
    return out;
  });
  const currentLine = $derived(lines.findIndex(l => snap.position >= l.t && snap.position < l.end + 0.6));
  const currentWord = $derived.by(() => {
    const l = lines[currentLine]; if (!l) return -1;
    return l.words.findIndex((w, i) => snap.position >= w.s && snap.position < (l.words[i + 1]?.s ?? w.e + 0.6));
  });
  const cues = $derived((pkg?.cues ?? []).filter(c => c.type !== 'pattern'));
  const selectedCue = $derived(cues.find(c => c.id === selected) ?? null);

  async function load(): Promise<void> {
    error = null;
    try {
      const l = await content.package(id); pkg = l.pkg; baseUrl = l.baseUrl;
      const r = await fetch(`/__hpyno/script/${id}`);
      if (r.ok) { const d = await r.json(); script = d.script; overrides = { cues: {}, silences: {}, fx: {}, ...d.overrides }; }
      const f = await fetch(`/__hpyno/fx/${id}`);
      if (f.ok) fxInfo = await f.json();
      void loadPeaks(l.pkg, l.baseUrl);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }

  async function loadPeaks(p: SessionPackage, base: string): Promise<void> {
    try {
      const ctx = new OfflineAudioContext(1, 44100, 44100);
      const per = 300; const all = new Float32Array(p.audio.stages.length * per);
      await Promise.all(p.audio.stages.map(async (st, i) => {
        const buf = await (await fetch(resolveAsset(base, st.fileMp3 ?? st.file))).arrayBuffer();
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0); const step = Math.floor(data.length / per);
        for (let k = 0; k < per; k++) { let m = 0; for (let j = k * step; j < (k + 1) * step; j += 16) m = Math.max(m, Math.abs(data[j] ?? 0)); all[i * per + k] = m; }
      }));
      peaks = all;
    } catch { peaks = null; }
  }

  function begin(at = 0): void {
    if (!pkg || director) return;
    director = new SessionDirector(engine, { pkg, baseUrl }, 'watch', {
      voiceVolume: settings.value.voiceVolume, bedVolume: settings.value.bedVolume, showText: true, textMode: settings.value.textMode, textLead: settings.value.textLead,
      textScale: settings.value.textScale, reduceFlash: false, haptic,
    });
    void director.start(at); started = true;
    poll = window.setInterval(() => { if (director) snap = { ...director.snapshot }; }, 80);
  }

  function seek(t: number): void {
    if (!started) { begin(Math.max(0, t)); return; }
    void director?.seek(Math.max(0, t));
  }
  function nudge(c: Cue, dt: number): void {
    if (!c.id) return;
    const o = overrides.cues[c.id] ?? {}; o.dt = Math.round(((o.dt ?? 0) + dt) * 100) / 100;
    overrides = { ...overrides, cues: { ...overrides.cues, [c.id]: o } }; dirty = true;
  }
  function setWindow(c: Cue, w: number): void {
    if (!c.id) return;
    overrides = { ...overrides, cues: { ...overrides.cues, [c.id]: { ...(overrides.cues[c.id] ?? {}), window: w } } }; dirty = true;
  }
  function clearOverride(c: Cue): void {
    if (!c.id) return;
    const next = { ...overrides.cues }; delete next[c.id]; overrides = { ...overrides, cues: next }; dirty = true;
  }
  async function save(): Promise<void> {
    busy = 'saving';
    await fetch(`/__hpyno/overrides/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overrides) });
    dirty = false; busy = null;
  }
  async function assemble(): Promise<void> {
    if (dirty) await save();
    busy = 'assembling'; log = '';
    const r = await fetch(`/__hpyno/assemble/${id}`, { method: 'POST' });
    const d = await r.json(); log = d.log ?? d.error ?? ''; busy = null;
    if (d.ok) { const pos = snap.position; director?.dispose(); director = null; started = false; clearInterval(poll); (window as unknown as { __hpynoReload?: boolean }).__hpynoReload = true; location.reload(); sessionStorage.setItem('hpyno.preview.pos', String(pos)); }
  }

  function fxValue(stage: string, key: string): number {
    const o = overrides.fx?.[stage]?.[key];
    return o !== undefined ? o : (fxInfo?.stages[stage]?.script[key] ?? 0);
  }
  function setFx(stage: string, key: string, v: number): void {
    const fx = { ...(overrides.fx ?? {}) };
    fx[stage] = { ...(fx[stage] ?? {}), [key]: v };
    overrides = { ...overrides, fx }; dirty = true;
  }
  function resetFx(stage: string): void {
    const fx = { ...(overrides.fx ?? {}) }; delete fx[stage];
    overrides = { ...overrides, fx }; dirty = true;
  }

  async function compareModels(): Promise<void> {
    if (!snap.stage) return;
    busy = 'comparing'; log = '';
    const r = await fetch(`/__hpyno/audition/${id}?stage=${encodeURIComponent(snap.stage)}`, { method: 'POST' });
    const d = await r.json(); log = d.log ?? d.error ?? ''; busy = null;
    if (d.ok) compare = { stage: snap.stage, files: d.files };
  }

  function keys(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
    if (e.key === ' ') { e.preventDefault(); if (!started) begin(0); else if (snap.gate) void director?.answer(); else void director?.toggle(); }
    else if (e.key === 'ArrowRight') seek(snap.position + (e.shiftKey ? 30 : 5));
    else if (e.key === 'ArrowLeft') seek(snap.position - (e.shiftKey ? 30 : 5));
  }

  // Plain objects (not rune proxies) so headless drivers can serialise them.
  const api = {
    seek, begin,
    get snapshot() { return $state.snapshot(snap); },
    get lines() { return $state.snapshot(lines); },
    get cues() { return $state.snapshot(cues); },
    answer: () => director?.answer(), toggle: () => director?.toggle(),
    overrides: () => $state.snapshot(overrides),
  };

  onMount(async () => {
    (window as unknown as { __preview: unknown }).__preview = api;
    await load();
    const pos = sessionStorage.getItem('hpyno.preview.pos');
    if (pos) { sessionStorage.removeItem('hpyno.preview.pos'); begin(Number(pos)); }
  });
  onDestroy(() => { clearInterval(poll); director?.dispose(); });

  const cueColor = (t: string): string => ({ gate: 'var(--blush)', breath: '#8fd3ff', trigger: '#ffd28a', intensity: '#b39ddb', anchor: '#9be3a8' }[t] ?? 'var(--ash)');
  const cueLabel = (c: Cue): string => c.type === 'gate' ? `gate · ${c.prompt}` : c.type === 'trigger' ? `trigger · ${c.kind}` : c.type === 'breath' ? `breath · ${c.dur}s` : c.type === 'intensity' ? `depth ${c.value}` : c.type === 'anchor' ? `anchor · ${c.mode}` : c.type;
</script>

<svelte:window onkeydown={keys} />

<div class="preview">
  <aside class="glass panel">
    <header>
      <span class="eyebrow">preview · {id}</span>
      <div class="row">
        <button class="btn btn-ghost sm" class:on={showFx} onclick={() => { showFx = !showFx; if (showFx) showScript = false; }}>fx</button>
        <button class="btn btn-ghost sm" class:on={showScript} onclick={() => { showScript = !showScript; if (showScript) showFx = false; }}>script</button>
        <button class="btn btn-ghost sm" onclick={() => location.hash = '#/'}>✕</button>
      </div>
    </header>
    {#if error}<p class="muted">{error}</p>
    {:else if !pkg}<p class="muted">…</p>
    {:else if showFx}
      {@const stage = snap.stage || pkg.audio.stages[0]?.name || ''}
      <div class="fx">
        <div class="fx-head"><span class="eyebrow">{stage}</span>{#if overrides.fx?.[stage]}<button class="btn btn-ghost sm" onclick={() => resetFx(stage)}>reset stage</button>{/if}</div>
        {#if !fxInfo}<p class="muted">…</p>{:else}
          {#each fxInfo.fields as f (f.key)}
            {@const v = fxValue(stage, f.key)}
            {@const changed = overrides.fx?.[stage]?.[f.key] !== undefined}
            <label class="fx-row" class:changed>
              <span>{f.label}</span>
              <input type="range" min={f.min} max={f.max} step={f.step} value={v} oninput={(e) => setFx(stage, f.key, Number((e.target as HTMLInputElement).value))} />
              <input type="number" min={f.min} max={f.max} step={f.step} value={v} onchange={(e) => setFx(stage, f.key, Number((e.target as HTMLInputElement).value))} />
            </label>
          {/each}
          <p class="muted small">changes apply on assemble (free, ~1 min). Seek into a stage to edit it.</p>
        {/if}
      </div>
    {:else if showScript}
      <pre class="script">{script}</pre>
    {:else}
      <ol class="lines">
        {#each lines as l, i (i)}
          {#if i === 0 || lines[i - 1]?.stage !== l.stage}<li class="stage-h"><span class="eyebrow">{l.stage}</span><span class="muted">{formatTime(starts[pkg.audio.stages.findIndex(s => s.name === l.stage)] ?? 0)}</span></li>{/if}
          <li class:cur={i === currentLine}><button onclick={() => seek(l.t)}>
            <span class="t">{formatTime(l.t)}</span>
            <span class="txt">{#each l.words as w, k (k)}<span class:hot={i === currentLine && k === currentWord}>{w.w} </span>{/each}</span>
          </button></li>
        {/each}
      </ol>
    {/if}
  </aside>

  <div class="bottom glass">
    <div class="transport">
      {#if !started}
        <button class="btn btn-primary" onclick={() => begin()} disabled={!pkg}>Start</button>
      {:else}
        <button class="btn btn-primary sm" onclick={() => { if (snap.gate) void director?.answer(); else void director?.toggle(); }}>{snap.gate ? 'yes' : snap.state === 'playing' ? 'pause' : 'play'}</button>
      {/if}
      <span class="t">{formatTime(snap.position)} / {formatTime(snap.duration || pkg?.durationSec || 0)}</span>
      <span class="muted small">{snap.stage} · depth {snap.intensity.toFixed(2)}{snap.breathing ? ' · breathing' : ''}{snap.gate ? ` · gate ${snap.gate.remaining.toFixed(1)}s` : ''}</span>
      <span class="grow"></span>
      {#if selectedCue}
        <span class="sel" style="--c: {cueColor(selectedCue.type)}">{cueLabel(selectedCue)} @ {selectedCue.t.toFixed(2)}s</span>
        <button class="btn btn-ghost sm" onclick={() => nudge(selectedCue, -1)}>−1s</button>
        <button class="btn btn-ghost sm" onclick={() => nudge(selectedCue, -0.25)}>−¼</button>
        <button class="btn btn-ghost sm" onclick={() => nudge(selectedCue, 0.25)}>+¼</button>
        <button class="btn btn-ghost sm" onclick={() => nudge(selectedCue, 1)}>+1s</button>
        {#if selectedCue.type === 'gate'}<label class="small">window <input type="number" step="0.5" min="1" value={overrides.cues[selectedCue.id ?? '']?.window ?? selectedCue.window} onchange={(e) => setWindow(selectedCue, Number((e.target as HTMLInputElement).value))} /></label>{/if}
        {#if overrides.cues[selectedCue.id ?? '']}<span class="small muted">Δ {overrides.cues[selectedCue.id ?? '']?.dt ?? 0}s</span><button class="btn btn-ghost sm" onclick={() => clearOverride(selectedCue)}>reset</button>{/if}
      {/if}
      <label class="small row"><span class="muted">words</span>
        <select value={settings.value.textMode} onchange={(e) => settings.set('textMode', (e.target as HTMLSelectElement).value as 'word' | 'line')}><option value="line">line</option><option value="word">one word</option></select>
      </label>
      <label class="small row"><span class="muted">lead</span><input type="number" step="0.02" min="-0.5" max="0.5" value={settings.value.textLead} onchange={(e) => settings.set('textLead', Number((e.target as HTMLInputElement).value))} /><span class="muted">s</span></label>
      <button class="btn sm" disabled={!started || !!busy} onclick={compareModels} title="render this stage on the other model (costs credits)">{busy === 'comparing' ? 'rendering…' : 'compare v2/v3'}</button>
      <button class="btn sm" disabled={!dirty || !!busy} onclick={save}>save</button>
      <button class="btn btn-primary sm" disabled={!!busy} onclick={assemble}>{busy === 'assembling' ? 'assembling…' : 'assemble'}</button>
    </div>
    {#if pkg}
      {@const dur = pkg.durationSec}
      <div class="timeline" role="presentation" onclick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * dur); }}>
        {#if peaks}
          <svg class="wave" viewBox="0 0 {peaks.length} 40" preserveAspectRatio="none" aria-hidden="true">
            {#each peaks as pk, i (i)}<rect x={i} y={20 - pk * 19} width="1" height={Math.max(0.5, pk * 38)} />{/each}
          </svg>
        {/if}
        {#each pkg.audio.stages as st, i (st.name)}
          <div class="stage" style="left: {(starts[i] ?? 0) / dur * 100}%; width: {st.duration / dur * 100}%"><span>{st.name}</span></div>
        {/each}
        {#each cues as c (c.id ?? c.t + c.type)}
          <button class="cue" class:sel={c.id === selected} class:ov={!!(c.id && overrides.cues[c.id])} style="left: {c.t / dur * 100}%; --c: {cueColor(c.type)}" title={cueLabel(c)}
            onclick={(e) => { e.stopPropagation(); selected = c.id ?? null; seek(c.t - 1.5); }}></button>
          {#if c.type === 'gate' || c.type === 'breath'}
            <div class="win" style="left: {c.t / dur * 100}%; width: {(c.type === 'gate' ? c.window : c.dur) / dur * 100}%; --c: {cueColor(c.type)}"></div>
          {/if}
        {/each}
        <div class="head" style="left: {snap.position / dur * 100}%"></div>
      </div>
    {/if}
    {#if compare}
      <div class="compare">
        <span class="eyebrow">{compare.stage}</span>
        {#each compare.files as f (f.model)}
          <span class="small">{f.model} <audio controls src={f.url} preload="none"></audio></span>
        {/each}
        <button class="btn btn-ghost sm" onclick={() => compare = null}>✕</button>
      </div>
    {/if}
    {#if log}<pre class="log">{log}</pre>{/if}
  </div>
</div>

<style>
  .preview { position: absolute; inset: 0; pointer-events: none; }
  .preview > * { pointer-events: auto; }
  .panel { position: absolute; top: 0.75rem; left: 0.75rem; bottom: 118px; width: min(420px, 45vw); display: flex; flex-direction: column; font-size: 0.85rem; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--glass-border); }
  .sm { min-height: 30px; padding: 0 0.7rem; font-size: 0.78rem; }
  .on { background: rgba(233,228,240,0.12); }
  .lines { list-style: none; margin: 0; padding: 0.25rem 0; overflow-y: auto; flex: 1; }
  .lines li button { display: flex; gap: 0.6rem; width: 100%; text-align: left; background: transparent; border: 0; color: var(--silver); padding: 0.35rem 0.75rem; cursor: pointer; font: inherit; line-height: 1.4; }
  .lines li button:hover { background: rgba(233,228,240,0.06); }
  .lines li.cur button { background: rgba(74,15,36,0.45); }
  .lines .t { color: var(--ash); font-variant-numeric: tabular-nums; flex: 0 0 2.8em; font-size: 0.75rem; padding-top: 0.15em; }
  .lines .txt { font-family: var(--font-display); font-size: 1rem; }
  .txt span { margin-right: 0.28em; }
  .hot { color: var(--blush); }
  .stage-h { display: flex; justify-content: space-between; padding: 0.6rem 0.75rem 0.2rem; }
  .fx { flex: 1; overflow-y: auto; padding: 0.5rem 0.75rem; display: flex; flex-direction: column; gap: 0.2rem; }
  .fx-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem; }
  .fx-row { display: grid; grid-template-columns: 1fr 1.2fr 4.2em; align-items: center; gap: 0.5rem; font-size: 0.75rem; color: var(--ash); min-height: 28px; }
  .fx-row.changed span { color: var(--blush); }
  .fx-row input[type=range] { accent-color: var(--blush); width: 100%; }
  .fx-row input[type=number] { width: 100%; background: var(--wine-deep); color: var(--silver); border: 1px solid var(--glass-border); border-radius: 6px; padding: 2px 4px; font-size: 0.72rem; }
  .script { flex: 1; overflow: auto; margin: 0; padding: 0.75rem; font-size: 0.72rem; line-height: 1.45; white-space: pre-wrap; color: var(--silver); }
  .bottom { position: absolute; left: 0.75rem; right: 0.75rem; bottom: 0.75rem; padding: 0.5rem 0.75rem 0.6rem; display: flex; flex-direction: column; gap: 0.4rem; }
  .transport { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.8rem; }
  .transport .t { font-variant-numeric: tabular-nums; }
  .grow { flex: 1; }
  .small { font-size: 0.72rem; }
  .sel { color: var(--c); font-size: 0.78rem; }
  input[type=number] { width: 4em; background: var(--wine-deep); color: var(--silver); border: 1px solid var(--glass-border); border-radius: 6px; padding: 2px 4px; }
  .timeline { position: relative; height: 56px; border-radius: 8px; background: rgba(233,228,240,0.05); overflow: hidden; cursor: pointer; }
  .wave { position: absolute; inset: 8px 0 8px 0; width: 100%; height: 40px; fill: rgba(233,228,240,0.28); }
  .stage { position: absolute; top: 0; bottom: 0; border-left: 1px solid rgba(233,228,240,0.2); }
  .stage span { position: absolute; top: 2px; left: 4px; font-size: 0.62rem; color: var(--ash); letter-spacing: 0.08em; text-transform: uppercase; }
  .cue { position: absolute; top: 50%; width: 10px; height: 10px; margin-left: -5px; margin-top: -5px; border-radius: 50%; border: 1.5px solid var(--c); background: rgba(7,4,10,0.7); padding: 0; cursor: pointer; }
  .cue.sel { background: var(--c); box-shadow: 0 0 0 3px rgba(233,228,240,0.25); }
  .cue.ov { border-style: dashed; }
  .win { position: absolute; top: 46px; height: 3px; background: var(--c); opacity: 0.7; pointer-events: none; }
  .head { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--silver); pointer-events: none; }
  .compare { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .compare audio { height: 30px; vertical-align: middle; margin-left: 0.4rem; }
  select { background: var(--wine-deep); color: var(--silver); border: 1px solid var(--glass-border); border-radius: 6px; padding: 2px 4px; }
  .log { max-height: 90px; overflow: auto; margin: 0; font-size: 0.68rem; color: var(--ash); white-space: pre-wrap; }
</style>
