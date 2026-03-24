/**
 * Favorites system — localStorage-first with optional Supabase sync.
 *
 * Stores favorited session IDs in localStorage (`hpyno-favorites`).
 * When a Supabase client is available, syncs favorites to the remote
 * `favorites` table using additive merge (never removes local favs during sync).
 *
 * HMR-safe: persists via hotState.
 */

import { hotState } from './hot-state';

const STORAGE_KEY = 'hpyno-favorites';

type Listener = (favorites: string[]) => void;

export class Favorites {
  private favorites: Set<string>;
  private listeners: Set<Listener> = new Set();
  private supabase: unknown; // SupabaseClient | null — kept as unknown to avoid hard dep

  constructor(supabase: unknown) {
    this.supabase = supabase ?? null;
    this.favorites = new Set(this.loadFromStorage());
  }

  isFavorite(sessionId: string): boolean {
    return this.favorites.has(sessionId);
  }

  /** Toggle a session's favorite state. Returns the new state (true = now favorited). */
  toggle(sessionId: string): boolean {
    if (this.favorites.has(sessionId)) {
      this.favorites.delete(sessionId);
    } else {
      this.favorites.add(sessionId);
    }
    this.persist();
    this.notify();
    return this.favorites.has(sessionId);
  }

  getAll(): string[] {
    return [...this.favorites];
  }

  /** Pull remote favorites and union with local (additive — never removes local). */
  async syncFromRemote(): Promise<void> {
    if (!this.supabase) return;
    try {
      const client = this.supabase as { from: (table: string) => { select: (cols: string) => { data: Array<{ session_type: string }> | null; error: unknown } } };
      const { data, error } = await (client.from('favorites').select('session_type') as unknown as Promise<{ data: Array<{ session_type: string }> | null; error: unknown }>);
      if (error || !data) return;
      let changed = false;
      for (const row of data) {
        if (!this.favorites.has(row.session_type)) {
          this.favorites.add(row.session_type);
          changed = true;
        }
      }
      if (changed) {
        this.persist();
        this.notify();
      }
    } catch {
      // Sync failure is non-fatal — localStorage is the source of truth
    }
  }

  /** Subscribe to favorites changes. Returns unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ── Private ──

  private loadFromStorage(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      // Corrupt data — start fresh
    }
    return [];
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.favorites]));
    } catch {
      // Storage full or unavailable — best effort
    }
    this.syncToRemote();
  }

  private async syncToRemote(): Promise<void> {
    if (!this.supabase) return;
    const auth = hotState.authManager;
    const state = auth?.getState();
    if (!state?.isAuthenticated || state.isAnonymous || !state.user) return;
    const userId = state.user.id;
    try {
      const client = this.supabase as { from: (table: string) => { upsert: (rows: unknown[], opts?: unknown) => unknown; delete: () => { match: (filter: unknown) => unknown } } };
      const rows = [...this.favorites].map(sessionType => ({
        user_id: userId,
        session_type: sessionType,
      }));
      if (rows.length > 0) {
        await (client.from('favorites').upsert(rows, { onConflict: 'user_id,session_type' }) as unknown as Promise<unknown>);
      }
    } catch {
      // Remote sync is best-effort
    }
  }

  private notify(): void {
    const snapshot = this.getAll();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
