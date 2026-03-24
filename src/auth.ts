/**
 * Auth module — wraps Supabase Auth with graceful degradation.
 *
 * When Supabase client is not available (env vars unset, SDK not installed),
 * all methods become no-ops and getState() returns unauthenticated.
 *
 * Singleton survives HMR via globalThis.__HPYNO_HOT_STATE__.
 */

import { log } from './logger';

// ── Types ────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
  avatar?: string;
}

export interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isAnonymous: boolean;
  loading: boolean;
}

export type AuthListener = (state: AuthState) => void;

// Minimal Supabase client interface — avoids hard dependency on @supabase/supabase-js
interface SupabaseAuthClient {
  getSession(): Promise<{ data: { session: SupabaseSession | null }; error: unknown }>;
  onAuthStateChange(cb: (event: string, session: SupabaseSession | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
  signInWithOAuth(opts: { provider: string; options?: Record<string, unknown> }): Promise<{ error: unknown }>;
  signInAnonymously(): Promise<{ data: { session: SupabaseSession | null }; error: unknown }>;
  linkIdentity(opts: { provider: string }): Promise<{ error: unknown }>;
  signOut(): Promise<{ error: unknown }>;
}

interface SupabaseSession {
  user: {
    id: string;
    email?: string;
    is_anonymous?: boolean;
    user_metadata?: {
      full_name?: string;
      name?: string;
      avatar_url?: string;
    };
  };
}

interface SupabaseLike {
  auth: SupabaseAuthClient;
}

// ── Default state ────────────────────────────────────────────────

const UNAUTHENTICATED: AuthState = Object.freeze({
  user: null,
  isAuthenticated: false,
  isAnonymous: false,
  loading: false,
});

// ── AuthManager ──────────────────────────────────────────────────

export class AuthManager {
  private _state: AuthState = { ...UNAUTHENTICATED, loading: true };
  private _listeners = new Set<AuthListener>();
  private _client: SupabaseLike | null = null;
  private _unsubscribe: (() => void) | null = null;

  /**
   * Initialize auth. Pass a Supabase client to enable authentication.
   * Without a client, auth stays in no-op mode (unauthenticated).
   */
  async init(client?: SupabaseLike | null): Promise<void> {
    if (!client) {
      log.info('auth', 'No Supabase client — auth disabled');
      this._state = { ...UNAUTHENTICATED };
      this._notify();
      return;
    }

    this._client = client;
    this._state = { ...UNAUTHENTICATED, loading: true };
    this._notify();

    // Restore existing session
    try {
      const { data, error } = await client.auth.getSession();
      if (error) {
        log.warn('auth', 'getSession error', error);
      }
      this._applySession(data.session);
    } catch (err) {
      log.error('auth', 'getSession failed', err);
      this._state = { ...UNAUTHENTICATED };
      this._notify();
    }

    // Listen for auth changes (sign-in, sign-out, token refresh)
    this._teardownListener();
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      this._applySession(session);
    });
    this._unsubscribe = () => data.subscription.unsubscribe();
  }

  /** Sign in via Google OAuth (redirect flow). */
  async signInWithGoogle(): Promise<void> {
    if (!this._client) {
      log.info('auth', 'signInWithGoogle: no client');
      return;
    }
    const { error } = await this._client.auth.signInWithOAuth({ provider: 'google' });
    if (error) log.warn('auth', 'Google sign-in error', error);
  }

  /** Create an anonymous session for first-time visitors. */
  async signInAnonymously(): Promise<void> {
    if (!this._client) {
      log.info('auth', 'signInAnonymously: no client');
      return;
    }
    const { error } = await this._client.auth.signInAnonymously();
    if (error) log.warn('auth', 'Anonymous sign-in error', error);
  }

  /** Upgrade an anonymous user by linking a Google identity. */
  async linkGoogle(): Promise<void> {
    if (!this._client) {
      log.info('auth', 'linkGoogle: no client');
      return;
    }
    const { error } = await this._client.auth.linkIdentity({ provider: 'google' });
    if (error) log.warn('auth', 'Link Google error', error);
  }

  /** Sign out the current user. */
  async signOut(): Promise<void> {
    if (!this._client) {
      log.info('auth', 'signOut: no client');
      return;
    }
    const { error } = await this._client.auth.signOut();
    if (error) log.warn('auth', 'Sign-out error', error);
  }

  /** Current auth state (reactive via onChange). */
  getState(): AuthState {
    return this._state;
  }

  /** Subscribe to auth state changes. Returns unsubscribe function. */
  onChange(listener: AuthListener): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  /** Teardown — call during HMR cleanup. */
  destroy(): void {
    this._teardownListener();
    this._listeners.clear();
  }

  // ── Internal ─────────────────────────────────────────────────

  private _applySession(session: SupabaseSession | null): void {
    if (!session) {
      this._state = { ...UNAUTHENTICATED };
    } else {
      const u = session.user;
      const meta = u.user_metadata ?? {};
      this._state = {
        user: {
          id: u.id,
          email: u.email,
          name: meta.full_name ?? meta.name,
          avatar: meta.avatar_url,
        },
        isAuthenticated: true,
        isAnonymous: !!u.is_anonymous,
        loading: false,
      };
    }
    this._notify();
  }

  private _notify(): void {
    const snapshot = this._state;
    for (const fn of this._listeners) {
      try { fn(snapshot); } catch { /* listener errors don't break auth */ }
    }
  }

  private _teardownListener(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }
}

// ── Singleton via HMR-safe global ────────────────────────────────

const HOT_KEY = '__HPYNO_HOT_STATE__';
const g = globalThis as unknown as Record<string, Record<string, unknown>>;
if (!g[HOT_KEY]) g[HOT_KEY] = {};

export const auth: AuthManager =
  (g[HOT_KEY].auth as AuthManager) ?? new AuthManager();
g[HOT_KEY].auth = auth;
// Also expose as authManager for UI consumers (selector.ts, settings.ts)
g[HOT_KEY].authManager = auth;
