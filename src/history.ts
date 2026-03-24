/**
 * Session history tracker — records session starts/completions/aborts in localStorage.
 * Syncs to Supabase `session_history` table when authenticated.
 *
 * Works fully offline. Supabase client is optional (null = local-only mode).
 */

import { log } from './logger';

// ── Types ────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string;               // UUID
  sessionId: string;        // which session config was run
  startedAt: number;        // epoch ms
  completedAt?: number;     // epoch ms (set on normal completion)
  abortedAt?: number;       // epoch ms (set on early exit)
  durationMs?: number;      // total duration
  stagesReached: number;    // how far the user got
  synced: boolean;          // whether this entry has been pushed to remote
}

// Minimal Supabase interface — avoids hard dependency
interface SupabaseLike {
  from(table: string): {
    insert(rows: Record<string, unknown>[]): { select(): Promise<{ error: unknown }> };
    select(cols?: string): { eq(col: string, val: unknown): Promise<{ data: SupabaseHistoryRow[] | null; error: unknown }> };
    upsert(rows: Record<string, unknown>[], opts?: { onConflict: string }): Promise<{ error: unknown }>;
  };
  auth: { getUser(): Promise<{ data: { user: { id: string } | null } }> };
}

interface SupabaseHistoryRow {
  id: string;
  session_id: string;
  started_at: string;
  completed_at: string | null;
  aborted_at: string | null;
  duration_ms: number | null;
  stages_reached: number;
}

// ── Constants ────────────────────────────────────────────────────

const STORAGE_KEY = 'hpyno-history';
const MAX_LOCAL_ENTRIES = 500;

// ── SessionHistory ───────────────────────────────────────────────

export class SessionHistory {
  private _supabase: SupabaseLike | null;
  private _entries: HistoryEntry[];

  constructor(supabase: SupabaseLike | null = null) {
    this._supabase = supabase;
    this._entries = this._load();
  }

  /** Record a session start. Returns the history entry ID. */
  recordStart(sessionId: string): string {
    const id = crypto.randomUUID();
    const entry: HistoryEntry = {
      id,
      sessionId,
      startedAt: Date.now(),
      stagesReached: 0,
      synced: false,
    };
    this._entries.unshift(entry);
    this._trim();
    this._save();
    log.info('history', `Session started: ${sessionId}`, { entryId: id });
    this._syncEntry(entry);
    return id;
  }

  /** Record normal session completion. */
  recordComplete(entryId: string, meta: { stagesReached: number }): void {
    const entry = this._entries.find(e => e.id === entryId);
    if (!entry) { log.warn('history', `Entry not found: ${entryId}`); return; }
    entry.completedAt = Date.now();
    entry.durationMs = entry.completedAt - entry.startedAt;
    entry.stagesReached = meta.stagesReached;
    entry.synced = false;
    this._save();
    log.info('history', `Session completed: ${entry.sessionId}`, { duration: entry.durationMs, stages: meta.stagesReached });
    this._syncEntry(entry);
  }

  /** Record early session exit. */
  recordAbort(entryId: string, meta: { stagesReached: number }): void {
    const entry = this._entries.find(e => e.id === entryId);
    if (!entry) { log.warn('history', `Entry not found: ${entryId}`); return; }
    entry.abortedAt = Date.now();
    entry.durationMs = entry.abortedAt - entry.startedAt;
    entry.stagesReached = meta.stagesReached;
    entry.synced = false;
    this._save();
    log.info('history', `Session aborted: ${entry.sessionId}`, { stages: meta.stagesReached });
    this._syncEntry(entry);
  }

  /** All history entries, newest first. */
  getHistory(): HistoryEntry[] {
    return [...this._entries];
  }

  /** Number of completed sessions for a given session type. */
  getCompletionCount(sessionId: string): number {
    return this._entries.filter(e => e.sessionId === sessionId && e.completedAt != null).length;
  }

  /** Consecutive days with at least one completion (streak). */
  getStreak(): number {
    const completions = this._entries
      .filter(e => e.completedAt != null)
      .map(e => this._dayKey(e.completedAt!));

    if (completions.length === 0) return 0;

    const uniqueDays = [...new Set(completions)].sort().reverse();
    const today = this._dayKey(Date.now());

    // Streak must include today or yesterday to be active
    if (uniqueDays[0] !== today && uniqueDays[0] !== this._dayKey(Date.now() - 86400000)) return 0;

    let streak = 1;
    for (let i = 1; i < uniqueDays.length; i++) {
      const prev = new Date(uniqueDays[i - 1] + 'T00:00:00');
      const curr = new Date(uniqueDays[i] + 'T00:00:00');
      const diffDays = (prev.getTime() - curr.getTime()) / 86400000;
      if (diffDays === 1) streak++;
      else break;
    }
    return streak;
  }

  /** Pull remote history and merge with local. */
  async syncFromRemote(): Promise<void> {
    if (!this._supabase) return;

    try {
      const { data: userData } = await this._supabase.auth.getUser();
      if (!userData.user) return;

      const { data, error } = await this._supabase
        .from('session_history')
        .select()
        .eq('user_id', userData.user.id);

      if (error) { log.warn('history', 'Remote fetch failed', error); return; }
      if (!data || data.length === 0) return;

      // Merge: add remote entries not in local
      const localIds = new Set(this._entries.map(e => e.id));
      for (const row of data) {
        if (!localIds.has(row.id)) {
          this._entries.push({
            id: row.id,
            sessionId: row.session_id,
            startedAt: new Date(row.started_at).getTime(),
            completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined,
            abortedAt: row.aborted_at ? new Date(row.aborted_at).getTime() : undefined,
            durationMs: row.duration_ms ?? undefined,
            stagesReached: row.stages_reached,
            synced: true,
          });
        }
      }

      // Re-sort newest first and save
      this._entries.sort((a, b) => b.startedAt - a.startedAt);
      this._trim();
      this._save();
      log.info('history', `Merged ${data.length} remote entries`);
    } catch (err) {
      log.error('history', 'syncFromRemote failed', err);
    }
  }

  // ── Internal ─────────────────────────────────────────────────

  private _load(): HistoryEntry[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private _save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._entries));
    } catch {
      log.warn('history', 'localStorage write failed');
    }
  }

  private _trim(): void {
    if (this._entries.length > MAX_LOCAL_ENTRIES) {
      this._entries.length = MAX_LOCAL_ENTRIES;
    }
  }

  private _dayKey(epochMs: number): string {
    return new Date(epochMs).toISOString().slice(0, 10);
  }

  private async _syncEntry(entry: HistoryEntry): Promise<void> {
    if (!this._supabase) return;
    try {
      const { data: userData } = await this._supabase.auth.getUser();
      if (!userData.user) return;

      const row = {
        id: entry.id,
        user_id: userData.user.id,
        session_id: entry.sessionId,
        started_at: new Date(entry.startedAt).toISOString(),
        completed_at: entry.completedAt ? new Date(entry.completedAt).toISOString() : null,
        aborted_at: entry.abortedAt ? new Date(entry.abortedAt).toISOString() : null,
        duration_ms: entry.durationMs ?? null,
        stages_reached: entry.stagesReached,
      };

      const { error } = await this._supabase
        .from('session_history')
        .upsert([row], { onConflict: 'id' });

      if (error) {
        log.warn('history', 'Sync failed', error);
      } else {
        entry.synced = true;
        this._save();
      }
    } catch {
      // Offline — will sync on next login via syncFromRemote
    }
  }
}

// ── Singleton via HMR-safe global ────────────────────────────────

const HOT_KEY = '__HPYNO_HOT_STATE__';
const g = globalThis as unknown as Record<string, Record<string, unknown>>;
if (!g[HOT_KEY]) g[HOT_KEY] = {};

export const sessionHistory: SessionHistory =
  (g[HOT_KEY].sessionHistory as SessionHistory) ?? new SessionHistory();
g[HOT_KEY].sessionHistory = sessionHistory;
