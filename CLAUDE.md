# HypnoAI — Development Instructions

Browser-based immersive hypnosis engine. Three.js + vanilla TypeScript + Vite. No frameworks.

## Branch Strategy

- **All work targets `dev`** — feature branches created from dev, PRs merge into dev
- **NEVER touch `main`** — no pushes, merges, rebases, or modifications to main

## Commands

```bash
npm run dev      # Vite dev server (port 5173) with HMR
npm run build    # tsc + vite build → dist/
npm run preview  # Preview production build
```

## Architecture

### Core Loop

`main.ts` bootstraps everything: Three.js renderer, audio, narration, timeline, then runs `requestAnimationFrame` loop. Each frame reads state from subsystems (timeline, breath, audio analyzer) and pushes uniforms to shaders.

### State Management — Three Rules

1. **Pull model**: Timeline is the source of truth. Read `timeline.getState(position)` every frame — never push state via callbacks. Self-healing by design.
2. **Epoch guards**: Every async operation must capture `machine.epoch` before awaiting, then check `machine.guard(startEpoch)` after — bail if phase changed.
3. **HMR persistence**: Subsystems live in `globalThis.__HPYNO_HOT_STATE__`. Don't reinitialize what survives reload (renderer, scene, camera, audio context).

### Key Subsystems

| System | File | Role |
|--------|------|------|
| State machine | `state-machine.ts` | Phase transitions (boot→selector→session→ending) with epoch guard |
| Timeline | `timeline.ts` | Block-based session flow (narration/breathing/interaction/transition) |
| Tunnel shader | `shaders/tunnel.frag` | 40+ uniforms, audio-reactive, breath-synced |
| Feedback warp | `feedback.ts` | Milkdrop ping-pong RT, auto-disables <28 FPS |
| Audio engine | `audio.ts` | Binaural beats + drone synthesis via Web Audio API |
| Narration | `narration.ts` | Pre-recorded audio (SexyVoice.ai manifest) with TTS fallback |
| Text3D | `text3d.ts` | Three render modes: floating karaoke, static slots, focus (single-word) |
| Breath | `breath.ts` | Box breathing controller, cosine-eased 0-1 output |
| Interactions | `interactions.ts` | QTE system: breath-sync, gates, countdown, hum-sync, affirm |
| Presence | `presence.ts` | Wisp entity, 7 movement modes, shader-driven |
| Selector | `selector.ts` | Carousel UI for session selection |
| Settings | `settings.ts` | localStorage persistence, UI panel |

### Session Structure

Sessions (`src/sessions/*.ts`) define:
- `SessionConfig` → stages, audio profile, theme colors, interactions
- Each `SessionStage` has: duration, intensity, texts, breathCycle, spiralSpeed, interactions
- Timeline converts stages into typed blocks (narration/breathing/interaction/transition)

### Shader Architecture

- `.vert/.frag` files in `src/shaders/`, imported as strings via Vite plugin in `vite.config.ts`
- `tunnel.frag` — main visual (polar-space depth mapping, audio reactivity, breath sync)
- `feedback.frag` — Milkdrop warp (ping-pong render targets)
- `presence.frag` — wisp entity
- HMR: shader changes hot-reload (`material.needsUpdate = true`)

### Audio Pipeline

```
binaural (L/R oscillators) ─┐
drone (sine + triangle + LFO) ─┤── analyzer ── destination
narration (HTMLAudioElement) ─┘
ambient (pad + noise + reverb) ─┘
```

Analyzer provides per-frame frequency bands (bass/low_mid/mid/high_mid/high) read by render pipeline.

### Pre-recorded Narration

Audio manifests at `public/audio/{session}/manifest.json` map text → WAV files + word-level timestamps (from Whisper). Narration engine matches script text to manifest, plays audio, emits word timings for karaoke sync. Falls back to browser TTS if no match.

## Key Patterns

- **Adding a session**: Copy `src/sessions/relax.ts`, define stages + audio profile + theme. Export from `src/sessions/index.ts`.
- **Adding interactions**: Define in session stage config (`interactions[]`), InteractionManager renders them automatically.
- **Shader tweaks**: Edit `.frag` files, HMR reloads. Use DevMode (backtick key) to preview intensity and scrub timeline.
- **New text mode**: Text3D has three modes (floating, static slots, focus). Pick the right one for the UX.
- **Audio**: All narration is pre-generated. No runtime AI calls. Audio files ship with the build.

## Gotchas

- Never edit timeline state directly — it derives everything from position
- Async race conditions: always use epoch guards, never assume phase hasn't changed
- `hotState` survives HMR — check before reinitializing subsystems
- Feedback warp uses ping-pong render targets — never read and write same target
- CanvasTexture for text must call `texture.needsUpdate = true` after redraw
- GPU particles are disabled (baked into tunnel shader instead)
- Build output must be static-site compatible (GitHub Pages hosting)

## Dev Tools

- **DevMode** (backtick or `?dev`): Timeline scrubbing, intensity override, FPS, speed multiplier
- **Timebar** (T key): Visual timeline progress bar
- **URL params**: `?minimal` for reduced visuals, `?dev` for debug panel

## Supabase (local)

Requires Docker running.

```bash
npm run supabase:start   # Start local Supabase (Postgres, Auth, Edge Functions)
npm run supabase:stop    # Stop local Supabase
npm run supabase:reset   # Drop DB + re-run all migrations + seed
```

After `supabase:start`, the CLI prints the local URLs and keys:

| Service       | URL                          |
|---------------|------------------------------|
| API           | http://127.0.0.1:54321       |
| Studio        | http://127.0.0.1:54323       |
| Inbucket      | http://127.0.0.1:54324       |
| DB (Postgres) | postgresql://postgres:postgres@127.0.0.1:54322/postgres |

Copy the `anon key` from the output into `.env`:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<anon-key>
```

## Migrations

SQL migration files live in `supabase/migrations/`. To create a new migration:

```bash
npx supabase migration new <name>
# Edit the generated .sql file, then:
npm run supabase:reset   # Apply from scratch
```
