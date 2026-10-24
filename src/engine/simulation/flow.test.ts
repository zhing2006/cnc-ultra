import { expect, it } from 'vitest';
import { CpuFlowFields, FIELD_READY, FIELD_WORDS } from './flow.ts';
import { DIRECTIONS, UNREACHABLE, gridEdges, type Grid } from './state.ts';

// Independent integer Dijkstra oracle; no tile or relaxation implementation is shared.
function shortestDistances(grid: Grid, target: number) {
  const distance = new Int32Array(grid.edges.length).fill(UNREACHABLE);
  const buckets = new Map<number, number[]>([[0, [target]]]);
  distance[target] = 0;
  let pending = 1;
  for (let cost = 0; pending; cost++) {
    for (const cell of buckets.get(cost) ?? []) {
      pending--;
      if (distance[cell] !== cost) continue;
      for (let d = 0; d < 8; d++) if (grid.edges[cell] & (1 << d)) {
        const other = cell + DIRECTIONS[d][1] * grid.width + DIRECTIONS[d][0], next = cost + (d & 1 ? 362 : 256);
        if (next >= distance[other]) continue;
        distance[other] = next;
        if (!buckets.has(next)) buckets.set(next, []);
        buckets.get(next)!.push(other); pending++;
      }
    }
    buckets.delete(cost);
  }
  return distance;
}

it.each([false, true])('tiled fields retain exact shortest distances across tile edges (sealed wall: %s)', sealed => {
  const width = 67, height = 65, passable = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < (sealed ? height : 60); y++) passable[y * width + 31] = 0;
  const grid = gridEdges(width, height, passable, true), target = 10 * width + 55;
  const flow = new CpuFlowFields(grid, 1), goals = new Int32Array([target]);
  for (let tick = 0; tick < 20 && !flow.fields[FIELD_READY]; tick++) flow.step(goals);
  const slot = flow.lookup[target];
  expect(flow.fields[slot * FIELD_WORDS + FIELD_READY]).toBe(1);
  expect(flow.distance.slice(slot * passable.length, (slot + 1) * passable.length)).toEqual(shortestDistances(grid, target));
});
