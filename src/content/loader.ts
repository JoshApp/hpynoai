/**
 * Content loader — fetches the index and session packages. Fails loudly:
 * a missing package is an error, never a silent null (dev servers return
 * index.html for unknown paths, so the content-type is checked too).
 */

import { ContentError, parseSessionIndex, parseSessionPackage, type SessionIndex, type SessionPackage } from './schema';

export interface LoadedPackage {
  pkg: SessionPackage;
  /** Absolute-ish URL of the package folder, with trailing slash. */
  baseUrl: string;
}

const base = (): string => {
  const b = import.meta.env.BASE_URL || '/';
  return b.endsWith('/') ? b : `${b}/`;
};

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, { cache: 'no-cache' });
  if (!resp.ok) throw new ContentError(`HTTP ${resp.status} for ${url}`);
  const ct = resp.headers.get('content-type') ?? '';
  const text = await resp.text();
  if (!ct.includes('json') && !text.trimStart().startsWith('{')) {
    throw new ContentError(`${url} did not return JSON (content-type ${ct || 'unknown'})`);
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new ContentError(`${url} is not valid JSON`); }
}

export async function loadIndex(): Promise<SessionIndex> {
  return parseSessionIndex(await fetchJson(`${base()}sessions.json`));
}

const cache = new Map<string, Promise<LoadedPackage>>();

export function loadPackage(id: string): Promise<LoadedPackage> {
  let p = cache.get(id);
  if (!p) {
    const baseUrl = `${base()}sessions/${encodeURIComponent(id)}/`;
    p = fetchJson(`${baseUrl}session.v2.json`).then(raw => {
      const pkg = parseSessionPackage(raw);
      if (pkg.id !== id) throw new ContentError(`package id "${pkg.id}" does not match folder "${id}"`);
      return { pkg, baseUrl };
    });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

export function resolveAsset(baseUrl: string, file: string): string {
  return /^(https?:)?\/\//.test(file) || file.startsWith('/') ? file : baseUrl + file;
}
