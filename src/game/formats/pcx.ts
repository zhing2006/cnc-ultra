/** Ported from WINSTUB.CPP, Read_PCX_File: indexed PCX and its trailing RGB palette. */
export function decodePcx(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 10 || bytes[2] !== 1 || bytes[3] !== 8 || bytes[65] !== 1) throw new Error('Unsupported indexed PCX');
  const width = view.getUint16(8, true) - view.getUint16(4, true) + 1;
  const height = view.getUint16(10, true) - view.getUint16(6, true) + 1;
  const stride = view.getUint16(66, true), pixels = new Uint8Array(width * height);
  let at = 128, count = 0, color = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
    if (!count) {
      color = bytes[at++];
      if ((color & 192) === 192) { count = color & 63; color = bytes[at++]; } else count = 1;
    }
    if (at > bytes.length - 768) throw new Error('Truncated PCX image');
    if (x < width) pixels[y * width + x] = color;
    count--;
  }
  const palette = bytes.slice(-768).map(channel => channel >> 2);
  return { width, height, pixels, palette };
}
