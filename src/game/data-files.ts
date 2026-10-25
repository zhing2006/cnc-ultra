import { MixFile, MixSet } from './formats/mix.ts';

/** The original MIX files the mission reads, looked up in this order. */
export const DATA_FILES = ['conquer.mix', 'temperat.mix', 'general.mix', 'cclocal.mix'];
export const DESERT_DATA_FILES = [...DATA_FILES, 'desert.mix'];

/** Thrown when the site does not serve one of the original data files. */
export class MissingDataError extends Error {}

const loading = new Map<string, Promise<MixSet>>();
const archives = new Map<string, Promise<MixFile>>();

/** Share archive requests between previews, missions and audio. Failed requests can be retried. */
export function loadArchive(name: string): Promise<MixFile> {
  const cached = archives.get(name);
  if (cached) return cached;
  const pending = fetch(new URL(`data/${name}`, document.baseURI)).then(async response => {
    if (!response.ok) throw new MissingDataError(`data/${name}: HTTP ${response.status}`);
    return new MixFile(new Uint8Array(await response.arrayBuffer()));
  });
  archives.set(name, pending);
  void pending.catch(() => archives.delete(name));
  return pending;
}

/**
 * Fetches the original MIX files from the data/ directory next to the page (technical constitution,
 * articles 10 and 14). The files are fetched once per page load.
 */
export function loadData(includeDesert = false, audio = false, economy = false): Promise<MixSet> {
  const key = `${includeDesert}:${audio}:${economy}`;
  const cached = loading.get(key);
  if (cached) return cached;
  const files = [...(includeDesert ? DESERT_DATA_FILES : DATA_FILES), ...(audio ? ['sounds.mix'] : []), ...(audio||economy?['updatec.mix']:[]), ...(economy ? ['speech.mix','tempicnh.mix'] : [])];
  const pending = Promise.all(files.map(loadArchive)).then((files) => new MixSet(files));
  loading.set(key, pending);
  pending.catch(() => {
    loading.delete(key);
  });
  return pending;
}
