# ADR-003: Content Gating & Entitlement Engine

## Status
Accepted

## Context
HypnoAI needs to connect Stripe payments (Epic #3222) to the app experience. Users should see what's available, understand what's locked, and upgrade seamlessly. The gating must be offline-resilient — a paying user must never be blocked by a network issue.

### Current Sessions
- `relax` — Ericksonian relaxation
- `sleep` — sleep induction
- `erotic` — erotic hypnosis (age-gated)
- `focus` — alpha-state concentration

### Payment Models (from ADR/Epic #3222)
- **Subscriptions:** Monthly/annual plans (free → premium → pro)
- **One-time purchases:** Individual session or content pack unlocks

## Decision

### 1. Tier Matrix

| Feature | Free | Premium | Pro |
|---------|------|---------|-----|
| Sessions: relax, focus | Yes | Yes | Yes |
| Sessions: sleep, erotic, future | No | Yes | Yes |
| Experience levels: listen, watch | Yes | Yes | Yes |
| Experience levels: breathe, immerse | No | Yes | Yes |
| Microphone / voice features | No | Yes | Yes |
| Custom breath patterns | No | No | Yes |
| Session history & favorites | Yes | Yes | Yes |
| Settings sync (cross-device) | No | Yes | Yes |

**Free tier philosophy:** Give enough to demonstrate value. Relax + Focus at listen/watch level is a complete experience. Users hit the gate when they try breathe/immerse mode or locked sessions.

**One-time purchases** override tier for specific items. E.g., buying "sleep session" unlocks sleep regardless of subscription tier. These are stored in the `purchases` table.

### 2. Entitlement Resolution

```
Client reads:
  1. localStorage cache ("hpyno-entitlements") — always available, may be stale
  2. Supabase subscriptions + purchases tables — authoritative when reachable

Resolution order (on app boot / auth change):
  1. Read localStorage cache → use immediately for UI rendering
  2. Fetch remote entitlements in background
  3. If remote differs → update localStorage cache + re-render UI

Entitlement shape:
  {
    tier: "free" | "premium" | "pro",
    unlockedSessions: string[],        // from one-time purchases
    unlockedFeatures: string[],        // from one-time purchases
    expiresAt: string | null,          // subscription end date (ISO)
    cachedAt: string,                  // when this was last verified
  }
```

### 3. Gating UX

**Selector (session orbs):**
- Free sessions: normal orb, fully clickable
- Locked sessions: orb visible with a small lock icon overlay, slightly dimmed
- Clicking a locked session: shows preview (description, theme colors) + upgrade prompt
- Never hide locked sessions — users should see what's available

**Experience level picker (settings panel):**
- Free levels (listen, watch): normal buttons
- Locked levels (breathe, immerse): buttons visible but with lock icon, click shows upgrade prompt

**Upgrade prompt:**
- Overlay/modal, not a page navigation (don't lose the immersive context)
- Shows: what they're trying to access, what tier unlocks it, pricing
- Two CTAs: "Subscribe" (Stripe Checkout redirect), "Buy this session" (one-time purchase, if applicable)
- Dismissible — never trap the user

**Session end:**
- After a free session completes, optionally show a gentle "unlock more" prompt
- Not on every session — maybe every 3rd completion, or only if they haven't dismissed recently

### 4. Offline Resilience

- Entitlements cached in localStorage with `cachedAt` timestamp
- Cache TTL: 7 days. After 7 days without refresh, still honor the cache but log a warning
- **Critical rule:** Never downgrade a user's access based on stale cache. If cached tier is "premium" but refresh fails, keep showing "premium" until refresh succeeds.
- If user has no cache and no network: default to "free" tier (safe default for new installs)

### 5. Implementation Modules

1. **`src/entitlements.ts`** — Core resolver. Reads cache, fetches remote, merges, exposes `canAccess(sessionId)`, `canUseFeature(feature)`, `getTier()`, `onChange(listener)`
2. **`src/selector.ts` updates** — Lock icons on orbs, click-to-preview-locked, integration with entitlements
3. **`src/upgrade-prompt.ts`** — Overlay component shown when accessing locked content, links to Stripe Checkout

## Consequences
- Free users see the full catalog, creating aspiration without frustration
- Locked content is always visible (never hidden) — this drives conversion
- Offline users retain their tier — the 7-day cache ensures paying users are never wrongly gated
- One-time purchases add complexity but enable users who prefer not to subscribe
- The tier matrix is hardcoded in the client — tier definitions change via code deploys, not config
