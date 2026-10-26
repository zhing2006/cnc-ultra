/** Versioned snapshots belong to C&C Ultra; original C&C Gold save layouts are not imported. */
export interface SaveSnapshot<T = unknown> { metadata: T; buffers: Uint8Array[] }
const magic = new TextEncoder().encode('CNCULTRA');

export function encodeSave<T>(snapshot: SaveSnapshot<T>): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify(snapshot.metadata));
  const headerSize = 20 + snapshot.buffers.length * 4;
  const bytes = new Uint8Array(headerSize + metadata.length + snapshot.buffers.reduce((sum, buffer) => sum + buffer.length, 0));
  const view = new DataView(bytes.buffer);
  bytes.set(magic); view.setUint32(8, 1, true); view.setUint32(12, metadata.length, true); view.setUint32(16, snapshot.buffers.length, true);
  bytes.set(metadata, headerSize);
  let at = headerSize + metadata.length;
  snapshot.buffers.forEach((buffer, index) => { view.setUint32(20 + index * 4, buffer.length, true); bytes.set(buffer, at); at += buffer.length; });
  return bytes;
}

export function decodeSave<T>(bytes: Uint8Array): SaveSnapshot<T> {
  if (bytes.length < 20 || magic.some((value, index) => bytes[index] !== value)) throw new Error('This is not a C&C Ultra save file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== 1) throw new Error('This save version is not supported.');
  const metadataSize = view.getUint32(12, true), count = view.getUint32(16, true), headerSize = 20 + count * 4;
  if (headerSize + metadataSize > bytes.length) throw new Error('The save file is incomplete.');
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(headerSize, headerSize + metadataSize))) as T;
  let at = headerSize + metadataSize;
  const buffers = Array.from({ length: count }, (_, index) => {
    const size = view.getUint32(20 + index * 4, true), buffer = bytes.slice(at, at + size); at += size;
    if (at > bytes.length) throw new Error('The save file is incomplete.');
    return buffer;
  });
  if (at !== bytes.length) throw new Error('The save file has an invalid length.');
  return { metadata, buffers };
}

interface NativePickers {
  showSaveFilePicker(options: { suggestedName: string }): Promise<FileSystemFileHandle>;
  showOpenFilePicker(options: { multiple: boolean }): Promise<FileSystemFileHandle[]>;
  showDirectoryPicker(options: { mode: 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}

/** Call directly from the click handler, before any asynchronous GPU work consumes user activation. */
export function pickSave(name: string) {
  // Leave native pickers unfiltered so unregistered .cncu files can be opened or overwritten.
  return (window as unknown as NativePickers).showSaveFilePicker({ suggestedName: name });
}
export async function pickLoad() {
  // Let decodeSave validate the selected file's contents instead.
  const [handle] = await (window as unknown as NativePickers).showOpenFilePicker({ multiple: false });
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

/** External file handles cannot remove their parent entry; deletion grants access to a chosen folder. */
export function pickSaveDirectory() {
  return (window as unknown as NativePickers).showDirectoryPicker({ mode: 'readwrite' });
}
