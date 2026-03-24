# ADR-002: User Data & Settings Sync Architecture

## Status
Accepted

## Context
HypnoAI currently stores all user preferences in localStorage via `SettingsManager` (src/settings.ts). There is no session history tracking, no favorites system, and no cross-device persistence. Epic #3221 adds persistent user data that follows users across devices while maintaining the offline-first experience.

### Current localStorage Keys
- `hpyno-settings` — full HpynoSettings JSON blob (camera, tunnel, audio, experience level, etc.)
- `hpyno-calibrated` / `hpyno-calibrated-v2` — auto-calibration completion flags
- `hpyno-level-set` — experience level selection flag
- `hpyno_ambient_*` — cached Suno ambient audio (data URLs, large)

### Database Tables (from ADR-001 / Card #3224)
- `profiles` — display_name, avatar_url, experience_level (auto-created on signup)
- `user_settings` — JSONB settings blob per user
- `session_history` — tracks starts/completions with metadata
- `favorites` — saved session bookmarks

## Decision

### 1. Offline-First with Background Sync
localStorage remains the source of truth for reads. All UI reads come from localStorage — never waiting on network. When the user is authenticated and online, changes sync to Supabase in the background.

**Rationale:** A hypnosis app must never stall or show loading states during an experience. Network latency must be invisible.

### 2. Sync Direction: Bidirectional with Last-Write-Wins
- **Local → Remote:** On settings change, debounced upsert to `user_settings` (500ms debounce). On session completion, immediate insert to `session_history`. On favorite toggle, immediate upsert to `favorites`.
- **Remote → Local:** On auth state change (login/link), pull remote data and merge. Remote wins only if its `updated_at` > local `updated_at`.
- **Conflict resolution:** Last-write-wins using `updated_at` timestamps. This is acceptable because: (a) settings are a single blob, not field-level — two devices rarely edit different fields simultaneously, (b) the cost of a wrong merge is trivial (user adjusts a slider), (c) complex CRDT is overkill for this data shape.

### 3. Sync Service Pattern
Each data domain gets its own sync module following a common pattern:

```
localStorage (fast reads/writes)
  ↕ SyncService (debounce, queue, merge)
    ↕ Supabase table (persistent, cross-device)
```

Modules:
- `src/settings-sync.ts` — bridges SettingsManager ↔ user_settings table
- `src/history.ts` — session tracking + sync to session_history table
- `src/favorites.ts` — favorites + sync to favorites table

### 4. Anonymous User Handling
Anonymous users (pre-signup) get full localStorage functionality. No Supabase writes for anonymous users — sync activates only after `AuthManager.getState().isAuthenticated && !isAnonymous`. When an anonymous user links their identity (card #3232), the sync service pulls any existing remote data and merges it with local data (local wins for settings since the user has been actively using them).

### 5. Graceful Degradation
If Supabase is unreachable:
- All reads continue from localStorage (zero impact)
- Writes queue in memory and flush when connectivity returns
- No error UI shown to users — sync failures are silent (logged to console)
- Service worker (already registered via sw-register.ts) could handle offline queue in the future

### 6. Privacy & Data Ownership
- "Clear all data" button in settings: wipes localStorage + deletes all rows in user's Supabase tables
- Account deletion: calls Supabase Auth delete (cascades via RLS foreign keys)
- No analytics or tracking — session_history is user-owned, not product metrics

## Consequences
- Settings reads remain synchronous (localStorage.getItem) — no performance regression
- Users who never sign in get the exact same experience as today
- Cross-device sync adds ~2KB of JS per sync module (settings-sync, history, favorites)
- The debounce pattern means a settings change on Device A may take up to 500ms + network RTT to appear on Device B after refresh
