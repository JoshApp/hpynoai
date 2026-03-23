/**
 * Touch detection utility — shared across modules.
 * Uses coarse pointer detection (not just touch events) to identify
 * mobile/tablet devices where tap-based instructions should be shown.
 */

/** True on devices with a coarse primary pointer (touch screen) */
export const isTouchDevice = (): boolean =>
  'ontouchstart' in window || navigator.maxTouchPoints > 0;

/** Returns touch-friendly label text */
export const tapLabel = (keyLabel: string, touchLabel: string): string =>
  isTouchDevice() ? touchLabel : keyLabel;

/**
 * Get normalized coordinates from a touch or mouse event.
 * Returns { x, y } in NDC (-1 to 1) suitable for Three.js raycasting.
 */
export function pointerNDC(
  e: MouseEvent | Touch,
  element: HTMLElement,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
  };
}
