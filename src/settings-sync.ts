/**
 * Settings sync — bridges SettingsManager (localStorage) with Supabase user_settings table.
 *
 * - Subscribes to SettingsManager.onChange, debounces 500ms, then upserts to remote
 * - On auth state change (login/link): pulls remote settings and merges by timestamp
 * - If Supabase client is null, all methods are no-ops
 * - Failed writes queued in memory and retried on next successful call
 */

import type { SettingsManager, HpynoSettings } from './settings';
import { hotState, type AuthState } from './hot-state';

/** Minimal Supabase client interface — just what we need for settings sync */
interface SupabaseClientLike {
  from(table: string): {
    select(columns?: string): {
      eq(column: string, value: string): {
        single(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
      };
    };
    upsert(values: Record<string, unknown>, options?: { onConflict: string }): Promise<{ error: unknown }>;
  };
}

const UPDATED_AT_KEY = 'hpyno-settings-updated-at';

export class SettingsSync {
  private supabase: SupabaseClientLike | null;
  private settingsManager: SettingsManager;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite: HpynoSettings | null = null;
  private authUnsub: (() => void) | null = null;

  constructor(supabase: SupabaseClientLike | null, settingsManager: SettingsManager) {
    this.supabase = supabase;
    this.settingsManager = settingsManager;
  }

  /** Start syncing: subscribe to settings changes + auth state changes */
  async init(): Promise<void> {
    if (!this.supabase) return;

    // Subscribe to local settings changes → debounced remote upsert
    this.settingsManager.onChange((settings) => {
      this.scheduleWrite(settings);
    });

    // Subscribe to auth state changes → pull remote on login
    const auth = hotState.authManager;
    if (auth) {
      this.authUnsub = auth.onChange((state) => {
        if (state.isAuthenticated && !state.isAnonymous && state.user) {
          this.pullAndMerge(state.user.id);
        }
      });

      // If already authenticated, pull now
      const current = auth.getState();
      if (current.isAuthenticated && !current.isAnonymous && current.user) {
        await this.pullAndMerge(current.user.id);
      }
    }
  }

  /** Stop syncing: cancel pending debounces, unsubscribe */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.authUnsub) {
      this.authUnsub();
      this.authUnsub = null;
    }
  }

  /** Schedule a debounced write to remote */
  private scheduleWrite(settings: HpynoSettings): void {
    this.pendingWrite = { ...settings };
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flushWrite();
    }, 500);
  }

  /** Flush pending write to Supabase */
  private async flushWrite(): Promise<void> {
    if (!this.supabase || !this.pendingWrite) return;

    const auth = hotState.authManager;
    if (!auth) return;
    const state = auth.getState();
    if (!state.isAuthenticated || state.isAnonymous || !state.user) return;

    const now = new Date().toISOString();
    const payload = {
      user_id: state.user.id,
      settings_json: JSON.stringify(this.pendingWrite),
      updated_at: now,
    };
    this.pendingWrite = null;

    const { error } = await this.supabase
      .from('user_settings')
      .upsert(payload, { onConflict: 'user_id' });

    if (error) {
      // Re-queue for retry on next write
      this.pendingWrite = JSON.parse(payload.settings_json);
      return;
    }

    localStorage.setItem(UPDATED_AT_KEY, now);
  }

  /** Pull remote settings and merge with local (last-write-wins by timestamp) */
  private async pullAndMerge(userId: string): Promise<void> {
    if (!this.supabase) return;

    const { data, error } = await this.supabase
      .from('user_settings')
      .select('settings_json, updated_at')
      .eq('user_id', userId)
      .single();

    if (error || !data) return; // No remote settings yet — local is authoritative

    const remoteUpdatedAt = data.updated_at as string | undefined;
    const localUpdatedAt = localStorage.getItem(UPDATED_AT_KEY);

    // Remote wins only if it has a newer timestamp
    if (remoteUpdatedAt && (!localUpdatedAt || remoteUpdatedAt > localUpdatedAt)) {
      try {
        const remoteSettings = JSON.parse(data.settings_json as string) as Partial<HpynoSettings>;
        this.settingsManager.updateBatch(remoteSettings);
        localStorage.setItem(UPDATED_AT_KEY, remoteUpdatedAt);
      } catch {
        // Invalid remote JSON — keep local
      }
    }
  }
}
