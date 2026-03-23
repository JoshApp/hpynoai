/**
 * Service Worker registration.
 * Only registers in production (not during Vite dev server).
 */

import { log } from './logger';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  // Don't register during dev (Vite HMR handles everything)
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(
      (reg) => {
        log.info('sw', `Registered, scope: ${reg.scope}`);

        // Auto-update check every hour
        setInterval(() => reg.update(), 60 * 60 * 1000);
      },
      (err) => {
        log.warn('sw', 'Registration failed', err);
      },
    );
  });
}
