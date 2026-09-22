<script lang="ts">
  import type { Engine } from '@engine/engine';
  import { sessionPreset, idlePreset } from '@engine/world/palette';
  import type { QualityLevel } from '@engine/render/quality';

  interface Props { engine: Engine }
  const { engine }: Props = $props();

  let depth = $state(0);
  let useSession = $state(false);
  let fps = $state(0);
  let quality = $state<QualityLevel>('high');
  let wispMode = $state('idle');
  let breathCycle = $state(10);
  let feedback = $state(true);
  let intensity = $state(0.12);
  let spiral = $state(0.35);
  let speed = $state(0.55);
  let shape = $state(1);
  let fbStrength = $state(0.35);
  let sway = $state(0.4);
  let particles = $state(0.25);

  function apply(): void {
    const base = useSession ? sessionPreset(depth) : idlePreset;
    engine.world.configure({
      ...base,
      tunnel: { ...base.tunnel, intensity, spiralSpeed: spiral, speed, shape },
      feedback: { strength: fbStrength },
      camera: { ...base.camera, sway },
      particles: { ...base.particles, intensity: particles, visible: particles > 0.01 },
    }, { duration: 0.6 });
  }

  function loadPreset(): void {
    const p = useSession ? sessionPreset(depth) : idlePreset;
    intensity = p.tunnel?.intensity ?? 0.1;
    spiral = p.tunnel?.spiralSpeed ?? 0.3;
    speed = p.tunnel?.speed ?? 0.5;
    shape = p.tunnel?.shape ?? 1;
    fbStrength = p.feedback?.strength ?? 0.3;
    sway = p.camera?.sway ?? 0.4;
    particles = p.particles?.intensity ?? 0.2;
    apply();
  }

  $effect(() => {
    const id = setInterval(() => { fps = Math.round(engine.quality.fps); quality = engine.quality.level; }, 500);
    return () => clearInterval(id);
  });

  $effect(() => { engine.breath.setCycle(breathCycle); });
  $effect(() => { engine.renderer.feedbackEnabled = feedback; });
  $effect(() => { engine.inputs.intensity = intensity; });

  function setWisp(mode: string): void {
    wispMode = mode;
    if (mode === 'idle') engine.world.wisp.enterIdle();
    else if (mode === 'session') engine.world.wisp.enterSession();
    else if (mode === 'pendulum') engine.world.wisp.transitionTo('pendulum', { duration: 1 });
    else if (mode === 'hidden') engine.world.wisp.hide();
  }
  function drop(): void { engine.world.fade.drop(1.2); engine.renderer.clearTrails(); }
  function bloom(): void { engine.world.fade.drop(0.5, 'white'); engine.world.wisp.pulse(1.8); }
</script>

<aside>
  <header>
    <strong>dev</strong>
    <span>{fps} fps · {quality}</span>
  </header>

  <label><span>look</span>
    <select bind:value={useSession} onchange={loadPreset}>
      <option value={false}>idle</option>
      <option value={true}>session</option>
    </select>
  </label>
  {#if useSession}
    <label><span>depth {depth.toFixed(2)}</span><input type="range" min="0" max="1" step="0.01" bind:value={depth} oninput={loadPreset} /></label>
  {/if}

  <label><span>intensity {intensity.toFixed(2)}</span><input type="range" min="0" max="1" step="0.01" bind:value={intensity} oninput={apply} /></label>
  <label><span>spiral {spiral.toFixed(2)}</span><input type="range" min="0" max="1.5" step="0.01" bind:value={spiral} oninput={apply} /></label>
  <label><span>speed {speed.toFixed(2)}</span><input type="range" min="0" max="2" step="0.01" bind:value={speed} oninput={apply} /></label>
  <label><span>shape {shape.toFixed(2)}</span><input type="range" min="0" max="1" step="0.01" bind:value={shape} oninput={apply} /></label>
  <label><span>feedback {fbStrength.toFixed(2)}</span><input type="range" min="0" max="1" step="0.01" bind:value={fbStrength} oninput={apply} /></label>
  <label><span>sway {sway.toFixed(2)}</span><input type="range" min="0" max="1" step="0.01" bind:value={sway} oninput={apply} /></label>
  <label><span>particles {particles.toFixed(2)}</span><input type="range" min="0" max="1" step="0.01" bind:value={particles} oninput={apply} /></label>
  <label><span>breath cycle {breathCycle}s</span><input type="range" min="4" max="20" step="1" bind:value={breathCycle} /></label>
  <label class="row"><input type="checkbox" bind:checked={feedback} /> warp on</label>

  <div class="row">
    <span>wisp</span>
    {#each ['idle', 'session', 'pendulum', 'hidden'] as m (m)}
      <button class:on={wispMode === m} onclick={() => setWisp(m)}>{m}</button>
    {/each}
  </div>
  <div class="row">
    <span>trigger</span>
    <button onclick={drop}>drop</button>
    <button onclick={bloom}>bloom</button>
  </div>
  <div class="row">
    <span>quality</span>
    {#each ['high', 'medium', 'low'] as q (q)}
      <button class:on={quality === q} onclick={() => engine.forceQuality(q as QualityLevel)}>{q}</button>
    {/each}
    <button onclick={() => engine.forceQuality(null)}>auto</button>
  </div>
</aside>

<style>
  aside {
    position: fixed; top: var(--safe-top); right: 0; width: 240px; max-height: 100vh; overflow: auto;
    padding: 10px 12px; font-size: 12px; color: var(--silver);
    background: var(--glass-fill); backdrop-filter: blur(var(--glass-blur)); -webkit-backdrop-filter: blur(var(--glass-blur));
    border-left: 1px solid var(--glass-border); border-bottom-left-radius: var(--radius);
    display: flex; flex-direction: column; gap: 6px;
  }
  header { display: flex; justify-content: space-between; color: var(--ash); }
  label { display: flex; flex-direction: column; gap: 2px; }
  label span { color: var(--ash); }
  input[type=range] { width: 100%; accent-color: var(--blush); }
  select { background: var(--wine-deep); color: var(--silver); border: 1px solid var(--glass-border); border-radius: 6px; padding: 2px 4px; }
  .row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .row span { color: var(--ash); margin-right: 4px; }
  button { background: transparent; color: var(--silver); border: 1px solid var(--glass-border); border-radius: 999px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
  button.on { background: var(--wine); border-color: var(--blush); }
</style>
