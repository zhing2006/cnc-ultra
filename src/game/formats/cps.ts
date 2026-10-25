import { lcwUncompress } from './lcw.ts';

/** JSHELL.CPP Load_Uncompress / WIN32LIB IFF.H CompHeaderType; original CPS pages are 320 by 200. */
export function decodeCps(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const method = view.getUint8(2), size = view.getUint32(4, true), skip = view.getUint16(8, true);
  if (size !== 64000 || skip !== 0 && skip !== 768) throw new Error('Unsupported CPS page dimensions or palette');
  const pixels = new Uint8Array(size), offset = 10 + skip;
  if (method === 0) pixels.set(bytes.subarray(offset, offset + size));
  else if (method === 4) { if (lcwUncompress(bytes, offset, pixels) !== size) throw new Error('Incomplete CPS image'); }
  else throw new Error(`Unsupported CPS compression ${method}`);
  return { pixels, palette: bytes.slice(10, offset), width: 320, height: 200 };
}
