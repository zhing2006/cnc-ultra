import { randomWord } from '../../engine/simulation/fixed.ts';
import { TERRAIN } from '../data/terrain.ts';
import { buildableTemplate } from '../data/land.ts';
import { TEMPLATES } from '../data/templates.ts';
import type { Scenario } from '../formats/scenario.ts';
import { CLEAR, WATER, type MapSamples, type ShoreProfile } from './samples.ts';
import { inside, planBattleLayout, type BattleLayout, type MapRectangle } from './layout.ts';
export type { MapRectangle } from './layout.ts';

export interface GeneratedMap extends BattleLayout {
  scenario: Scenario;
  seed: number;
  shoreline: Int32Array;
  cliffs: { bounds: MapRectangle; source: MapSamples['features'][number]['source'] }[];
  sampleCount: number;
}
export interface GeneratorOptions { seed: number; width?: number; height?: number }

/** Columns keep the original vertical shore sequences; every join was observed in an original map. */
function coastline(samples: MapSamples, width: number, height: number, seed: number, tiles: Uint16Array, shoreTop: number, patrolRow: number) {
  const { shores, east } = samples;
  const at = (p: ShoreProfile, y: number) => y < 0 ? CLEAR : y >= p.tiles.length ? WATER : p.tiles[y];
  const joins = shores.map(a => shores.flatMap((b, profile) => {
    const result: { profile: number; delta: number }[] = [];
    for (let delta = -3; delta <= 3; delta++) {
      let valid = true;
      for (let y = Math.min(0, delta) - 1; y <= Math.max(a.tiles.length, b.tiles.length + delta); y++) {
        if (!east.get(at(a, y))?.has(at(b, y - delta))) { valid = false; break; }
      }
      if (valid) result.push({ profile, delta });
    }
    return result;
  }));
  // UNIT.CPP, Per_Cell_Process: the existing gunboat patrol follows one east-west row.
  // Keep every shore profile north of that row, with the battlefront immediately inland.
  const low = shoreTop, levels = patrolRow - shoreTop;
  const edges = Array.from({ length: shores.length * levels }, (_, state) => {
    const profile = Math.trunc(state / levels), level = state % levels;
    return joins[profile].filter(join => level + join.delta >= 0 && level + join.delta < levels)
      .map(join => join.profile * levels + level + join.delta);
  });
  // Remove profiles that cross the patrol and then dead ends, rather than changing naval movement.
  const active = Uint8Array.from(edges, (_, state) =>
    low + state % levels + shores[Math.trunc(state / levels)].tiles.length <= patrolRow ? 1 : 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (let state = 0; state < edges.length; state++) if (active[state] && !edges[state].some(next => active[next])) {
      active[state] = 0; changed = true;
    }
  }
  const starts = edges.map((_, i) => i).filter(i => active[i] && i % levels === 0);
  if (!starts.length) throw new Error('The original shoreline samples cannot form a continuous southern coast.');
  let state = starts[randomWord(seed, 0, 0, 10) % starts.length];
  const shoreline = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    const y = low + state % levels, profile = shores[Math.trunc(state / levels)];
    shoreline[x] = y;
    for (let row = y; row < height; row++) tiles[row * width + x] = at(profile, row - y);
    const knot = Math.trunc(x / 48), fraction = x % 48;
    const a = randomWord(seed, 0, knot, 11) % levels;
    const b = randomWord(seed, 0, knot + 1, 11) % levels;
    const target = low + Math.trunc((a * (48 - fraction) + b * fraction) / 48);
    const candidates = edges[state].filter(next => active[next]);
    const weights = candidates.map(next => Math.max(1, Math.trunc(64 * Math.min(6, shores[Math.trunc(next / levels)].weight)
      / (1 + Math.abs(low + next % levels - target) * 8))));
    let choice = randomWord(seed, 0, x, 12) % weights.reduce((a, b) => a + b, 0);
    state = candidates.at(-1)!;
    for (let i = 0; i < candidates.length; i++) { choice -= weights[i]; if (choice < 0) { state = candidates[i]; break; } }
  }
  return shoreline;
}

/** Generate terrain before armies or facilities are placed in the shared scenario. */
export function generateMap(samples: MapSamples, { seed, width = 512, height = 256 }: GeneratorOptions): GeneratedMap {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 384 || height < 256)
    throw new Error('The large-battle map requires at least 384 by 256 cells.');
  seed >>>= 0;
  const tiles = new Uint16Array(width * height);
  const layout = planBattleLayout(width, height);
  const { deployments, support, mineralFields, battlefield, navalSupport } = layout;
  const shoreTop = battlefield.y + battlefield.height;
  const shoreline = coastline(samples, width, height, seed, tiles, shoreTop, navalSupport.patrol.y);
  const reservedAreas = [...deployments, ...support, ...mineralFields.flat(), battlefield];
  const reserved = (x: number, y: number) => reservedAreas.some(rect => inside(x, y, rect));
  const blocked = new Uint8Array(tiles.length);
  const scenario: Scenario = {
    theater: 'TEMPERATE', mapWidth: width, mapHeight: height, x: 0, y: 0, width, height,
    templates: new Uint8Array(tiles.length), icons: new Uint8Array(tiles.length),
    terrain: [], overlays: [], smudges: [], units: [], infantry: [], buildings: [], waypoints: new Map(),
  };
  const rand = (object: number, stream: number, span: number) => randomWord(seed, 0, object, stream) % span;
  const stamp = (patch: MapSamples['features'][number], x: number, y: number) => {
    if (x < 0 || y < 0 || x + patch.width > width || y + patch.height > height || patch.north && y !== 0) return false;
    for (let yy = 0; yy < patch.height; yy++) for (let xx = 0; xx < patch.width; xx++) {
      const cell = (y + yy) * width + x + xx;
      const ink = patch.tiles[yy * patch.width + xx];
      if (tiles[cell] !== CLEAR || blocked[cell] || reserved(x + xx, y + yy)
        && (patch.kind !== 'detail' || !buildableTemplate(TEMPLATES[ink >>> 8].name, ink & 255))) return false;
    }
    for (let yy = 0; yy < patch.height; yy++) for (let xx = 0; xx < patch.width; xx++) {
      const cell = (y + yy) * width + x + xx;
      tiles[cell] = patch.tiles[yy * patch.width + xx];
      if (tiles[cell] !== CLEAR) blocked[cell] = 1;
    }
    return true;
  };
  // A few large original formations, not independent small slopes scattered across the map.
  // Their padded bounds also protect clear interiors from later dirt stamps and tree clusters.
  const cliffs: GeneratedMap['cliffs'] = [];
  const groups = Math.max(3, Math.trunc(width / 100)), spacing = 8;
  const candidates = samples.features.filter(p => p.kind === 'cliff'
    && p.height <= battlefield.y - (p.north ? spacing : spacing * 2) && (p.width >= 26 || p.height >= 24))
    .map((patch, i) => ({ patch, order: randomWord(seed, 0, i, 40), i }))
    .sort((a, b) => a.order - b.order || a.i - b.i);
  for (let group = 0; group < groups; group++) {
    const left = Math.trunc(group * width / groups) + spacing, right = Math.trunc((group + 1) * width / groups) - spacing;
    const choice = candidates.findIndex(({ patch }) => patch.width <= right - left);
    if (choice < 0) throw new Error('Not enough complete cliff formations for the northern terrain.');
    const { patch } = candidates.splice(choice, 1)[0];
    const x = left + rand(group, 41, right - left - patch.width + 1);
    const y = patch.north ? 0 : spacing + rand(group, 42, battlefield.y - spacing * 2 - patch.height + 1);
    if (!stamp(patch, x, y)) throw new Error('A cliff formation overlaps a reserved battle region.');
    cliffs.push({ bounds: { x, y, width: patch.width, height: patch.height }, source: patch.source });
    for (let yy = Math.max(0, y - 4); yy < y + patch.height + 4; yy++)
      blocked.fill(1, yy * width + x - 4, yy * width + x + patch.width + 4);
  }
  const details = samples.features.filter(p => p.kind === 'detail');
  for (let i = 0; i < Math.trunc(width * height / 450); i++) {
    const patch = details[rand(i, 50, details.length)];
    stamp(patch, rand(i, 51, width - patch.width + 1), rand(i, 52, shoreTop));
  }
  const trees = [...new Set(samples.maps.flatMap(m => m.scenario.terrain.map(t => t.type.toUpperCase())))]
    .filter(name => /^T\d|^TC\d/.test(name) && TERRAIN.has(name)).sort();
  const clearGround = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height
    && tiles[y * width + x] === CLEAR && !blocked[y * width + x];
  const clearCell = (x: number, y: number) => clearGround(x, y) && !reserved(x, y);
  for (let cluster = 0; cluster < Math.trunc(width * height / 650); cluster++) {
    const cx = rand(cluster, 60, width), cy = rand(cluster, 61, Math.trunc(height * 3 / 4));
    const radius = 3 + rand(cluster, 62, 10), density = 8 + rand(cluster, 63, 28);
    for (let i = 0; i < density; i++) {
      const object = cluster * 64 + i, x = cx + rand(object, 64, radius * 2 + 1) - radius;
      const y = cy + rand(object, 65, radius * 2 + 1) - radius;
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius || !trees.length) continue;
      const type = trees[rand(object, 66, trees.length)], footprint = TERRAIN.get(type)!.occupy;
      if (!clearCell(x, y) || !footprint.every(([dx, dy]) => clearCell(x + dx, y + dy))) continue;
      scenario.terrain.push({ type, cell: y * width + x });
      blocked[y * width + x] = 1;
      for (const [dx, dy] of footprint) blocked[(y + dy) * width + x + dx] = 1;
    }
  }
  // Equal target counts on each side; individual field outlines differ with the seed.
  for (let side = 0; side < 2; side++) for (let field = 0; field < 2; field++) {
    const fieldBounds = mineralFields[side][field];
    const rx = Math.trunc(fieldBounds.width / 2), ry = Math.trunc(fieldBounds.height / 2);
    const cx = fieldBounds.x + rx, cy = fieldBounds.y + ry;
    const candidates: { cell: number; score: number }[] = [];
    for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) {
      const x = cx + dx, y = cy + dy, cell = y * width + x;
      if (!clearGround(x, y) || support.some(rect => inside(x, y, rect))) continue;
      const distance = dx * dx * ry * ry + dy * dy * rx * rx;
      if (distance > rx * rx * ry * ry) continue;
      candidates.push({ cell, score: distance + rand(cell, 70 + side * 2 + field, 16000) });
    }
    candidates.sort((a, b) => a.score - b.score || a.cell - b.cell);
    for (const { cell } of candidates.slice(0, 220)) scenario.overlays.push({ cell, type: 'TI1' });
  }
  for (let cell = 0; cell < tiles.length; cell++) {
    scenario.templates[cell] = tiles[cell] === CLEAR ? 255 : tiles[cell] >>> 8;
    scenario.icons[cell] = tiles[cell] & 255;
  }
  for (let side = 0; side < 2; side++) {
    const rect = deployments[side];
    scenario.waypoints.set(side, (rect.y + Math.trunc(rect.height / 2)) * width + rect.x + Math.trunc(rect.width / 2));
  }
  scenario.waypoints.set(26, Math.trunc(height / 2) * width + Math.trunc(width / 2));
  return { ...layout, scenario, seed, shoreline, cliffs, sampleCount: samples.maps.length };
}

/** Sample-derived joins are an independent rule set, not a golden image of generator output. */
export function invalidMapEdges(samples: MapSamples, scenario: Scenario) {
  const width = scenario.mapWidth ?? 64, height = scenario.mapHeight ?? 64;
  const tile = (cell: number) => scenario.templates[cell] === 255 ? CLEAR : scenario.templates[cell] * 256 + scenario.icons[cell];
  const errors: { x: number; y: number; direction: string; a: string; b: string }[] = [];
  const describe = (key: number) => `${TEMPLATES[key >>> 8]?.name}:${key & 255}`;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const cell = y * width + x, a = tile(cell);
    if (x + 1 < width && !samples.east.get(a)?.has(tile(cell + 1))) errors.push({ x, y, direction: 'east', a: describe(a), b: describe(tile(cell + 1)) });
    if (y + 1 < height && !samples.south.get(a)?.has(tile(cell + width))) errors.push({ x, y, direction: 'south', a: describe(a), b: describe(tile(cell + width)) });
  }
  return errors;
}
