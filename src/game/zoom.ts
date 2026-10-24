export const MAX_ZOOM = 16;

/** Integer scaling in physical pixels; the initial view keeps M0's 400-pixel reference height. */
export function initialZoom(height: number): number {
  return Math.max(1, Math.min(MAX_ZOOM, Math.floor(height / 400)));
}

/** Keep a world point under the same physical screen pixel, rounded to an original image pixel. */
export function zoomOrigin(origin: number, anchor: number, oldScale: number, newScale: number): number {
  return Math.round(origin + anchor - anchor * oldScale / newScale);
}
