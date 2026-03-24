/**
 * Post-session sign-in suggestion — shown once per session after completing
 * a hypnosis experience, only if the user is anonymous.
 *
 * "Session complete. Sign in to save your progress across devices."
 * Dismissable, subtle, matches tunnel aesthetic.
 */

import { hotState } from './hot-state';

const SHOWN_KEY = 'hpyno-signin-prompted';

/**
 * Shows a subtle sign-in prompt if the user is anonymous.
 * Shown once per browser session (sessionStorage flag).
 * No-ops if auth manager isn't available or user is already signed in.
 */
export function showPostSessionPrompt(): void {
  const auth = hotState.authManager;
  if (!auth) return;

  const state = auth.getState();
  if (!state.isAnonymous) return;
  if (sessionStorage.getItem(SHOWN_KEY)) return;

  sessionStorage.setItem(SHOWN_KEY, '1');

  const overlay = document.createElement('div');
  overlay.id = 'post-session-prompt';

  const text = document.createElement('span');
  text.className = 'psp-text';
  text.textContent = 'session complete — sign in to save progress across devices';
  overlay.appendChild(text);

  const signInBtn = document.createElement('button');
  signInBtn.className = 'psp-sign-in';
  signInBtn.textContent = 'sign in';
  signInBtn.addEventListener('click', () => {
    auth.signInWithGoogle();
    dismiss();
  });
  overlay.appendChild(signInBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'psp-dismiss';
  dismissBtn.textContent = '\u00D7';
  dismissBtn.title = 'Dismiss';
  dismissBtn.addEventListener('click', dismiss);
  overlay.appendChild(dismissBtn);

  // Stop events leaking to canvas
  for (const evt of ['mousedown', 'click', 'touchstart', 'pointerdown'] as const) {
    overlay.addEventListener(evt, (e) => e.stopPropagation());
  }

  document.body.appendChild(overlay);

  // Fade in
  requestAnimationFrame(() => overlay.classList.add('visible'));

  // Auto-dismiss after 12 seconds
  const timer = setTimeout(dismiss, 12000);

  function dismiss(): void {
    clearTimeout(timer);
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 500);
  }
}

/**
 * Auto-sign-in anonymously on first visit if auth manager is available
 * and user has no existing session.
 * Called during boot, after auth manager is wired up.
 */
export function autoAnonymousSignIn(): void {
  const auth = hotState.authManager;
  if (!auth) return;

  const state = auth.getState();
  // Only sign in anonymously if not authenticated at all (no session)
  if (!state.isAuthenticated && !state.loading) {
    auth.signInAnonymously();
  }
}
