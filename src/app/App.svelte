<script lang="ts">
  import type { Engine } from '@engine/engine';
  import { router } from './router.svelte';
  import { settings } from './settings.svelte';
  import { content } from './content.svelte';
  import AgeGate from './screens/AgeGate.svelte';
  import Library from './screens/Library.svelte';
  import PlayerView from './screens/PlayerView.svelte';
  import SessionEnd from './screens/SessionEnd.svelte';
  import SettingsSheet from './screens/SettingsSheet.svelte';
  import DevPanel from './dev/DevPanel.svelte';
  import Preview from './dev/Preview.svelte';

  interface Props { engine: Engine }
  const { engine }: Props = $props();

  const route = $derived(router.current);
  const gated = $derived(!settings.value.ageConfirmed && route.name !== 'dev' && route.name !== 'preview');

  $effect(() => { void content.init(); });
  $effect(() => {
    // Idle world outside sessions; the director owns frame mode during play
    if (route.name !== 'play' && route.name !== 'preview') { engine.setFrameMode(document.hidden ? 'idle' : 'active'); }
  });
  $effect(() => {
    const onVis = (): void => { if (router.current.name !== 'play') engine.setFrameMode(document.hidden ? 'idle' : 'active'); };
    document.addEventListener('visibilitychange', onVis);
    engine.world.wisp.enterIdle();
    return () => document.removeEventListener('visibilitychange', onVis);
  });
</script>

{#if gated}
  <AgeGate />
{:else if route.name === 'library'}
  <Library {engine} />
{:else if route.name === 'session'}
  <Library {engine} selectedId={route.id} />
{:else if route.name === 'play'}
  {#key `${route.id}:${route.mode}`}
    <PlayerView {engine} id={route.id} mode={route.mode} />
  {/key}
{:else if route.name === 'end'}
  <SessionEnd id={route.id} />
{:else if route.name === 'dev'}
  <DevPanel {engine} />
{:else if route.name === 'preview'}
  {#key route.id}
    <Preview {engine} id={route.id} />
  {/key}
{/if}

{#if router.sheet === 'settings'}
  <SettingsSheet {engine} />
{/if}
