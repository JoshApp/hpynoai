/**
 * Structured observability for HPYNO.
 *
 * - Ring buffer of recent log entries in memory (fast, per-frame safe)
 * - Persists to IndexedDB on page unload + periodic flush
 * - Survives tab close, crashes, browser restarts
 * - `hpyno.dump()` / `hpyno.timeline()` in console for live debugging
 * - `hpyno.history()` to load previous sessions from IndexedDB
 * - `hpyno.download()` to save a .jsonl log file
 */

// ── Types ────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  t: number;       // performance.now() ms
  wall: string;    // ISO timestamp for human reading
  level: LogLevel;
  tag: string;     // subsystem: 'audio', 'narration', 'bus', etc.
  msg: string;
  data?: unknown;  // structured payload (kept by reference, not cloned)
}

/** A stored session log block in IndexedDB. */
interface SessionLog {
  /** Unique key: ISO timestamp of when the page loaded */
  sessionStart: string;
  /** When this block was last flushed */
  lastFlush: string;
  /** The log entries (info+ only — debug is too noisy to persist) */
  entries: LogEntry[];
}

// ── Config ───────────────────────────────────────────────────────

const MAX_ENTRIES = 2000;
const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Events that fire every frame — log at debug level to avoid flooding
const HIGH_FREQ_EVENTS = new Set([
  'input:pointer-move',
]);

// IndexedDB config
const DB_NAME = 'hpyno-logs';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';
const MAX_STORED_SESSIONS = 20;        // keep last 20 page loads
const FLUSH_INTERVAL_MS = 30_000;      // flush to IDB every 30s
const PERSIST_MIN_LEVEL: LogLevel = 'info'; // don't persist debug to disk

// ── IndexedDB helpers ────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sessionStart' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writeSession(session: SessionLog): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(session);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function readAllSessions(): Promise<SessionLog[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function pruneOldSessions(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const req = store.getAllKeys();
  req.onsuccess = () => {
    const keys = req.result as string[];
    // Keys are ISO timestamps — sort ascending, delete oldest
    keys.sort();
    const toDelete = keys.slice(0, Math.max(0, keys.length - MAX_STORED_SESSIONS));
    for (const key of toDelete) {
      store.delete(key);
    }
  };
  tx.oncomplete = () => db.close();
}

// ── Logger ───────────────────────────────────────────────────────

class Logger {
  private entries: LogEntry[] = [];
  private _minLevel: LogLevel = 'debug';
  private _consoleMirror: LogLevel = 'info';

  // Persistence state
  private readonly sessionStart = new Date().toISOString();
  private lastFlushedIndex = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private idbAvailable = typeof indexedDB !== 'undefined';

  constructor() {
    this.startPeriodicFlush();
    this.installUnloadHook();
  }

  /** Current minimum level for storing entries. */
  get minLevel(): LogLevel { return this._minLevel; }
  set minLevel(l: LogLevel) { this._minLevel = l; }

  /** Current minimum level for console output. */
  get consoleMirror(): LogLevel { return this._consoleMirror; }
  set consoleMirror(l: LogLevel) { this._consoleMirror = l; }

  private shouldStore(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this._minLevel];
  }

  private shouldMirror(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this._consoleMirror];
  }

  // ── Core write ──

  private write(level: LogLevel, tag: string, msg: string, data?: unknown): void {
    if (!this.shouldStore(level)) return;

    const entry: LogEntry = {
      t: performance.now(),
      wall: new Date().toISOString(),
      level,
      tag,
      msg,
      data: data !== undefined ? data : undefined,
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      // Shift out oldest entries, adjust flush cursor
      const removed = this.entries.length - MAX_ENTRIES;
      this.entries.splice(0, removed);
      this.lastFlushedIndex = Math.max(0, this.lastFlushedIndex - removed);
    }

    if (this.shouldMirror(level)) {
      const prefix = `[${tag}]`;
      const consoleFn = level === 'error' ? console.error
        : level === 'warn' ? console.warn
        : console.log;
      if (data !== undefined) {
        consoleFn(prefix, msg, data);
      } else {
        consoleFn(prefix, msg);
      }
    }
  }

  // ── Public API ──

  debug(tag: string, msg: string, data?: unknown): void { this.write('debug', tag, msg, data); }
  info(tag: string, msg: string, data?: unknown): void { this.write('info', tag, msg, data); }
  warn(tag: string, msg: string, data?: unknown): void { this.write('warn', tag, msg, data); }
  error(tag: string, msg: string, data?: unknown): void { this.write('error', tag, msg, data); }

  // ── Bus event hook (called from EventBus.emit) ──

  logBusEvent(event: string, payload: unknown): void {
    const level = HIGH_FREQ_EVENTS.has(event) ? 'debug' : 'info';
    this.write(level, 'bus', event, payload);
  }

  // ── Dump / inspect (in-memory, current page load) ──

  /** Return all stored entries (newest last). */
  dump(filter?: { level?: LogLevel; tag?: string; last?: number }): LogEntry[] {
    let result = this.entries;

    if (filter?.level) {
      const minP = LEVEL_PRIORITY[filter.level];
      result = result.filter(e => LEVEL_PRIORITY[e.level] >= minP);
    }
    if (filter?.tag) {
      const tag = filter.tag;
      result = result.filter(e => e.tag === tag);
    }
    if (filter?.last) {
      result = result.slice(-filter.last);
    }

    return result;
  }

  /** Pretty-print a chronological timeline to the console. */
  timeline(filter?: { level?: LogLevel; tag?: string; last?: number }): void {
    const entries = this.dump(filter);
    if (entries.length === 0) {
      console.log('(no entries)');
      return;
    }

    const t0 = entries[0].t;
    console.group(`HPYNO Timeline (${entries.length} entries)`);
    for (const e of entries) {
      const elapsed = ((e.t - t0) / 1000).toFixed(2);
      const levelBadge = e.level === 'error' ? '!' : e.level === 'warn' ? '?' : e.level === 'info' ? '*' : '.';
      const line = `${elapsed}s ${levelBadge} [${e.tag}] ${e.msg}`;
      if (e.data !== undefined) {
        console.log(line, e.data);
      } else {
        console.log(line);
      }
    }
    console.groupEnd();
  }

  /** Return only errors and warnings — the stuff you want after a crash. */
  errors(last = 50): LogEntry[] {
    return this.dump({ level: 'warn', last });
  }

  /** Return entries for a specific subsystem. */
  forTag(tag: string, last = 100): LogEntry[] {
    return this.dump({ tag, last });
  }

  /** Export current session as JSON string (for pasting into bug reports). */
  toJSON(last = 500): string {
    return JSON.stringify(this.dump({ last }), null, 2);
  }

  /** Clear in-memory entries. */
  clear(): void {
    this.entries.length = 0;
    this.lastFlushedIndex = 0;
  }

  /** Entry count. */
  get size(): number {
    return this.entries.length;
  }

  // ── Persistence: IndexedDB ─────────────────────────────────────

  /** Flush new entries to IndexedDB. Only persists info+ (skips debug). */
  async flush(): Promise<void> {
    if (!this.idbAvailable) return;

    // Collect entries that haven't been flushed yet, filtering to persist-worthy levels
    const minP = LEVEL_PRIORITY[PERSIST_MIN_LEVEL];
    const newEntries = this.entries
      .slice(this.lastFlushedIndex)
      .filter(e => LEVEL_PRIORITY[e.level] >= minP)
      .map(e => ({
        ...e,
        // Serialize data — IDB can't store functions, DOM nodes, etc.
        data: e.data !== undefined ? safeSerialize(e.data) : undefined,
      }));

    this.lastFlushedIndex = this.entries.length;

    if (newEntries.length === 0) return;

    try {
      // Read existing session log (if any from a previous flush this session)
      const db = await openDB();
      const existing = await new Promise<SessionLog | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(this.sessionStart);
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = () => { db.close(); reject(req.error); };
      });

      const session: SessionLog = {
        sessionStart: this.sessionStart,
        lastFlush: new Date().toISOString(),
        entries: [...(existing?.entries ?? []), ...newEntries],
      };

      await writeSession(session);
      await pruneOldSessions();
    } catch {
      // IDB can fail (private browsing, quota) — silently degrade
    }
  }

  private startPeriodicFlush(): void {
    if (!this.idbAvailable) return;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  private installUnloadHook(): void {
    if (typeof window === 'undefined') return;

    // visibilitychange is more reliable than beforeunload on mobile
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') {
        this.flush();
      }
    };
    document.addEventListener('visibilitychange', flushOnHide);

    // beforeunload as a backup for desktop
    window.addEventListener('beforeunload', () => {
      this.flush();
    });
  }

  /**
   * Load logs from previous page sessions stored in IndexedDB.
   * Returns most recent first.
   */
  async history(lastN = 5): Promise<SessionLog[]> {
    if (!this.idbAvailable) return [];
    try {
      const all = await readAllSessions();
      all.sort((a, b) => b.sessionStart.localeCompare(a.sessionStart));
      return all.slice(0, lastN);
    } catch {
      return [];
    }
  }

  /**
   * Load and pretty-print previous session logs.
   * Call from console: `await hpyno.history()`
   */
  async printHistory(lastN = 3): Promise<void> {
    const sessions = await this.history(lastN);
    if (sessions.length === 0) {
      console.log('No previous session logs found.');
      return;
    }

    for (const session of sessions) {
      const count = session.entries.length;
      const errors = session.entries.filter(e => e.level === 'error').length;
      const warns = session.entries.filter(e => e.level === 'warn').length;
      console.group(
        `Session ${session.sessionStart} (${count} entries, ${errors} errors, ${warns} warnings, last flush: ${session.lastFlush})`
      );
      for (const e of session.entries) {
        const levelBadge = e.level === 'error' ? '!' : e.level === 'warn' ? '?' : '*';
        const line = `${e.wall} ${levelBadge} [${e.tag}] ${e.msg}`;
        if (e.data !== undefined) {
          console.log(line, e.data);
        } else {
          console.log(line);
        }
      }
      console.groupEnd();
    }
  }

  /** Download all stored logs (current + history) as a .jsonl file. */
  async download(): Promise<void> {
    // Flush current session first
    await this.flush();

    const sessions = await this.history(MAX_STORED_SESSIONS);
    // Reverse to chronological order (oldest first)
    sessions.reverse();

    const lines: string[] = [];
    for (const session of sessions) {
      // Session header
      lines.push(JSON.stringify({
        _type: 'session',
        sessionStart: session.sessionStart,
        lastFlush: session.lastFlush,
        entryCount: session.entries.length,
      }));
      for (const entry of session.entries) {
        lines.push(JSON.stringify(entry));
      }
    }

    const blob = new Blob([lines.join('\n')], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hpyno-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Wipe all stored history from IndexedDB. */
  async clearHistory(): Promise<void> {
    if (!this.idbAvailable) return;
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => db.close();
    } catch {
      // ignore
    }
  }
}

// ── Safe serialization ───────────────────────────────────────────

/** Safely serialize data for IndexedDB (handles circular refs, DOM nodes, etc.) */
function safeSerialize(data: unknown): unknown {
  try {
    // structuredClone handles most cases and is what IDB uses internally
    // But we want to strip anything that can't survive a round-trip
    const json = JSON.stringify(data, (_key, value) => {
      if (value instanceof HTMLElement) return `[HTMLElement: ${value.tagName}]`;
      if (value instanceof AudioContext) return '[AudioContext]';
      if (typeof value === 'function') return undefined;
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      return value;
    });
    return JSON.parse(json);
  } catch {
    return String(data);
  }
}

// ── Singleton ────────────────────────────────────────────────────

export const log = new Logger();

// ── Global access for debugging ──────────────────────────────────

const debug = {
  log,
  dump: (f?: Parameters<Logger['dump']>[0]) => log.dump(f),
  timeline: (f?: Parameters<Logger['timeline']>[0]) => log.timeline(f),
  errors: (n?: number) => log.errors(n),
  toJSON: (n?: number) => log.toJSON(n),
  history: (n?: number) => log.printHistory(n),
  download: () => log.download(),
  clearHistory: () => log.clearHistory(),
};

(window as unknown as Record<string, unknown>).hpyno = debug;
