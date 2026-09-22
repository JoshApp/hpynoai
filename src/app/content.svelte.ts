/** Content store — session index + lazily loaded packages. */

import { loadIndex, loadPackage, type LoadedPackage } from '@content/loader';
import type { SessionSummary } from '@content/schema';
import { loadProgress, type SavedProgress } from '@player/persistence';

const DEV_ALL = import.meta.env.DEV || location.search.includes('all=1');

class ContentStore {
  sessions = $state<SessionSummary[]>([]);
  status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  error = $state<string | null>(null);
  progress = $state<SavedProgress | null>(loadProgress());

  async init(): Promise<void> {
    if (this.status === 'ready' || this.status === 'loading') return;
    this.status = 'loading';
    try {
      const idx = await loadIndex();
      // NSFW-first launch: only adult-rated sessions are public. Dev shows everything.
      this.sessions = idx.sessions.filter(s => DEV_ALL || s.rating === 'adult');
      this.status = 'ready';
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.status = 'error';
    }
  }

  summary(id: string): SessionSummary | undefined { return this.sessions.find(s => s.id === id); }

  package(id: string): Promise<LoadedPackage> { return loadPackage(id); }

  refreshProgress(): void { this.progress = loadProgress(); }
}

export const content = new ContentStore();
