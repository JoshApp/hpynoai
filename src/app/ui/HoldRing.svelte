<script lang="ts">
  /** Press-and-hold consent ring. Fills over `holdMs`, then fires `onconfirm`. */
  interface Props { holdMs?: number; label?: string; onconfirm: () => void; remaining?: number; total?: number }
  const { holdMs = 650, label = 'hold to say yes', onconfirm, remaining = 0, total = 1 }: Props = $props();

  let progress = $state(0);
  let holding = $state(false);
  let raf = 0;
  let start = 0;
  let fired = false;

  function frame(now: number): void {
    if (!holding) return;
    progress = Math.min(1, (now - start) / holdMs);
    if (progress >= 1 && !fired) { fired = true; holding = false; onconfirm(); return; }
    raf = requestAnimationFrame(frame);
  }
  function down(e: PointerEvent): void {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    fired = false; holding = true; start = performance.now(); progress = 0;
    raf = requestAnimationFrame(frame);
  }
  function up(): void { holding = false; cancelAnimationFrame(raf); if (!fired) progress = 0; }
  function key(e: KeyboardEvent): void { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fired = true; onconfirm(); } }

  const R = 44;
  const C = 2 * Math.PI * R;
  const window_ = $derived(total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0);
</script>

<button class="ring" class:holding aria-label={label}
  onpointerdown={down} onpointerup={up} onpointercancel={up} onpointerleave={up} onkeydown={key} oncontextmenu={(e) => e.preventDefault()}>
  <svg viewBox="0 0 100 100" aria-hidden="true">
    <circle class="track" cx="50" cy="50" r={R} />
    <circle class="window" cx="50" cy="50" r={R} stroke-dasharray={C} stroke-dashoffset={C * (1 - window_)} />
    <circle class="fill" cx="50" cy="50" r={R} stroke-dasharray={C} stroke-dashoffset={C * (1 - progress)} />
    <circle class="core" cx="50" cy="50" r={10 + progress * 22} />
  </svg>
  <span>{label}</span>
</button>

<style>
  .ring {
    appearance: none; background: transparent; border: 0; color: var(--silver);
    display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
    cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; padding: 0.5rem;
  }
  .ring:focus-visible { outline: 2px solid var(--blush); border-radius: 50%; }
  svg { width: 128px; height: 128px; transform: rotate(-90deg); filter: drop-shadow(0 0 18px rgba(255,154,168,0.35)); }
  circle { fill: none; stroke-width: 1.5; }
  .track { stroke: rgba(233,228,240,0.15); }
  .window { stroke: rgba(233,228,240,0.45); transition: stroke-dashoffset 250ms linear; }
  .fill { stroke: var(--blush); stroke-width: 3; stroke-linecap: round; }
  .core { fill: rgba(255,154,168,0.18); stroke: none; transition: r 120ms var(--ease-out); }
  .holding .core { fill: rgba(255,154,168,0.4); }
  span { font: 400 0.85rem var(--font-ui); letter-spacing: 0.08em; color: var(--ash); }
  .holding span { color: var(--silver); }
</style>
