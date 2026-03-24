# ADR-001: Backend Stack Selection

**Status:** Accepted
**Date:** 2026-03-24
**Epic:** #3219 Backend Infrastructure & Database

## Context

HypnoAI is a static site (vanilla TS + Vite + Three.js) deployed to GitHub Pages. We need a backend for:
- User authentication (Google OAuth)
- Settings sync (replacing localStorage)
- Session history tracking
- Stripe payments (subscriptions + one-time purchases)
- Content gating / entitlements

Constraints:
- No framework (no React/Vue/Svelte) — client SDK must work with vanilla TS
- GitHub Pages hosting (static only) — backend must be external
- Minimal dependencies — currently only `three`, `typescript`, `vite`
- Stripe webhooks require server-side processing

## Options Evaluated

### Firebase (Firestore + Auth + Cloud Functions)
- **Pros:** Mature Google OAuth, Firestore real-time sync, generous free tier
- **Cons:** NoSQL (Firestore) is a poor fit for relational data (subscriptions, purchases, user profiles). Cloud Functions cold starts (3-5s) hurt UX. Vendor lock-in.

### Supabase (PostgreSQL + Auth + Edge Functions)
- **Pros:** Proper relational DB (SQL), built-in auth (Google OAuth), row-level security, Edge Functions for webhooks, open source (can self-host later), real-time subscriptions
- **Cons:** Edge Functions are Deno-based (different runtime), slightly less mature than Firebase

### Cloudflare Workers + D1
- **Pros:** Edge-first, ultra-low latency, cheap at scale
- **Cons:** No built-in auth — must build OAuth from scratch (security risk, weeks of work). D1 is still relatively new.

### Self-hosted (Oracle server)
- **Pros:** Full control, already have a server
- **Cons:** 957MB RAM, ops burden (backups, SSL, monitoring), single point of failure, must build everything from scratch

## Decision

**Supabase** — best fit for the constraints.

### Why Supabase over Firebase
- PostgreSQL > Firestore for structured relational data (users, subscriptions, purchases, session history)
- SQL gives us analytics/reporting for free
- RLS provides security at the DB layer, not just in client code
- Open source — exit strategy if Supabase pricing changes

### Why Supabase over Cloudflare Workers
- Built-in auth eliminates weeks of security-sensitive work
- Auth is the highest-risk component — using a battle-tested solution is worth the tradeoff

### Why not self-hosted
- Ops burden isn't justified at this stage. Can migrate to self-hosted Supabase later if needed.

## Architecture

### Deployment model
```
GitHub Pages (static)          Supabase (hosted)
┌─────────────────┐          ┌──────────────────────┐
│  Vite build     │  HTTPS   │  Auth (Google OAuth)  │
│  index.html     │ ──────── │  PostgREST (DB API)   │
│  JS/CSS/assets  │          │  Edge Functions        │
└─────────────────┘          │  PostgreSQL            │
                              └──────────────────────┘
                                       │
                              ┌────────┴────────┐
                              │  Stripe API       │
                              │  (webhooks → edge) │
                              └───────────────────┘
```

GitHub Pages stays as-is. Supabase client SDK communicates directly with Supabase's hosted services. No changes to our hosting or CI/CD (other than env vars for Supabase URL + anon key).

### Database Schema

```sql
-- User profiles (extends Supabase auth.users)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  experience_level TEXT DEFAULT 'watch',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Settings sync (replaces localStorage for logged-in users)
CREATE TABLE user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Session completion history
CREATE TABLE session_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  experience_level TEXT,
  visual_level TEXT,
  completed BOOLEAN DEFAULT false
);

-- Stripe subscriptions (written by webhooks only)
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- One-time purchases (written by webhooks only)
CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_payment_intent_id TEXT UNIQUE,
  product_key TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'eur',
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Saved favorites
CREATE TABLE favorites (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, session_key)
);
```

### Row-Level Security

All tables have RLS enabled. Users can only access their own data. Subscriptions and purchases are read-only for users (writes come from webhook Edge Functions using the service role key).

### Client SDK Integration

```typescript
// src/supabase.ts
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
```

### Integration Points in Existing Code

| File | Change | Epic |
|------|--------|------|
| `main.ts` | Initialize Supabase, check auth state | #3219 |
| `settings.ts` | Add cloud sync layer (localStorage = cache, Supabase = truth) | #3221 |
| `selector.ts` | Check entitlements, lock/unlock sessions | #3223 |
| New: `src/supabase.ts` | Client initialization + type-safe helpers | #3219 |
| New: `src/auth-ui.ts` | Login overlay, account menu | #3220 |
| New: `supabase/functions/stripe-webhook/` | Stripe event handler | #3222 |

### Anonymous-to-Authenticated Upgrade

Users can use the app without login (localStorage settings, no history sync). When they sign in:
1. Existing localStorage settings are pushed to `user_settings` as initial values
2. Future changes sync bidirectionally
3. Session history starts tracking from first authenticated session

## Consequences

- **New dependency**: `@supabase/supabase-js` (~50KB gzipped)
- **Environment variables**: Need `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in build
- **Supabase project setup**: Manual step (dashboard + CLI) before any backend code works
- **Edge Functions**: Separate deploy via Supabase CLI (not part of Vite build)
- **Cost**: Free tier covers MVP. $25/month Pro plan when we outgrow it.
