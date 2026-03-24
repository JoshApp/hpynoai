/**
 * Client-side entitlement resolver.
 * Maps Stripe subscription/purchase state to feature access.
 * Works fully offline via localStorage cache; syncs from Supabase when authenticated.
 */

// Use a loose type for Supabase client to avoid hard dependency on the SDK.
// Once #3225 lands, this can import the real SupabaseClient type.
type SupabaseClient = {
  from(table: string): {
    select(columns?: string): { data: unknown[] | null; error: unknown };
    upsert(row: unknown): { error: unknown };
  };
} | null;

export type Tier = 'free' | 'premium' | 'pro';

export type Feature = 'mic' | 'breathe' | 'immerse' | 'custom-breath';

export interface EntitlementCache {
  tier: Tier;
  unlockedSessions: string[];
  unlockedFeatures: Feature[];
  expiresAt: number;   // epoch ms
  cachedAt: number;    // epoch ms
}

type EntitlementListener = (cache: EntitlementCache) => void;

const STORAGE_KEY = 'hpyno-entitlements';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Tier matrix (hardcoded) ──────────────────────────────────────────

const FREE_SESSIONS = ['relax', 'focus'];
const FREE_FEATURES: Feature[] = [];

const PREMIUM_FEATURES: Feature[] = ['mic', 'breathe', 'immerse'];

const PRO_FEATURES: Feature[] = ['mic', 'breathe', 'immerse', 'custom-breath'];

/** All known session IDs — premium/pro unlock everything */
const ALL_SESSIONS = ['relax', 'sleep', 'surrender', 'focus'];

function sessionsForTier(tier: Tier): string[] {
  if (tier === 'free') return FREE_SESSIONS;
  return ALL_SESSIONS;
}

function featuresForTier(tier: Tier): Feature[] {
  if (tier === 'free') return FREE_FEATURES;
  if (tier === 'premium') return PREMIUM_FEATURES;
  return PRO_FEATURES;
}

function buildCache(tier: Tier, purchasedSessions: string[] = []): EntitlementCache {
  const sessions = [...new Set([...sessionsForTier(tier), ...purchasedSessions])];
  const features = featuresForTier(tier);
  const now = Date.now();
  return {
    tier,
    unlockedSessions: sessions,
    unlockedFeatures: features,
    expiresAt: now + CACHE_TTL_MS,
    cachedAt: now,
  };
}

const FREE_CACHE: EntitlementCache = buildCache('free');

// ── Entitlements class ───────────────────────────────────────────────

export class Entitlements {
  private supabase: SupabaseClient;
  private cache: EntitlementCache;
  private listeners: Set<EntitlementListener> = new Set();

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
    this.cache = this.loadFromStorage() ?? FREE_CACHE;
  }

  async init(): Promise<void> {
    if (!this.supabase) return;
    try {
      await this.refresh();
    } catch {
      // Offline or Supabase unavailable — keep cached/free tier
    }
  }

  canAccess(sessionId: string): boolean {
    return this.cache.unlockedSessions.includes(sessionId);
  }

  canUseFeature(feature: Feature): boolean {
    return this.cache.unlockedFeatures.includes(feature);
  }

  getTier(): Tier {
    return this.cache.tier;
  }

  isSessionPurchased(sessionId: string): boolean {
    // A session is "purchased" if unlocked beyond what the tier grants
    const tierSessions = sessionsForTier(this.cache.tier);
    return this.cache.unlockedSessions.includes(sessionId) && !tierSessions.includes(sessionId);
  }

  onChange(listener: EntitlementListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async refresh(): Promise<void> {
    if (!this.supabase) return;

    try {
      const sub = await this.supabase.from('subscriptions')
        .select('tier, status, expires_at');
      const purchases = await this.supabase.from('purchases')
        .select('session_id, status');

      let tier: Tier = 'free';
      const purchasedSessions: string[] = [];

      // Determine tier from active subscription
      if (sub.data && Array.isArray(sub.data)) {
        for (const row of sub.data as Array<{ tier: string; status: string; expires_at?: string }>) {
          if (row.status === 'active' || row.status === 'trialing') {
            if (row.tier === 'pro') tier = 'pro';
            else if (row.tier === 'premium' && tier !== 'pro') tier = 'premium';
          }
        }
      }

      // Collect one-time session purchases
      if (purchases.data && Array.isArray(purchases.data)) {
        for (const row of purchases.data as Array<{ session_id: string; status: string }>) {
          if (row.status === 'completed') {
            purchasedSessions.push(row.session_id);
          }
        }
      }

      const newCache = buildCache(tier, purchasedSessions);

      // Never downgrade cached tier if refresh fails is handled by the catch,
      // but also protect against stale data returning a lower tier
      if (this.tierRank(newCache.tier) >= this.tierRank(this.cache.tier) || this.isCacheExpired()) {
        this.cache = newCache;
        this.saveToStorage(newCache);
        this.notify();
      }
    } catch {
      // Network failure — keep existing cache, never downgrade
    }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private tierRank(tier: Tier): number {
    if (tier === 'pro') return 2;
    if (tier === 'premium') return 1;
    return 0;
  }

  private isCacheExpired(): boolean {
    return Date.now() > this.cache.expiresAt;
  }

  private loadFromStorage(): EntitlementCache | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as EntitlementCache;
      // Validate shape
      if (!parsed.tier || !Array.isArray(parsed.unlockedSessions)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private saveToStorage(cache: EntitlementCache): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // localStorage full or unavailable — silent fail
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.cache);
    }
  }
}
