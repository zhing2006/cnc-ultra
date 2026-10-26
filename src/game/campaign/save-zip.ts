// Single-save ZIP containers follow PKWARE APPNOTE 6.3.10, sections 4.3 and 4.4.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
const entryName = new TextEncoder().encode('save.cncu');
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const input = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return new Uint8Array(await new Response(input.pipeThrough(stream)).arrayBuffer());
}

/** Keep the existing .cncu payload intact inside a standard, deflated ZIP entry. */
export async function zipSave(bytes: Uint8Array): Promise<Uint8Array> {
  const compressed = await transform(bytes, new CompressionStream('deflate-raw'));
  const central = 30 + entryName.length + compressed.length, end = central + 46 + entryName.length;
  const archive = new Uint8Array(end + 22), view = new DataView(archive.buffer);
  const crc = crc32(bytes);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 8, true);
  view.setUint16(12, 33, true); // DOS date: 1980-01-01.
  view.setUint32(14, crc, true);
  view.setUint32(18, compressed.length, true);
  view.setUint32(22, bytes.length, true);
  view.setUint16(26, entryName.length, true);
  archive.set(entryName, 30);
  archive.set(compressed, 30 + entryName.length);
  view.setUint32(central, 0x02014b50, true);
  view.setUint16(central + 4, 20, true);
  // The central record repeats the local metadata after its creator-version field.
  archive.set(archive.subarray(4, 28), central + 6);
  archive.set(entryName, central + 46);
  view.setUint32(end, 0x06054b50, true);
  view.setUint16(end + 8, 1, true);
  view.setUint16(end + 10, 1, true);
  view.setUint32(end + 12, end - central, true);
  view.setUint32(end + 16, central, true);
  return archive;
}

/** Read the directory so ordinary ZIP tools' extra fields and data descriptors also work. */
export async function unzipSave(bytes: Uint8Array): Promise<Uint8Array> {
  const invalid = () => new Error('The compressed save file is invalid or incomplete.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  const last = Math.max(0, end - 65535);
  for (; end >= last; end--)
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  if (end < last) throw invalid();
  const count = view.getUint16(end + 10, true), central = view.getUint32(end + 16, true);
  const centralEnd = central + view.getUint32(end + 12, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || centralEnd > end) throw invalid();
  let entry: { offset: number; method: number; crc: number; packedSize: number; size: number } | undefined;
  let at = central;
  for (let i = 0; i < count; i++) {
    if (at + 46 > centralEnd || view.getUint32(at, true) !== 0x02014b50) throw invalid();
    const nameLength = view.getUint16(at + 28, true);
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (next > centralEnd) throw invalid();
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // Finder may add __MACOSX resource-fork entries alongside the real save.
    if (name.toLowerCase().endsWith('.cncu') && !name.startsWith('__MACOSX/')) {
      if (entry) throw new Error('The compressed file contains more than one C&C Ultra save.');
      if (view.getUint16(at + 8, true) & 0x41) throw new Error('Encrypted save files are not supported.');
      if (view.getUint16(at + 34, true)) throw invalid();
      entry = { offset: view.getUint32(at + 42, true), method: view.getUint16(at + 10, true),
        crc: view.getUint32(at + 16, true), packedSize: view.getUint32(at + 20, true), size: view.getUint32(at + 24, true) };
    }
    at = next;
  }
  if (at !== centralEnd) throw invalid();
  if (!entry) throw new Error('The compressed file does not contain a C&C Ultra save.');
  const offset = entry.offset;
  if (offset + 30 > central || view.getUint32(offset, true) !== 0x04034b50) throw invalid();
  if (view.getUint16(offset + 6, true) & 0x41 || view.getUint16(offset + 8, true) !== entry.method) throw invalid();
  const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
  if (start + entry.packedSize > central) throw invalid();
  const packed = bytes.subarray(start, start + entry.packedSize);
  let unpacked: Uint8Array;
  if (entry.method === 0) unpacked = packed.slice();
  else if (entry.method === 8) unpacked = await transform(packed, new DecompressionStream('deflate-raw'));
  else throw new Error('This ZIP compression method is not supported.');
  if (unpacked.length !== entry.size || crc32(unpacked) !== entry.crc) throw new Error('The compressed save file is damaged.');
  return unpacked;
}
