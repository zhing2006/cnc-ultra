import { describe, expect, it } from 'vitest';
import { CpuSimulation } from './cpu.ts';
import { fixedAdd, fixedSub, fixedMul, fixedDiv, hash32 } from './fixed.ts';
import { SimulationClock, DelayedReadback } from './clock.ts';
import { CELL, DEST, KIND, SLOT, DEST_SLOT, UNIT_WORDS, UNREACHABLE, gridEdges } from './state.ts';

describe('integer simulation', () => {
  it('preserves signed fractions and wraps fixed-point arithmetic', () => {
    expect(fixedAdd(0x7fffffff, 1)).toBe(-2147483648);
    expect(fixedSub(-2147483648, 1)).toBe(2147483647);
    expect(fixedMul(-385, 129)).toBe(-194);
    expect(fixedMul(-2147483648, 257)).toBe(2139095040);
    expect(fixedDiv(-385, 129)).toBe(-764);
    expect(fixedDiv(-2147483648, -256)).toBe(-2147483648);
  });
  it('matches an independent Dijkstra distance oracle on rectangular maps and around obstacles', () => {
    for (const [width, height] of [[9, 7], [73, 5]]) {
      const count = width * height;
      const passable = Uint8Array.from({ length: count }, (_, i) => hash32(i + 13) % 7 ? 1 : 0);
      passable[count - 1] = 1;
      const simulation = new CpuSimulation({ grid: gridEdges(width, height, passable), units: [], seed: 1, spots: [[128,128]] });
      simulation.step([{ frame: 1, target: count - 1 }]);
      while (!simulation.control[3]) simulation.step();
      const expected = new Int32Array(count).fill(UNREACHABLE), visited = new Uint8Array(count);
      expected[count - 1] = 0;
      for (;;) {
        let chosen = -1;
        for (let i = 0; i < count; i++) if (!visited[i] && expected[i] < UNREACHABLE && (chosen < 0 || expected[i] < expected[chosen])) chosen = i;
        if (chosen < 0) break;
        visited[chosen] = 1;
        const x = chosen % width, y = Math.floor(chosen / width);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (!passable[n] || (dx && dy && (!passable[y * width + nx] || !passable[ny * width + x]))) continue;
          expected[n] = Math.min(expected[n], expected[chosen] + (dx && dy ? 362 : 256));
        }
      }
      expect(simulation.distance).toEqual(expected);
    }
  });
  it('reserves cells before movement and keeps five infantry slots exclusive under contention', () => {
    const simulation = new CpuSimulation({ grid: gridEdges(9, 9, new Uint8Array(81).fill(1)), seed: 2,
      spots: [[128,128],[64,64],[192,64],[64,192],[192,192]],
      units: [30,31,32,39,41,48,49,50].map((cell, i) => ({ cell, speed: 64, kind: i === 0 ? 0 : 1 })) });
    for (let frame = 1; frame <= 70; frame++) {
      simulation.step(frame === 1 ? [{ frame, target: 40 }] : []);
      const held = new Set<number>(), u = simulation.units;
      for (let i = 0; i < u.length; i += UNIT_WORDS) for (const field of [CELL, DEST]) {
        if (u[i + field] < 0) continue;
        for (let slot = 0; slot < 5; slot++) if (u[i + KIND] === 0 || slot === u[i + (field === CELL ? SLOT : DEST_SLOT)]) {
          const key = u[i + field] * 5 + slot;
          expect(held.has(key)).toBe(false); held.add(key);
        }
      }
    }
    expect(simulation.units[CELL]).toBe(40);
  });
  it('pauses without time debt and delivers readbacks on later ticks', async () => {
    const clock = new SimulationClock(15);
    let frame = 0;
    clock.advance(0, () => frame++); clock.advance(1000, () => frame++);
    expect(frame).toBe(4);
    clock.pause(); clock.advance(60000, () => frame++); clock.advance(60100, () => frame++);
    expect(frame).toBe(5);
    const readback = new DelayedReadback<number>();
    readback.request(5, () => Promise.resolve(42));
    await Promise.resolve();
    expect(readback.take(5)).toBeUndefined();
    expect(readback.take(6)).toEqual({ frame: 5, value: 42 });
  });
  it('lets five infantry share a destination while the remaining infantry wait', () => {
    const simulation = new CpuSimulation({ grid: gridEdges(5, 5, new Uint8Array(25).fill(1)), seed: 9,
      spots: [[128,128],[64,64],[192,64],[64,192],[192,192]],
      units: [6,7,8,11,13,16,17,18].map(cell => ({cell, speed: 32, kind: 1})) });
    for (let frame = 1; frame <= 60; frame++) simulation.step(frame === 1 ? [{frame, target: 12}] : []);
    expect(Array.from(simulation.occupancy.slice(60,65)).every(id => id !== 0)).toBe(true);
    expect(new Set(simulation.occupancy.slice(60,65)).size).toBe(5);
    expect(Array.from({length:8}, (_,i) => simulation.units[i * UNIT_WORDS + CELL]).filter(cell => cell === 12)).toHaveLength(5);
  });
});
