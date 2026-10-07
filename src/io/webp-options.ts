/**
 * WebP Options: lossless (exact; our own encoder) or lossy with a quality of
 * 0–100 (the browser's encoder, where it has one — not Safari; D-034).
 */
export interface WebpSaveOptions {
  lossless: boolean;
  /** Lossy only: 0 (smallest) … 100 (best). */
  quality: number;
}

export const DEFAULT_WEBP_OPTIONS: WebpSaveOptions = { lossless: false, quality: 75 };
