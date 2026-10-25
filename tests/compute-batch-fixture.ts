import { StorageBufferAttribute } from 'three/webgpu';
import { Fn, int, storage, uniform } from 'three/tsl';
import { batchCompute } from '../src/engine/compute-batch.ts';
import { createRenderer } from '../src/engine/renderer.ts';
import { releaseStorage } from '../src/engine/simulation/resources.ts';

/** Uploads must reach their own dispatch, and a readback must capture its position in the queue. */
export async function compareComputeBatch() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!wrapper) throw new Error('WebGPU is required');
  const renderer = wrapper.three;
  const input = new StorageBufferAttribute(new Int32Array(1), 1);
  const state = new StorageBufferAttribute(new Int32Array(1), 1);
  const output = new StorageBufferAttribute(new Int32Array(5), 1);
  const digit = storage(input, 'int', 1).toReadOnly(), value = storage(state, 'int', 1);
  const result = storage(output, 'int', 5), slot = uniform(0, 'int');
  const append = Fn(() => {
    value.element(0).assign(value.element(0).mul(10).add(digit.element(0)));
    result.element(slot).assign(value.element(0));
  })().compute(1);
  const increment = Fn(() => { value.element(0).addAssign(int(1)); })().compute(1);
  const equal = (actual: Int32Array, expected: number[], label: string) => {
    if (actual.length !== expected.length || expected.some((n, i) => actual[i] !== n))
      throw new Error(`${label}: ${actual.join(',')} != ${expected.join(',')}`);
  };
  const queue = (renderer.backend as unknown as { device: GPUDevice }).device.queue;
  const submit = queue.submit;
  let submissions = 0;
  try {
    await renderer.compileComputeAsync([append, increment]);
    queue.submit = function (commands) { submissions++; return submit.call(this, commands); };
    const writeDigit = (n: number) => {
      (input.array as Int32Array)[0] = n; input.needsUpdate = true; slot.value = n - 1;
      renderer.compute(append);
    };
    let intermediate!: Promise<ArrayBuffer>;
    batchCompute(renderer, () => {
      writeDigit(1); writeDigit(2);
      batchCompute(renderer, () => { writeDigit(3); });
      intermediate = renderer.getArrayBufferAsync(output);
      writeDigit(4); writeDigit(5);
    });
    equal(new Int32Array(await intermediate), [1, 12, 123, 0, 0], 'Readback order');
    equal(new Int32Array(await renderer.getArrayBufferAsync(output)), [1, 12, 123, 1234, 12345], 'Upload order');
    const before = submissions;
    batchCompute(renderer, () => { for (let i = 0; i < 16; i++) renderer.compute(increment); });
    const batchedSubmissions = submissions - before;
    equal(new Int32Array(await renderer.getArrayBufferAsync(state)), [12361], 'All dispatches execute');
    return { dispatches: 16, batchedSubmissions };
  } finally {
    queue.submit = submit;
    append.dispose(); increment.dispose(); releaseStorage(renderer, [input, state, output]);
    wrapper.dispose(); canvas.remove();
  }
}
