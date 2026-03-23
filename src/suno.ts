/**
 * Suno AI music generation — generates ambient background tracks for sessions.
 * Requires a Suno API key stored in localStorage or environment.
 *
 * Usage:
 *   const suno = new SunoGenerator();
 *   suno.setApiKey('your-api-key');
 *   const url = await suno.generate({
 *     prompt: 'dark sensual ambient drone, no vocals, warm pads, slow, loopable',
 *     duration: 120,
 *   });
 */

import { log } from './logger';

const SUNO_API_BASE = 'https://studio-api.suno.ai/api';
const LOCAL_STORAGE_KEY = 'hpyno_suno_api_key';

export interface SunoGenerateOptions {
  prompt: string;
  duration?: number;       // seconds (default 120)
  instrumental?: boolean;  // no vocals (default true)
}

export interface SunoTrack {
  id: string;
  audioUrl: string;
  title: string;
  status: string;
}

export class SunoGenerator {
  private apiKey: string | null = null;

  constructor() {
    // Try to load from localStorage
    this.apiKey = localStorage.getItem(LOCAL_STORAGE_KEY);
  }

  get hasKey(): boolean {
    return !!this.apiKey;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    localStorage.setItem(LOCAL_STORAGE_KEY, key);
  }

  clearApiKey(): void {
    this.apiKey = null;
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  }

  /**
   * Generate an ambient track via Suno API.
   * Returns the audio URL when ready.
   */
  async generate(options: SunoGenerateOptions): Promise<string> {
    if (!this.apiKey) throw new Error('Suno API key not set');

    const { prompt, duration = 120, instrumental = true } = options;

    // Step 1: Create generation
    const createRes = await fetch(`${SUNO_API_BASE}/generate/v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        gpt_description_prompt: prompt,
        make_instrumental: instrumental,
        mv: 'chirp-v4',
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Suno API error: ${createRes.status} ${err}`);
    }

    const createData = await createRes.json();
    const clips = createData.clips || createData;
    const clipId = Array.isArray(clips) ? clips[0]?.id : clips.id;

    if (!clipId) throw new Error('No clip ID returned from Suno');

    // Step 2: Poll for completion
    const audioUrl = await this.pollForCompletion(clipId);
    return audioUrl;
  }

  private async pollForCompletion(clipId: string, maxWaitMs = 120000): Promise<string> {
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, 5000)); // poll every 5s

      const res = await fetch(`${SUNO_API_BASE}/feed/${clipId}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!res.ok) continue;

      const data = await res.json();
      const clip = Array.isArray(data) ? data[0] : data;

      if (clip?.status === 'complete' && clip?.audio_url) {
        return clip.audio_url;
      }

      if (clip?.status === 'error') {
        throw new Error(`Suno generation failed: ${clip.error_message || 'unknown error'}`);
      }
    }

    throw new Error('Suno generation timed out');
  }

  /**
   * Generate and download an ambient track, saving it locally.
   * Returns the local path for use in AudioProfile.backgroundTrack.
   */
  async generateAndSave(sessionId: string, prompt: string): Promise<string> {
    const audioUrl = await this.generate({ prompt, duration: 120, instrumental: true });

    // Download the audio
    const response = await fetch(audioUrl);
    const blob = await response.blob();

    // Save to public/audio/{sessionId}/ for static serving
    // In dev, we can use a data URL; in prod, this would be a build step
    const dataUrl = await this.blobToDataUrl(blob);

    // Store in localStorage for persistence across reloads
    const key = `hpyno_ambient_${sessionId}`;
    try {
      localStorage.setItem(key, dataUrl);
    } catch {
      // localStorage might be full — data URLs are large
      log.warn('suno', 'Could not cache ambient track in localStorage');
    }

    return dataUrl;
  }

  /** Load a previously generated track from localStorage */
  loadCached(sessionId: string): string | null {
    return localStorage.getItem(`hpyno_ambient_${sessionId}`);
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

/** Default prompts per session for ambient generation */
export const AMBIENT_PROMPTS: Record<string, string> = {
  relax: 'gentle relaxing ambient music, warm pads, soft piano, no vocals, calm, spa-like, loopable, 80bpm',
  sleep: 'deep sleep ambient drone, very slow, dark warm pads, no vocals, theta waves feel, loopable, 60bpm',
  focus: 'minimal focus ambient, clean sine tones, subtle rhythm, no vocals, lo-fi study, loopable, 90bpm',
  surrender: 'dark sensual ambient, warm deep pads, slow pulse, breathy textures, no vocals, intimate, loopable, 70bpm',
};
