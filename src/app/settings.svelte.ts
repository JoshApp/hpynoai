/** User settings — persisted to localStorage, reactive via runes. */

export interface Settings {
  ageConfirmed: boolean;
  voiceVolume: number;
  bedVolume: number;
  showText: boolean;
  /** 'word' = one word at a time, 'line' = karaoke line */
  textMode: 'word' | 'line';
  /** Seconds to look ahead when matching words to audio (compensates output latency) */
  textLead: number;
  textScale: number;
  motion: 'full' | 'reduced';
  quality: 'auto' | 'high' | 'medium' | 'low';
  haptics: boolean;
  reduceFlash: boolean;
}

const KEY = 'hpyno.settings.v2';

const DEFAULTS: Settings = {
  ageConfirmed: false,
  voiceVolume: 1,
  bedVolume: 0.55,
  showText: true,
  textMode: 'line',
  textLead: 0.08,
  textScale: 1,
  motion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full',
  quality: 'auto',
  haptics: true,
  reduceFlash: false,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch { return { ...DEFAULTS }; }
}

class SettingsStore {
  value = $state<Settings>(load());

  set<K extends keyof Settings>(key: K, v: Settings[K]): void {
    this.value = { ...this.value, [key]: v };
    this.persist();
  }

  reset(): void { this.value = { ...DEFAULTS }; this.persist(); }

  private persist(): void {
    try { localStorage.setItem(KEY, JSON.stringify(this.value)); } catch { /* ok */ }
  }
}

export const settings = new SettingsStore();

export function haptic(pattern: number | number[] = 12): void {
  if (!settings.value.haptics) return;
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}
