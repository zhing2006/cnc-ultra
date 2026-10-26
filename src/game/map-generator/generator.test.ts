import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { MixFile, MixSet } from '../formats/mix.ts';
import { TEMPLATES } from '../data/templates.ts';
import { TERRAIN } from '../data/terrain.ts';
import { buildableTemplate, templateLand, WALKABLE_LAND } from '../data/land.ts';
import { collectMapSamples } from './samples.ts';
import { generateMap, invalidMapEdges } from './generator.ts';
import { CELL_LEPTONS, distance } from '../coord.ts';
import { combatTypes, weapons } from '../data/combat.ts';
import { movementType } from '../data/movement.ts';

const assets = new URL('../../../assets/dev/', import.meta.url);
const mix = new MixSet(['general.mix', 'temperat.mix'].map(name => new MixFile(readFileSync(new URL(name, assets)))));
const samples = collectMapSamples(mix);
const cases = [384, 512, 640].flatMap(width => [0, 1, 42, 99, 1995, 1996, 2026, 0xffffffff]
  .map(seed => ({ seed, width, height: width === 640 ? 320 : 256 })));

for (const options of cases) test(`generates connected terrain and deployment space for ${options.width}x${options.height}, seed ${options.seed}`, () => {
  const result = generateMap(samples, options), s = result.scenario;
  const width = s.mapWidth!, height = s.mapHeight!;
  // The allowed pairs come from the original INI/BIN maps, not generated-image snapshots.
  expect(invalidMapEdges(samples, s)).toEqual([]);
  const treeCells = new Set(s.terrain.flatMap(tree => TERRAIN.get(tree.type)!.occupy.map(([dx, dy]) => tree.cell + dy * width + dx)));
  const name = (cell: number) => TEMPLATES[s.templates[cell]]?.name ?? 'CLEAR1';
  const contains = (rect: { x: number; y: number; width: number; height: number }, x: number, y: number) =>
    x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
  const nonArmyReserves = [...result.support, ...result.mineralFields.flat()];
  for (let side = 0; side < 2; side++) {
    const army = result.deployments[side], base = result.support[side];
    // Support follows the army's vertical center, rather than retaining a northern map coordinate.
    expect(Math.abs(base.y * 2 + base.height - (army.y * 2 + army.height))).toBeLessThanOrEqual(1);
    expect(contains(army, base.x, base.y)).toBe(true);
    expect(contains(army, base.x + base.width - 1, base.y + base.height - 1)).toBe(true);
    let available = 0;
    for (let y = army.y; y < army.y + army.height; y++) for (let x = army.x; x < army.x + army.width; x++) {
      if (!nonArmyReserves.some(rect => contains(rect, x, y))) available++;
    }
    expect(available).toBeGreaterThanOrEqual(10000);
    expect(result.deploymentCapacity[side]).toBe(available);
    for (const field of result.mineralFields[side]) {
      expect(field.x).toBeGreaterThanOrEqual(0); expect(field.x + field.width).toBeLessThanOrEqual(width);
      expect(field.y).toBeGreaterThanOrEqual(army.y); expect(field.y + field.height).toBeLessThanOrEqual(army.y + army.height);
      expect(field.x + field.width <= base.x || field.x >= base.x + base.width
        || field.y + field.height <= base.y || field.y >= base.y + base.height).toBe(true);
    }
  }
  expect(result.deploymentCapacity[0]).toBe(result.deploymentCapacity[1]);
  for (const rect of [...result.deployments, ...result.support, ...result.mineralFields.flat()]) {
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
      const cell = y * width + x;
      // CDATA.CPP / CONST.CPP: ground must accept construction and vehicle occupancy.
      if (!buildableTemplate(name(cell), s.icons[cell]) || treeCells.has(cell)) throw new Error(`Blocked reserved cell ${x},${y}`);
    }
  }
  // The entire wide front, including its coastal flank, remains open.
  const { battlefield, navalSupport: { front, patrol } } = result;
  expect(battlefield.width * battlefield.height).toBeGreaterThanOrEqual(20000);
  for (let y = battlefield.y; y < battlefield.y + battlefield.height; y++) for (let x = 0; x < width; x++) {
    const cell = y * width + x;
    if (!WALKABLE_LAND[templateLand(name(cell), s.icons[cell])] || treeCells.has(cell)) throw new Error(`Blocked battle corridor ${x},${y}`);
  }
  const weapon = weapons[combatTypes[movementType('BOAT')].primary];
  for (let x = 0; x < width; x++) {
    const cell = patrol.y * width + x;
    // UNIT.CPP Per_Cell_Process keeps the original patrol on a horizontal row across the map.
    if (templateLand(name(cell), s.icons[cell]) !== 2 || treeCells.has(cell)) throw new Error(`Blocked naval patrol at ${x},${patrol.y}`);
    for (let y = front.y; y < front.y + front.height; y++) {
      const target = y * width + x;
      if (!WALKABLE_LAND[templateLand(name(target), s.icons[target])] || treeCells.has(target)) throw new Error(`Blocked coastal front at ${x},${y}`);
      // Read the existing weapon, not the layout's reported range, to catch a detached coastline.
      expect(distance(x * CELL_LEPTONS, patrol.y * CELL_LEPTONS, x * CELL_LEPTONS, y * CELL_LEPTONS)).toBeLessThan(weapon.range);
    }
  }
  for (const rect of result.deployments) {
    expect(front.y).toBeGreaterThanOrEqual(rect.y);
    expect(front.y + front.height).toBeLessThanOrEqual(rect.y + rect.height);
  }
  expect(front.y).toBeGreaterThanOrEqual(battlefield.y);
  expect(front.y + front.height).toBeLessThanOrEqual(battlefield.y + battlefield.height);
  for (let x = 0; x < width; x++) expect(s.templates[(height - 1) * width + x]).toBe(1);
  for (const field of result.mineralFields.flat()) {
    const ore = s.overlays.filter(item => contains(field, item.cell % width, Math.trunc(item.cell / width)));
    expect(ore.length).toBeGreaterThanOrEqual(100);
  }
  for (const item of s.overlays) {
    if (!buildableTemplate(name(item.cell), s.icons[item.cell]) || treeCells.has(item.cell)) throw new Error(`Unplaceable mineral at ${item.cell}`);
    const x = item.cell % width, y = Math.trunc(item.cell / width), side = x < width / 2 ? 0 : 1;
    expect(result.mineralFields[side].some(field => contains(field, x, y))).toBe(true);
    expect(result.support.some(base => contains(base, x, y))).toBe(false);
  }
});

test('preserves complete original cliff formations with clear space between groups', () => {
  const { scenario: s, cliffs } = generateMap(samples, { seed: 1995 });
  const width = s.mapWidth!, slope = (key: number) => /^S\d/.test(TEMPLATES[key >>> 8]?.name ?? '');
  const seen = new Set<number>();
  expect(cliffs.length).toBeGreaterThanOrEqual(3);
  expect(cliffs.length).toBeLessThanOrEqual(6);
  for (const { bounds: b, source } of cliffs) {
    const original = samples.maps.find(map => map.name === source.map)!;
    let slopeCells = 0;
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
      const cell = (b.y + y) * width + b.x + x, tile = s.templates[cell] * 256 + s.icons[cell];
      if (!slope(tile)) continue;
      expect(tile).toBe(original.tiles[(source.y + y) * 64 + source.x + x]);
      seen.add(cell); slopeCells++;
    }
    expect(slopeCells).toBeGreaterThanOrEqual(50);
    // A copied fragment must not silently drop the rest of its connected original slope.
    const sourceStart = [...seen].find(cell => cell % width >= b.x && cell % width < b.x + b.width
      && Math.trunc(cell / width) >= b.y && Math.trunc(cell / width) < b.y + b.height)!;
    const start = (source.y + Math.trunc(sourceStart / width) - b.y) * 64 + source.x + sourceStart % width - b.x;
    const visited = new Set([start]), queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const cell = queue[i], x = cell % 64, y = Math.trunc(cell / 64), originalBounds = original.scenario;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, next = yy * 64 + xx;
        if (xx < originalBounds.x || xx >= originalBounds.x + originalBounds.width
          || yy < originalBounds.y || yy >= originalBounds.y + originalBounds.height || visited.has(next) || !slope(original.tiles[next])) continue;
        visited.add(next); queue.push(next);
      }
    }
    expect(slopeCells).toBe(visited.size);
    for (const { bounds: other } of cliffs) if (other !== b) {
      expect(b.x + b.width + 8 <= other.x || other.x + other.width + 8 <= b.x).toBe(true);
    }
  }
  // Every rendered slope belongs to one preserved group, not a second scatter pass.
  for (let cell = 0; cell < s.templates.length; cell++) if (slope(s.templates[cell] * 256 + s.icons[cell])) expect(seen.has(cell)).toBe(true);
});

test('reproduces all terrain, resources and starting regions from the same seed and size', () => {
  const first = generateMap(samples, { seed: 1995 }), second = generateMap(samples, { seed: 1995 });
  expect(second).toEqual(first);
  const other = generateMap(samples, { seed: 1996 });
  expect(other.scenario.templates).not.toEqual(first.scenario.templates);
  expect(other.scenario.terrain).not.toEqual(first.scenario.terrain);
});
