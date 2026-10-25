export const DEFAULT_MATCH_SEED = 1995;

export function parseSeed(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value : undefined;
}

/** Only the explicit random-new-match action uses entropy; simulation randomness stays seeded. */
export function randomSeed() { return crypto.getRandomValues(new Uint32Array(1))[0]; }
