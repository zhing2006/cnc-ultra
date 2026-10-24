/**
 * Precompose index filters so a shader can walk a pixel's contributors backwards without a stack.
 * Each transition appends one filter on the inside of the current composition.
 */
export function composeFilters(filters: readonly Uint8Array[]) {
  const maps = [Uint8Array.from({ length: 256 }, (_, i) => i)];
  const keys = new Map([[maps[0].join(','), 0]]);
  const transitions: number[] = [];
  for (let row = 0; row < maps.length; row++) {
    for (const filter of filters) {
      const composed = filter.map(index => maps[row][index]);
      const key = composed.join(',');
      let next = keys.get(key);
      if (next === undefined) {
        next = maps.length;
        if (next >= 256) throw new Error('index filters need more than 256 composition states');
        keys.set(key, next);
        maps.push(composed);
      }
      transitions.push(next);
    }
  }
  return { maps: Uint8Array.from(maps.flatMap(map => [...map])), transitions: Uint8Array.from(transitions), count: maps.length };
}
