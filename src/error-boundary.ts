/**
 * Error boundary — catches fatal errors and shows a fallback UI.
 *
 * Handles:
 *   - WebGL not available
 *   - Shader compile failure
 *   - AudioContext blocked
 *   - Unhandled runtime errors
 *
 * Shows a minimal dark overlay with the error message.
 * The overlay is pure DOM — no WebGL needed.
 */

import { log } from './logger';

let overlayEl: HTMLDivElement | null = null;

function showError(title: string, detail: string, recoverable = false): void {
  if (overlayEl) return; // already showing

  overlayEl = document.createElement('div');
  overlayEl.style.cssText = `
    position: fixed; inset: 0; z-index: 99999;
    background: rgba(5, 3, 10, 0.95);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    font-family: Georgia, serif; color: #c8a0ff;
    padding: 2rem; text-align: center;
  `;

  overlayEl.innerHTML = `
    <div style="font-size: 1.4rem; margin-bottom: 1rem; opacity: 0.9;">${title}</div>
    <div style="font-size: 0.85rem; color: #887aaa; max-width: 400px; line-height: 1.6;">${detail}</div>
    ${recoverable ? '<button id="hpyno-error-retry" style="margin-top: 1.5rem; padding: 8px 24px; background: rgba(200,160,255,0.1); border: 1px solid rgba(200,160,255,0.3); color: #c8a0ff; font-family: inherit; font-size: 0.85rem; border-radius: 4px; cursor: pointer;">try again</button>' : ''}
  `;

  document.body.appendChild(overlayEl);

  if (recoverable) {
    overlayEl.querySelector('#hpyno-error-retry')?.addEventListener('click', () => {
      overlayEl?.remove();
      overlayEl = null;
      window.location.reload();
    });
  }
}

/** Check WebGL availability before creating renderer */
export function checkWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      showError(
        'WebGL not available',
        'HPYNO requires WebGL to run. Please try a different browser or enable hardware acceleration in your browser settings.',
      );
      return false;
    }
    return true;
  } catch {
    showError('WebGL error', 'Could not initialize WebGL. Please try a different browser.');
    return false;
  }
}

/** Check if a shader compiled successfully */
export function checkShaderCompile(
  gl: WebGLRenderingContext,
  shader: WebGLShader,
  type: 'vertex' | 'fragment',
): boolean {
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const shaderLog = gl.getShaderInfoLog(shader) ?? 'unknown error';
    log.error('shader', `${type} shader compile error`, shaderLog);
    showError(
      'Shader error',
      `The ${type} shader failed to compile. This usually means your GPU doesn't support a required feature. Try updating your graphics drivers.`,
      true,
    );
    return false;
  }
  return true;
}

/** Wrap AudioContext creation with error handling */
export async function safeAudioContext(): Promise<AudioContext | null> {
  try {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    return ctx;
  } catch (e) {
    log.warn('audio', 'AudioContext creation failed', e);
    // Not fatal — the experience can run without audio
    return null;
  }
}

/** Global error handler — catches unhandled errors */
export function installGlobalErrorHandler(): void {
  window.addEventListener('error', (e) => {
    // Ignore ResizeObserver errors (browser noise)
    if (e.message?.includes('ResizeObserver')) return;

    log.error('runtime', `Unhandled error: ${e.message}`, e.error);

    // Only show overlay for fatal-looking errors
    if (e.message?.includes('WebGL') || e.message?.includes('shader') || e.message?.includes('context')) {
      showError(
        'Something went wrong',
        e.message,
        true,
      );
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    log.error('runtime', 'Unhandled promise rejection', e.reason);
  });
}

/** Dismiss the error overlay (if shown) */
export function dismissError(): void {
  overlayEl?.remove();
  overlayEl = null;
}
