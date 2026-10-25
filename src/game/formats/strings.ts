/** WIN32LIB DIPTHONG.CPP Extract_String: little-endian offsets into the original language file. */
export class GameStrings {
  private readonly offsets: DataView;
  private readonly decoder = new TextDecoder('windows-1252');
  constructor(private readonly bytes: Uint8Array) { this.offsets = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  get(id: number) {
    const start = this.offsets.getUint16(id * 2, true), end = this.bytes.indexOf(0, start);
    return this.decoder.decode(this.bytes.subarray(start, end < 0 ? this.bytes.length : end));
  }
}
