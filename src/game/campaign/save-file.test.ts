import { expect, it } from 'vitest';
import { decodeSave, encodeSave } from './save-file.ts';

it('preserves signed fixed-point GPU words and campaign metadata across a local save file', () => {
  const state = new Int32Array([-2147483648, -1, 0, 256, 2147483647]);
  const snapshot = { metadata: { mission: 'SCG01EA', frame: 271, side: 'gdi', trigger: { remaining: 1, active: true } },
    buffers: [new Uint8Array(state.buffer), new Uint8Array([255, 0, 47])] };
  const restored = decodeSave<typeof snapshot.metadata>(encodeSave(snapshot));
  expect(restored.metadata).toEqual(snapshot.metadata);
  expect(new Int32Array(restored.buffers[0].buffer)).toEqual(state);
  expect(restored.buffers[1]).toEqual(snapshot.buffers[1]);
});
