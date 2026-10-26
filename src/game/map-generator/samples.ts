import { TEMPLATES } from '../data/templates.ts';
import { decodeIconSet } from '../formats/icons.ts';
import type { MixSet } from '../formats/mix.ts';
import { readScenario, type Scenario } from '../formats/scenario.ts';

export const CLEAR = 0, WATER = 256;
export interface MapSample { name: string; scenario: Scenario; tiles: Uint16Array }
export interface ShoreProfile { tiles: number[]; weight: number }
export interface FeaturePatch {
  width: number; height: number; tiles: Uint16Array; kind: 'cliff' | 'detail'; north: boolean;
  /** Original map and crop origin; tile arrangements are read from MIX at run time. */
  source: { map: string; x: number; y: number };
}
export interface MapSamples {
  maps: MapSample[];
  east: Map<number, Set<number>>;
  south: Map<number, Set<number>>;
  shores: ShoreProfile[];
  features: FeaturePatch[];
}

/** Clear ground and open water vary in appearance, not in their edge connectivity. */
export function tileKey(template: number, icon: number) {
  return template === 255 || template === 0 ? CLEAR : template === 1 || template === 2 ? WATER : template * 256 + icon;
}
const nameOf = (tile: number) => TEMPLATES[tile >>> 8]?.name ?? 'CLEAR1';
const isShore = (tile: number) => nameOf(tile).startsWith('SH');

/** Learn from the original maps at run time; no extracted map or tile data is stored in the repo. */
export function collectMapSamples(mix: MixSet): MapSamples {
  const maps: MapSample[] = [], east = new Map<number, Set<number>>(), south = new Map<number, Set<number>>();
  const sets = new Map<number, Uint8Array>();
  const validTile = (template: number, icon: number) => {
    if (template === 255 || template === 0) return CLEAR;
    if (!sets.has(template)) {
      const file = mix.get(`${TEMPLATES[template]?.name}.TEM`);
      sets.set(template, file ? decodeIconSet(file).map : new Uint8Array());
    }
    // MAP.CPP, Read_Binary: an absent logical icon becomes clear ground.
    return (sets.get(template)![icon] ?? 255) === 255 ? CLEAR : tileKey(template, icon);
  };
  const decoder = new TextDecoder('latin1');
  // Original scenario names (INI.CPP, Set_Scenario_Name); MIX stores hashes, not filenames.
  for (const side of ['G', 'B', 'M']) for (let n = 1; n <= 99; n++) for (const direction of ['E', 'W']) for (const variant of ['A', 'B', 'C', 'D']) {
    const name = `SC${side}${String(n).padStart(2, '0')}${direction}${variant}`;
    const ini = mix.get(`${name}.INI`), bin = mix.get(`${name}.BIN`);
    if (!ini || !bin) continue;
    const scenario = readScenario(decoder.decode(ini), bin);
    if (scenario.theater.toUpperCase() !== 'TEMPERATE') continue;
    const tiles = Uint16Array.from(scenario.templates, (template, cell) => validTile(template, scenario.icons[cell]));
    maps.push({ name, scenario, tiles });
    const add = (rules: Map<number, Set<number>>, a: number, b: number) => {
      if (!rules.has(a)) rules.set(a, new Set());
      rules.get(a)!.add(b);
    };
    for (let y = scenario.y; y < scenario.y + scenario.height; y++) for (let x = scenario.x; x < scenario.x + scenario.width; x++) {
      const cell = y * 64 + x;
      if (x + 1 < scenario.x + scenario.width) add(east, tiles[cell], tiles[cell + 1]);
      if (y + 1 < scenario.y + scenario.height) add(south, tiles[cell], tiles[cell + 64]);
    }
  }
  if (!maps.length) throw new Error('No original temperate maps are available for the generator.');
  const shores: ShoreProfile[] = [], profileIds = new Map<string, number>();
  for (const { scenario: s, tiles } of maps) {
    for (let x = s.x; x < s.x + s.width; x++) for (let y = s.y + 1; y < s.y + s.height - 2; y++) {
      const cell = y * 64 + x;
      if (!isShore(tiles[cell]) || tiles[cell - 64] !== CLEAR) continue;
      const column: number[] = [];
      for (let row = y; row < Math.min(y + 12, s.y + s.height - 1); row++) {
        const tile = tiles[row * 64 + x];
        if (tile !== CLEAR && tile !== WATER && !isShore(tile)) break;
        column.push(tile);
        if (tile !== WATER || tiles[(row + 1) * 64 + x] !== WATER) continue;
        while (column.at(-1) === WATER) column.pop();
        const key = column.join(',');
        const old = profileIds.get(key);
        if (old === undefined) { profileIds.set(key, shores.length); shores.push({ tiles: column, weight: 1 }); }
        else shores[old].weight++;
        break;
      }
    }
  }
  const features: FeaturePatch[] = [], seenPatches = new Set<string>();
  for (const { name, scenario: s, tiles } of maps) for (const kind of ['cliff', 'detail'] as const) {
    const visited = new Uint8Array(4096);
    // Separate slopes from ground patterns: touching dirt must not merge unrelated cliff systems.
    const eligible = (tile: number) => (kind === 'cliff' ? /^S\d/ : /^P\d/).test(nameOf(tile));
    const right = s.x + s.width, bottom = s.y + s.height;
    for (let sy = s.y; sy < bottom; sy++) for (let sx = s.x; sx < right; sx++) {
      const start = sy * 64 + sx;
      if (visited[start] || !eligible(tiles[start])) continue;
      visited[start] = 1;
      const queue = [start];
      let left = sx, top = sy, maxX = sx, maxY = sy;
      for (let i = 0; i < queue.length; i++) {
        const cell = queue[i], x = cell % 64, y = Math.trunc(cell / 64);
        left = Math.min(left, x); top = Math.min(top, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy, at = yy * 64 + xx;
          if (xx < s.x || xx >= right || yy < s.y || yy >= bottom || visited[at] || !eligible(tiles[at])) continue;
          visited[at] = 1; queue.push(at);
        }
      }
      // Keep substantial original formations, including those continuing out of the northern edge.
      const north = top === s.y;
      if (left === s.x || maxX === right - 1 || maxY === bottom - 1 || north && kind !== 'cliff') continue;
      if (kind === 'cliff' && (queue.length < 50 || maxX - left < 15)) continue;
      left--; maxX++; if (!north) top--; maxY++;
      const width = maxX - left + 1, height = maxY - top + 1;
      const patch = new Uint16Array(width * height);
      for (const cell of queue) patch[(Math.trunc(cell / 64) - top) * width + cell % 64 - left] = tiles[cell];
      // The component retains its original slope tiles. Its new clear surroundings must also have
      // observed joins; reject a crop that depended on a river, road or another nearby formation.
      let good = true;
      for (let y = 0; y < height && good; y++) for (let x = 0; x < width && good; x++) {
        const cell = y * width + x, tile = patch[cell];
        if (x + 1 < width && !east.get(tile)?.has(patch[cell + 1])) good = false;
        if (y + 1 < height && !south.get(tile)?.has(patch[cell + width])) good = false;
      }
      if (!good) continue;
      const key = `${width}:${height}:${patch.join(',')}`;
      if (seenPatches.has(key)) continue;
      seenPatches.add(key);
      features.push({ width, height, tiles: patch, kind, north, source: { map: name, x: left, y: top } });
    }
  }
  if (!shores.length) throw new Error('No south-facing shoreline samples were found.');
  return { maps, east, south, shores, features };
}
