import { MixFile, MixSet } from './formats/mix.ts';

/** The original MIX files the mission reads, looked up in this order. */
export const DATA_FILES = ['conquer.mix', 'temperat.mix', 'general.mix', 'cclocal.mix'];
export const PREVIEW_DATA_FILES = [...DATA_FILES, 'desert.mix'];

/** Thrown when the site does not serve one of the original data files. */
export class MissingDataError extends Error {}

const loading = new Map<string, Promise<MixSet>>();

/**
 * Fetches the original MIX files from the data/ directory next to the page (technical constitution,
 * articles 10 and 14). The files are fetched once per page load.
 */
export function loadData(preview = false, audio = false): Promise<MixSet> {
  const key = `${preview}:${audio}`;
  const cached = loading.get(key);
  if (cached) return cached;
  const files = [...(preview ? PREVIEW_DATA_FILES : DATA_FILES), ...(audio ? ['sounds.mix'] : [])];
  const pending = Promise.all(files.map(async (name) => {
    const response = await fetch(new URL(`data/${name}`, document.baseURI));
    if (!response.ok) throw new MissingDataError(`data/${name}: HTTP ${response.status}`);
    return new MixFile(new Uint8Array(await response.arrayBuffer()));
  })).then((files) => new MixSet(files));
  loading.set(key, pending);
  pending.catch(() => {
    loading.delete(key);
  });
  return pending;
}
