/**
 * Hash router — works on GitHub Pages without server rewrites.
 * Routes: #/gate, #/ (library), #/s/:id, #/play/:id?mode=watch|listen, #/settings, #/end/:id
 */

export type Route =
  | { name: 'gate' }
  | { name: 'library' }
  | { name: 'session'; id: string }
  | { name: 'play'; id: string; mode: 'watch' | 'listen'; resume: boolean }
  | { name: 'end'; id: string }
  | { name: 'dev' }
  | { name: 'preview'; id: string };

function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart, query = ''] = raw.split('?');
  const parts = (pathPart ?? '/').split('/').filter(Boolean);
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case undefined: return { name: 'library' };
    case 'gate': return { name: 'gate' };
    case 's': return parts[1] ? { name: 'session', id: decodeURIComponent(parts[1]) } : { name: 'library' };
    case 'play': return parts[1]
      ? { name: 'play', id: decodeURIComponent(parts[1]), mode: q.get('mode') === 'listen' ? 'listen' : 'watch', resume: q.get('resume') === '1' }
      : { name: 'library' };
    case 'end': return parts[1] ? { name: 'end', id: decodeURIComponent(parts[1]) } : { name: 'library' };
    case 'dev': return { name: 'dev' };
    case 'preview': return parts[1] ? { name: 'preview', id: decodeURIComponent(parts[1]) } : { name: 'library' };
    default: return { name: 'library' };
  }
}

class Router {
  current = $state<Route>(parse(location.hash));
  private overlay = $state<'settings' | null>(null);

  constructor() {
    window.addEventListener('hashchange', () => { this.current = parse(location.hash); });
  }

  get sheet(): 'settings' | null { return this.overlay; }

  go(path: string, replace = false): void {
    const target = `#${path.startsWith('/') ? path : `/${path}`}`;
    if (replace) history.replaceState(null, '', target); else location.hash = target;
    this.current = parse(target);
  }

  back(fallback = '/'): void {
    if (history.length > 1) history.back(); else this.go(fallback, true);
  }

  openSettings(): void { this.overlay = 'settings'; }
  closeSheet(): void { this.overlay = null; }
}

export const router = new Router();
