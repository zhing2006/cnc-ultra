/**
 * The ID a MIX file stores in place of a file name. Ported from MIXFILE.CPP, MixFileClass::Offset,
 * which upper-cases the name and runs Calculate_CRC (MiscAsm.cpp in the remaster's source) over it:
 * the name is read as little-endian 32-bit words, zero-padded at the end, and each word is added to
 * the running value after rotating it left by one bit.
 */
export function mixId(name: string): number {
  const bytes = new TextEncoder().encode(name.toUpperCase());
  let id = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word = (bytes[i] | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0) << 16 | (bytes[i + 3] ?? 0) << 24) >>> 0;
    id = (((id << 1) | (id >>> 31)) + word) >>> 0;
  }
  return id;
}

/**
 * A MIX archive. The layout follows MIXFILE.H: a 16-bit file count and a 32-bit data size, then one
 * entry per file of ID, offset and size, then the data. Offsets count from the start of the data.
 */
export class MixFile {
  private readonly data: Uint8Array;
  private readonly entries = new Map<number, { offset: number; size: number }>();

  constructor(data: Uint8Array) {
    this.data = data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint16(0, true);
    const start = 6 + count * 12;
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 12;
      const offset = start + view.getUint32(entry + 4, true);
      const size = view.getUint32(entry + 8, true);
      if (offset + size > data.byteLength) throw new Error(`MIX entry ${index} runs past the end of the file`);
      this.entries.set(view.getUint32(entry, true), { offset, size });
    }
  }

  /** The named file, or undefined when this archive does not hold it. */
  get(name: string): Uint8Array | undefined {
    const entry = this.entries.get(mixId(name));
    return entry && this.data.subarray(entry.offset, entry.offset + entry.size);
  }
}

/**
 * Looks files up across several archives, in the order given. Ported from MIXFILE.CPP,
 * MixFileClass::Retrieve, which searches every loaded MIX file.
 */
export class MixSet {
  private readonly files: MixFile[];

  constructor(files: MixFile[]) {
    this.files = files;
  }

  get(name: string): Uint8Array | undefined {
    for (const file of this.files) {
      const data = file.get(name);
      if (data) return data;
    }
    return undefined;
  }

  /** Like get(), but throws when no archive holds the file. */
  require(name: string): Uint8Array {
    const data = this.get(name);
    if (!data) throw new Error(`${name} is not in any of the loaded MIX files`);
    return data;
  }
}
