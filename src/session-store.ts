/**
 * Session Store — runtime session management.
 *
 * Sessions are JSON files served statically:
 *   public/sessions.json          — lightweight index for the selector
 *   public/sessions/{id}/session.json  — full config (loaded on demand)
 *   public/sessions/{id}/manifest.json — audio manifest (loaded by narration)
 *   public/sessions/{id}/*.mp3         — audio files
 *
 * The pipeline creates session packages. The app loads them at runtime.
 * No build-time imports — sessions can be added without rebuilding.
 */

import type { SessionConfig, SessionTheme } from './session';
import { log } from './logger';

// ── Types ──

export interface SessionSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  contentWarning: string | null;
  photoWarning: boolean;
  themePreview: {
    primaryColor: [number, number, number];
    secondaryColor: [number, number, number];
    accentColor: [number, number, number];
    bgColor: [number, number, number];
    particleColor: [number, number, number];
    textColor: string;
    textGlow: string;
    breatheColor: string;
    tunnelShape?: number;
  };
}

interface SessionIndex {
  version: number;
  sessions: SessionSummary[];
}

// ── Store ──

class SessionStore {
  private index: SessionIndex | null = null;
  private cache = new Map<string, SessionConfig>();
  private loading = new Map<string, Promise<SessionConfig | null>>();

  /** Fetch the session index. Call once at app startup. */
  async loadIndex(): Promise<SessionSummary[]> {
    try {
      const resp = await fetch('sessions.json');
      if (!resp.ok) throw new Error(`${resp.status}`);
      this.index = await resp.json();
      log.info('session-store', `Loaded ${this.index!.sessions.length} sessions`);
      return this.index!.sessions;
    } catch (e) {
      log.warn('session-store', 'Failed to load session index', e);
      return [];
    }
  }

  /** Get all session summaries (requires loadIndex first). */
  getSummaries(): SessionSummary[] {
    return this.index?.sessions ?? [];
  }

  /** Fetch the full SessionConfig for a session. Caches after first load. */
  async getSession(id: string): Promise<SessionConfig | null> {
    // Return cached
    const cached = this.cache.get(id);
    if (cached) return cached;

    // Return in-flight request
    const inflight = this.loading.get(id);
    if (inflight) return inflight;

    // Fetch
    const promise = this.fetchSession(id);
    this.loading.set(id, promise);
    try {
      const config = await promise;
      if (config) this.cache.set(id, config);
      return config;
    } finally {
      this.loading.delete(id);
    }
  }

  /** Get cached session (sync — for HMR restore). */
  getCached(id: string): SessionConfig | undefined {
    return this.cache.get(id);
  }

  /** Pre-populate cache (for migration from hardcoded sessions). */
  register(config: SessionConfig): void {
    this.cache.set(config.id, config);
  }

  private async fetchSession(id: string): Promise<SessionConfig | null> {
    try {
      const resp = await fetch(`sessions/${id}/session.json`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const config: SessionConfig = await resp.json();
      log.info('session-store', `Loaded session: ${config.name}`);
      return config;
    } catch (e) {
      log.warn('session-store', `Failed to load session ${id}`, e);
      return null;
    }
  }
}

export const sessionStore = new SessionStore();
