/** An INI file: sections and keys are looked up without regard to case, entries keep file order. */
export class Ini {
  private readonly sections = new Map<string, [string, string][]>();

  constructor(text: string) {
    let entries: [string, string][] | null = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith(';')) continue;
      if (line.startsWith('[')) {
        const name = line.slice(1, line.indexOf(']')).trim().toUpperCase();
        entries = this.sections.get(name) ?? [];
        this.sections.set(name, entries);
        continue;
      }
      const equals = line.indexOf('=');
      if (entries && equals > 0) entries.push([line.slice(0, equals).trim(), line.slice(equals + 1).trim()]);
    }
  }

  /** The entries of a section in file order, or none when the section is missing. */
  entries(section: string): [string, string][] {
    return this.sections.get(section.toUpperCase()) ?? [];
  }

  get(section: string, key: string): string | undefined {
    const wanted = key.toUpperCase();
    return this.entries(section).find(([name]) => name.toUpperCase() === wanted)?.[1];
  }

  /** An integer value, or the fallback when the key is missing, as WWGetPrivateProfileInt reads it. */
  int(section: string, key: string, fallback: number): number {
    const value = this.get(section, key);
    return value === undefined ? fallback : Number.parseInt(value, 10) || 0;
  }
}
