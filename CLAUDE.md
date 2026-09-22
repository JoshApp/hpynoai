# HPYNO — development notes

Immersive 3D hypnosis experiences. Vite + TypeScript + Three.js engine, Svelte 5 shell. NSFW-first product (Surrender); SFW sessions exist for engine testing and ship later under a separate brand.

## Commands

```bash
npm run dev      # Vite dev server (http://localhost:5173/hpynoai/)
npm run check    # svelte-check + eslint + vitest — must be green before deploy
npm run build    # production build → dist/
npm run pipeline -- render scripts/surrender.v3.txt   # script → ElevenLabs → public/sessions/surrender (see pipeline/)
npm run pipeline -- validate|estimate|audition|voices|account
python3 scripts/build-package-v2.py relax             # legacy builder for the old per-line audio (relax only)
```

Dev harness: open `#/dev` for live shader/preset sliders. In dev, `window.__hpyno` is the Engine and `window.__director` the active SessionDirector.

## Layout

- `src/engine/` — framework-free: `render/` (4-pass renderer, feedback warp, quality manager), `world/` (compositor + layers, wisp, palette, breath clock), `text/` (SpriteText, NarrationText), `audio/` (AudioGraph, analyser), `shaders/`.
- `src/player/` — one-clock transport: `player.ts` (stages as contiguous `<audio>` files, looping bed, gates, prebuffer), `cues.ts` (pure scheduler), `text-track.ts`, `media-session.ts`, `persistence.ts`. Testable headless via `MediaFactory`.
- `src/content/` — session package schema v2 + loader (fails loudly).
- `src/app/` — Svelte 5 UI: hash router, settings/content stores, `session-director.ts` (Player → Engine glue), screens.
- `public/sessions/<id>/session.v2.json` + audio — shipped packages. `public/sessions.json` — index.
- `content-src/` — pipeline inputs (legacy per-line voice audio + manifests). Not deployed.
- `pipeline/hpyno_pipeline/` — content pipeline v3: `script.py` (marker format, documented in its docstring), `providers.py` (ElevenLabs with timestamps + stitching, mock, content-hash cache in `content-src/cache/`), `align.py`, `assemble.py`, `dsp.py`, `bed.py`, `package.py`, `cli.py`. Tests in `pipeline/tests` (`npm run pipeline:test`).
- `scripts/` — session scripts (`*.v3.txt`) and the legacy per-line builder.

## Rules

1. **One clock.** Session position = stage start + voice element `currentTime`. Nothing else keeps time.
2. **Listen mode never touches Web Audio.** Media elements play straight to output so iOS keeps playing when locked. Only watch mode attaches elements to the AudioGraph for analysis.
3. **Gates never block.** The silent window is baked into the stage audio; answering seeks past it.
4. **World is dumb.** `src/engine` knows nothing about sessions. The director translates cues into presets, wisp modes, breath patterns, triggers.
5. **Packages are validated.** Any change to `session.v2.json` shape goes through `src/content/schema.ts` and its tests.
6. Keep `npm run check` green. Add a vitest for anything pure.

## Content

Voice: ElevenLabs (`ELEVENLABS_API_KEY` in `.env`, voice id in the script's `[VOICE: ]` header). Word timings come from the API (no transcription). Gates are spoken inline; the silent window is inserted as exact silence. Every request is cached by content hash, so edits re-render only changed segments. Cache is committed (FLAC) because renders cost credits. Legacy: SexyVoice.ai per-line audio under `content-src/audio/`.
