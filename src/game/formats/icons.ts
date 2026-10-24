/** A decoded icon set, the format of a terrain template such as CLEAR1.TEM. */
export interface IconSet {
  /** Icon size in pixels, 24×24 for every theater template. */
  width: number;
  height: number;
  /** The stored icons, width × height palette indices each. */
  icons: Uint8Array[];
  /** For each logical icon of the template, the stored icon it shows, or 0xFF when it has none. */
  map: Uint8Array;
}

/**
 * Decodes an icon set. The header is IControl_Type in TILE.H: width, height, icon count and an
 * allocated flag as 16-bit values, then the set size and the offsets of the icon data, palettes,
 * remaps, transparency flags and icon map as 32-bit values. Buffer_Draw_Stamp in the remaster's
 * DrawMisc.cpp maps a logical icon through the icon map and draws nothing when the stored icon is
 * not in the set. It reads the map without a bound: CLEAR1 is a 1 × 1 template in CDATA.CPP, yet
 * CellClass::Clear_Icon picks any of its 16 icons. The map ends where the transparency flags begin,
 * which is also how OpenRA's TmpTDLoader reads it.
 */
export function decodeIconSet(data: Uint8Array): IconSet {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  const count = view.getUint16(4, true);
  const iconsOffset = view.getUint32(12, true);
  const transOffset = view.getUint32(24, true);
  const mapOffset = view.getUint32(28, true);
  const size = width * height;
  const icons: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const start = iconsOffset + index * size;
    icons.push(data.slice(start, start + size));
  }
  const map = data.slice(mapOffset, transOffset);
  for (let index = 0; index < map.length; index++) if (map[index] >= count) map[index] = 0xff;
  return { width, height, icons, map };
}
