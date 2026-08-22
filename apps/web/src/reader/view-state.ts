/**
 * The reader's view state, as pure functions.
 *
 * Page number and zoom are the two things a reader gets wrong in ways nobody notices until a
 * document has one page or three hundred: a "next page" that walks past the end, a zoom that halves
 * forever. Keeping the arithmetic out of the component means it can be tested without a PDF, a
 * canvas or a browser — which is the only way any of it gets tested at all in Phase 1.
 */

/** The zoom steps the buttons and the `+`/`-` shortcuts move between. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
export const DEFAULT_ZOOM = 1;

export const clampPage = (page: number, pageCount: number): number => {
  if (!Number.isFinite(page) || pageCount < 1) return 1;
  return Math.min(Math.max(Math.round(page), 1), pageCount);
};

/** The next step up, or the current zoom when already at the top. */
export const zoomIn = (zoom: number): number =>
  ZOOM_STEPS.find((step) => step > zoom + 1e-9) ?? MAX_ZOOM;

export const zoomOut = (zoom: number): number =>
  [...ZOOM_STEPS].reverse().find((step) => step < zoom - 1e-9) ?? MIN_ZOOM;

export const clampZoom = (zoom: number): number => {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
};

export const formatZoom = (zoom: number): string => `${Math.round(zoom * 100)}%`;
