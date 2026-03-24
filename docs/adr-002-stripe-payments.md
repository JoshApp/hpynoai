# ADR-002: Stripe Payments Architecture

**Status:** Accepted
**Date:** 2026-03-24
**Epic:** #3222 Stripe Payments — Subscriptions & One-Time Purchases

## Context

HypnoAI needs monetization: recurring subscriptions for tiered access and one-time purchases for individual content. The app is a static SPA on GitHub Pages with Supabase as backend (ADR-001).

Stripe is the payment processor. Key constraint: no card data should touch our code (PCI compliance).

## Decisions

### 1. Stripe Checkout (not Elements)

**Chosen:** Stripe Checkout (redirect mode)

Stripe Checkout redirects users to a Stripe-hosted payment page, then returns them to our app. This means:
- Zero PCI scope — no card fields in our UI
- 3D Secure, Apple Pay, Google Pay handled automatically
- Less UI code (no custom payment form)
- Trade-off: less visual customization of the payment page

Elements would give more UI control but requires handling card data, adding PCI compliance complexity for no real benefit on a content app.

### 2. Product & Price Catalog

All products and prices are created in the Stripe Dashboard (not via API). This keeps the catalog human-manageable and avoids code for product CRUD.

```
Product: "HypnoAI Premium"
  ├── Price: €9.99/month  (lookup_key: "premium_monthly")
  └── Price: €89.99/year  (lookup_key: "premium_annual")

Product: "HypnoAI Pro"
  ├── Price: €19.99/month (lookup_key: "pro_monthly")
  └── Price: €179.99/year (lookup_key: "pro_annual")

Product: "Lifetime Access"
  └── Price: €199.99 one-time (lookup_key: "lifetime")

Product: "Session Unlock"  (per-session purchases)
  └── Price: €4.99 one-time (lookup_key: "session_unlock")
       metadata: { session_id: "<id>" }  ← set at checkout time
```

**Tier mapping:**
| Tier | Access |
|------|--------|
| Free | `relax` session only, basic settings |
| Premium | All sessions, settings sync, session history |
| Pro | Everything + custom breath patterns, priority updates |
| Lifetime | Same as Pro, never expires |

### 3. Edge Functions

Three Supabase Edge Functions handle all server-side Stripe logic:

#### `create-checkout-session`
```
POST /functions/v1/create-checkout-session
Auth: Bearer <supabase-jwt>
Body: { priceKey: "premium_monthly" } or { priceKey: "session_unlock", sessionId: "erotic" }
Response: { url: "https://checkout.stripe.com/..." }
```

Logic:
1. Verify JWT → get user_id
2. Look up or create Stripe customer (store `stripe_customer_id` in `subscriptions` table)
3. Create Stripe Checkout Session with:
   - `mode: "subscription"` or `"payment"` (based on price type)
   - `success_url: "{app_url}?payment=success"`
   - `cancel_url: "{app_url}?payment=cancel"`
   - `customer: stripe_customer_id`
   - `metadata: { user_id, session_id (if applicable) }`
4. Return session URL

#### `stripe-webhook`
```
POST /functions/v1/stripe-webhook
Headers: stripe-signature: <sig>
Body: raw Stripe event
```

Events handled:
| Event | Action |
|-------|--------|
| `checkout.session.completed` | For subscriptions: upsert `subscriptions` row. For payments: insert `purchases` row. |
| `customer.subscription.updated` | Update `subscriptions.status`, `plan`, period dates |
| `customer.subscription.deleted` | Set `subscriptions.status = 'canceled'` |
| `invoice.payment_failed` | Set `subscriptions.status = 'past_due'` |

Idempotency: Store processed event IDs. Check before processing. Same event twice = no-op.

#### `create-portal-session`
```
POST /functions/v1/create-portal-session
Auth: Bearer <supabase-jwt>
Response: { url: "https://billing.stripe.com/..." }
```

Logic:
1. Verify JWT → get user_id
2. Look up `stripe_customer_id` from `subscriptions` table
3. Create Stripe Billing Portal session
4. Return portal URL

### 4. Client-Side Integration

```
User clicks "Upgrade" in selector
  → fetch /create-checkout-session with JWT
  → redirect to Stripe Checkout
  → Stripe processes payment
  → webhook fires → updates DB
  → user returns to app (?payment=success)
  → app re-reads entitlements from DB
  → selector shows unlocked sessions
```

For subscription management:
```
User clicks "Manage Subscription" in settings
  → fetch /create-portal-session with JWT
  → redirect to Stripe Customer Portal
  → user manages plan (upgrade/downgrade/cancel)
  → webhook fires → updates DB
  → user returns to app
```

### 5. Entitlement Contract

The entitlement resolver (Epic #3223) reads from the DB tables this epic populates:

```typescript
interface Entitlements {
  tier: 'free' | 'premium' | 'pro';
  isLifetime: boolean;
  unlockedSessions: string[];  // individual session purchases
  subscriptionStatus: 'active' | 'past_due' | 'canceled' | 'trialing' | null;
}
```

Resolution logic:
1. Check `subscriptions` → active subscription determines tier
2. Check `purchases` → "lifetime" purchase overrides to pro tier
3. Check `purchases` → individual "session_unlock" purchases add to `unlockedSessions`
4. Merge: highest tier wins (lifetime > pro > premium > free)

### 6. Environment Variables

```
STRIPE_SECRET_KEY          # Edge Functions only (never in client)
STRIPE_WEBHOOK_SECRET      # Edge Functions only
VITE_STRIPE_PUBLISHABLE_KEY  # Client-side (safe to expose)
```

### 7. Testing Strategy

- **Stripe Test Mode**: All development uses test API keys
- **Test Clocks**: Simulate subscription lifecycle (trial → active → past_due → canceled) without waiting
- **Webhook testing**: `stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook` for local dev
- **Test cards**: 4242424242424242 (success), 4000000000003220 (3DS required), 4000000000000341 (decline)

## Consequences

- **New dependencies**: `stripe` npm package in Edge Functions (not in client bundle)
- **Stripe Dashboard setup**: Products, prices, webhook endpoint, Customer Portal config — manual steps
- **Three Edge Functions** to deploy via Supabase CLI
- **Webhook endpoint must be publicly accessible** — Supabase Edge Functions handle this automatically
- **Dunning/recovery emails**: Use Stripe's built-in Smart Retries and failed payment emails (no custom code)
