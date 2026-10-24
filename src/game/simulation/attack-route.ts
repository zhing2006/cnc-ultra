import type { Grid } from '../../engine/simulation/state.ts';
import { DIRECTIONS } from '../../engine/simulation/state.ts';
/** Bounded recovery around a blocked attacking unit; ordinary movement still uses flow fields. */
export const ATTACK_ROUTE_RADIUS = 8;
export const ATTACK_ROUTE_SIDE = ATTACK_ROUTE_RADIUS * 2 + 1;
export const ATTACK_ROUTE_CELLS = ATTACK_ROUTE_SIDE * ATTACK_ROUTE_SIDE;
/** Find the first step to a reachable firing cell, treating occupied cells as obstacles. */
export function attackRoute(grid: Grid, start: number, enter: (cell: number) => boolean, fire: (cell: number) => boolean, score: (cell: number) => number) {
  const radius = ATTACK_ROUTE_RADIUS, side = ATTACK_ROUTE_SIDE;
  const left = start % grid.width - radius, top = Math.floor(start / grid.width) - radius;
  const parent = new Int32Array(ATTACK_ROUTE_CELLS).fill(-1);
  const queue = new Int32Array(ATTACK_ROUTE_CELLS);
  const depth = new Int32Array(ATTACK_ROUTE_CELLS).fill(-1);
  const center = radius * side + radius;
  let head = 0, tail = 1;
  let best = -1, bestScore = score(start), firing = -1, firingDepth = Infinity;
  queue[0] = center;
  parent[center] = center;
  depth[center] = 0;
  const result = (local: number) => {
    const path: number[] = [];
    for (let at = local; at !== center; at = parent[at])
      path.push((top + Math.floor(at / side)) * grid.width + left + at % side);
    path.reverse();
    return { step: path[0] ?? start, destination: (top + Math.floor(local / side)) * grid.width + left + local % side, path };
  };
  while (head < tail) {
    const local = queue[head++], x = local % side, y = Math.floor(local / side);
    const cell = (top + y) * grid.width + left + x;
    if (depth[local] > firingDepth)
      break;
    if (fire(cell)) {
      firing = firing < 0 ? local : Math.min(firing, local);
      firingDepth = depth[local];
    }
    const value = score(cell);
    if (value < bestScore || value === bestScore && best >= 0 &&
      (depth[local] < depth[best] || depth[local] === depth[best] && local < best)) {
      best = local;
      bestScore = value;
    }
    if (depth[local] >= firingDepth)
      continue;
    for (let dir = 0; dir < 8; dir++) {
      const nx = x + DIRECTIONS[dir][0], ny = y + DIRECTIONS[dir][1];
      const xx = left + nx, yy = top + ny, next = ny * side + nx;
      if (nx < 0 || ny < 0 || nx >= side || ny >= side || xx < 0 || yy < 0 || xx >= grid.width || yy >= grid.height)
        continue;
      const destination = yy * grid.width + xx;
      if (!(grid.edges[cell] & (1 << dir)))
        continue;
      if (parent[next] >= 0) {
        if (depth[next] === depth[local] + 1)
          parent[next] = Math.min(parent[next], local);
        continue;
      }
      if (parent[next] === -2)
        continue;
      if (!enter(destination)) {
        parent[next] = -2;
        continue;
      }
      parent[next] = local;
      depth[next] = depth[local] + 1;
      queue[tail++] = next;
    }
  }
  if (firing >= 0)
    return result(firing);
  return best < 0 ? { step: -1, destination: -1, path: [] } : result(best);
}
