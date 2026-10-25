import { loadArchive, MissingDataError } from '../data-files.ts';
import { MixSet } from '../formats/mix.ts';
import { BufferedSource, readRange, RemoteMix, type ByteSource } from '../formats/remote-mix.ts';

export type CampaignSide = 'gdi' | 'nod';

/** A static manifest avoids requesting absent movies on installations with only development data. */
export class CampaignAssets {
  private readonly indexes = new Map<string, Promise<RemoteMix>>();
  private readonly smallFiles = new Map<string, Promise<Uint8Array>>();
  private constructor(private readonly manifest: Record<string, number>, private readonly base: URL) {}
  static async open() {
    const base = new URL('data/', document.baseURI), response = await fetch(new URL('index.json', base));
    if (!response.ok) throw new MissingDataError('The data manifest is missing. Run refs/prepare-data.ps1 or refs/prepare-data.sh.');
    return new CampaignAssets(await response.json(), base);
  }
  private index(name: string): Promise<RemoteMix> | undefined {
    if (!(name in this.manifest)) return undefined;
    let pending = this.indexes.get(name);
    if (!pending) {
      pending = RemoteMix.open(new URL(name, this.base));
      this.indexes.set(name, pending);
      void pending.catch(() => this.indexes.delete(name));
    }
    return pending;
  }
  async source(name: string, archives: readonly string[]): Promise<ByteSource | undefined> {
    const loose = name.toLowerCase();
    if (loose in this.manifest) return { size: this.manifest[loose], read: (offset, size, signal) => readRange(new URL(loose, this.base), offset, size, signal) };
    for (const archive of archives) {
      const source = (await this.index(archive))?.get(name);
      if (source) return source;
    }
    return undefined;
  }
  async bytes(name: string, archives = ['update.mix', 'transit.mix', 'cclocal.mix', 'general.mix']) {
    const key=`${archives.join('/')}:${name.toUpperCase()}`,cached=this.smallFiles.get(key);
    if(cached)return cached;
    const pending=(async()=>{
      const source = await this.source(name, archives);
      if (!source) throw new MissingDataError(`${name} is missing. Run refs/prepare-data.ps1 or refs/prepare-data.sh.`);
      return source.read(0, source.size);
    })();
    if(this.smallFiles.size>=64)this.smallFiles.delete(this.smallFiles.keys().next().value!);
    this.smallFiles.set(key,pending);void pending.catch(()=>this.smallFiles.delete(key));return pending;
  }
  async optionalBytes(name: string, archives = ['update.mix', 'transit.mix', 'cclocal.mix', 'general.mix']) {
    return await this.source(name,archives) ? this.bytes(name,archives) : undefined;
  }
  async movie(name: string, side: CampaignSide) {
    const source = await this.source(`${name}.VQA`, [`${side}/movies.mix`]);
    if (!source) return undefined;
    const palette = await this.source(`${name}.VQP`, ['update.mix', `${side}/movies.mix`]);
    return { source: new BufferedSource(source), palette: palette && await palette.read(0, palette.size) };
  }
  async mission(side: CampaignSide, theater: string) {
    const root = theater.toLowerCase() === 'temperate' ? 'temperat' : theater.toLowerCase();
    const icons = root === 'temperat' ? 'tempicnh' : root === 'winter' ? 'winticnh' : 'deseicnh';
    // Gold's update.mix holds presentation assets. Keep it on range reads instead
    // of downloading the entire ten-megabyte archive for every first battlefield.
    const names = ['updatec.mix', `${side}/general.mix`, 'conquer.mix', `${root}.mix`, 'cclocal.mix', 'sounds.mix', 'speech.mix', `${icons}.mix`];
    if (!(names[1] in this.manifest)) names[1] = 'general.mix';
    const [files,font]=await Promise.all([
      Promise.all(names.filter(name=>name in this.manifest).map(loadArchive)),
      this.source('12GRNGRD.FNT',['update.mix','cclocal.mix']).then(source=>source&&this.bytes('12GRNGRD.FNT',['update.mix','cclocal.mix'])),
    ]);
    return new MixSet([...files,{get:(name:string)=>name.toUpperCase()==='12GRNGRD.FNT'?font:undefined}]);
  }
}
