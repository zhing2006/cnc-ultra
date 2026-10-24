import { MixFile, MixSet } from './formats/mix.ts';

/** The original MIX files M0 reads, looked up in this order. */
export const DATA_FILES = ['conquer.mix', 'temperat.mix', 'general.mix', 'cclocal.mix'];

/** Thrown when the site does not serve one of the original data files. */
export class MissingDataError extends Error {}

let loading: Promise<MixSet> | null = null;

/**
 * Fetches the original MIX files from the data/ directory next to the page (technical constitution,
 * articles 10 and 14). The files are fetched once per page load.
 */
export function loadData(): Promise<MixSet> {
  loading ??= Promise.all(DATA_FILES.map(async (name) => {
    const response = await fetch(new URL(`data/${name}`, document.baseURI));
    if (!response.ok) throw new MissingDataError(`data/${name}: HTTP ${response.status}`);
    return new MixFile(new Uint8Array(await response.arrayBuffer()));
  })).then((files) => new MixSet(files));
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
