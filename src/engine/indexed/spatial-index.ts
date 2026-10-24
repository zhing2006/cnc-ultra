import { StorageBufferAttribute, type ComputeNode, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, Loop, instanceIndex, storage, uniform, uint, int, floor, atomicAdd, atomicStore } from 'three/tsl';
import { intMin, intMax } from '../simulation/integer-nodes.ts';
import { releaseStorage } from '../simulation/resources.ts';

export const BIN_SIZE = 64;

/** Compact bins rebuilt by histogram, prefix sum and scatter. Items within a bin are unordered. */
export class GpuSpatialIndex {
  readonly offsets: StorageBufferAttribute;
  readonly items: StorageBufferAttribute;
  private readonly attributes: StorageBufferAttribute[];
  private readonly passes: ComputeNode[] = [];
  private readonly count = uniform(0, 'uint');
  constructor(private readonly renderer: WebGPURenderer, instances: StorageBufferAttribute,
    capacity: number, columns: number, rows: number, maxWidth: number, maxHeight: number) {
    const bins = columns * rows;
    const entries = Math.max(1, capacity * (Math.ceil(maxWidth / BIN_SIZE) + 1) * (Math.ceil(maxHeight / BIN_SIZE) + 1));
    this.offsets = new StorageBufferAttribute(new Uint32Array(bins + 1), 1);
    this.items = new StorageBufferAttribute(new Uint32Array(entries), 1);
    const counts = new StorageBufferAttribute(new Uint32Array(bins), 1);
    const scratchA = new StorageBufferAttribute(new Uint32Array(bins), 1);
    const scratchB = new StorageBufferAttribute(new Uint32Array(bins), 1);
    this.attributes = [this.offsets, this.items, counts, scratchA, scratchB];
    const counters = storage(counts, 'uint', bins).toAtomic();
    const a = storage(scratchA, 'uint', bins), b = storage(scratchB, 'uint', bins);
    const offsets = storage(this.offsets, 'uint', bins + 1), items = storage(this.items, 'uint', entries);
    const sprites = storage(instances, 'vec4', capacity * 3).toReadOnly();
    this.passes.push(Fn(() => { atomicStore(counters.element(instanceIndex), uint(0)); })().compute(bins));
    const visit = (scatter: boolean) => Fn(() => {
      const id = instanceIndex, rect = sprites.element(id.mul(3));
      If(id.lessThan(this.count).and(rect.z.greaterThan(0)).and(rect.w.greaterThan(0)), () => {
        const left = intMax(int(0), int(floor(rect.x.div(BIN_SIZE))));
        const top = intMax(int(0), int(floor(rect.y.div(BIN_SIZE))));
        const right = intMin(int(columns - 1), int(floor(rect.x.add(rect.z).sub(1).div(BIN_SIZE))));
        const bottom = intMin(int(rows - 1), int(floor(rect.y.add(rect.w).sub(1).div(BIN_SIZE))));
        Loop({ start: top, end: bottom, condition: '<=', type: 'int' },
          { start: left, end: right, condition: '<=', type: 'int' }, ({ i: y, j: x }) => {
            const cell = y.mul(columns).add(x);
            const at = atomicAdd(counters.element(cell), uint(1));
            if (scatter) items.element(at).assign(id);
        });
      });
    })().compute(capacity);
    this.passes.push(visit(false));
    // Reading the histogram through a non-atomic alias happens in a separate dispatch.
    const histogram = storage(counts, 'uint', bins).toReadOnly();
    this.passes.push(Fn(() => { a.element(instanceIndex).assign(histogram.element(instanceIndex)); })().compute(bins));
    let src = a, dst = b;
    for (let stride = 1; stride < bins; stride *= 2) {
      const source = src, destination = dst, offset = stride;
      this.passes.push(Fn(() => {
        const i = instanceIndex, sum = source.element(i).toVar();
        If(i.greaterThanEqual(offset), () => sum.addAssign(source.element(i.sub(offset))));
        destination.element(i).assign(sum);
      })().compute(bins));
      [src, dst] = [dst, src];
    }
    const sums = src;
    this.passes.push(Fn(() => {
      const i = instanceIndex, start = uint(0).toVar();
      If(i.greaterThan(0), () => start.assign(sums.element(i.sub(1))));
      offsets.element(i).assign(start); atomicStore(counters.element(i), start);
      If(i.equal(bins - 1), () => offsets.element(bins).assign(sums.element(i)));
    })().compute(bins));
    this.passes.push(visit(true));
  }
  rebuild(count: number) { this.count.value = count; this.renderer.compute(this.passes); }
  dispose() { for (const pass of this.passes) pass.dispose(); releaseStorage(this.renderer, this.attributes); }
}
