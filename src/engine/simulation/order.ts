import { StorageBufferAttribute, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, instanceIndex, storage, select, uniform, atomicStore, atomicMin, atomicLoad } from 'three/tsl';
import { releaseStorage } from './resources.ts';

/**
 * One stable adjacent compare/exchange sweep, using a parallel inclusive maximum scan.
 * Keys are separate signed x,y integers. Equal keys retain their incoming order.
 */
export class GpuOrder {
  readonly order: StorageBufferAttribute;
  private readonly attributes: StorageBufferAttribute[];
  private readonly sweep: ComputeNode[] = [];
  private readonly insertion: ComputeNode[];
  private readonly size;
  private readonly incoming = uniform(0, 'uint');
  constructor(private readonly renderer: WebGPURenderer, keys: StorageBufferAttribute, initial: Uint32Array) {
    const capacity = keys.count / 2;
    this.size = uniform(initial.length, 'uint');
    const values = new Uint32Array(capacity); values.set(initial);
    this.order = new StorageBufferAttribute(values, 1);
    const scratchA = new StorageBufferAttribute(new Uint32Array(capacity), 1);
    const scratchB = new StorageBufferAttribute(new Uint32Array(capacity), 1);
    const output = new StorageBufferAttribute(new Uint32Array(capacity), 1);
    const position = new StorageBufferAttribute(new Uint32Array(1), 1);
    this.attributes = [this.order, scratchA, scratchB, output, position];
    const order = storage(this.order, 'uint', capacity), result = storage(output, 'uint', capacity);
    const key = storage(keys, 'int', capacity * 2).toReadOnly();
    const a = storage(scratchA, 'uint', capacity), b = storage(scratchB, 'uint', capacity);
    const place = storage(position, 'uint', 1).toAtomic();
    const less = (left: Node<'uint'>, right: Node<'uint'>) => key.element(left.mul(2).add(1)).lessThan(key.element(right.mul(2).add(1)))
      .or(key.element(left.mul(2).add(1)).equal(key.element(right.mul(2).add(1)))
        .and(key.element(left.mul(2)).lessThan(key.element(right.mul(2)))));
    this.sweep.push(Fn(() => { a.element(instanceIndex).assign(instanceIndex); })().compute(capacity));
    let src = a, dst = b;
    // Keep CPU dispatch work independent of the object count. Thirty-one stages cover every
    // positive signed buffer index; stages beyond this buffer's size only copy the prefix.
    for (let bit = 0; bit < 31; bit++) {
      const stride = 2 ** bit;
      const source = src, destination = dst, offset = stride;
      this.sweep.push(Fn(() => {
        const i = instanceIndex, winner = source.element(i).toVar();
        If(i.greaterThanEqual(offset).and(i.lessThan(this.size)), () => {
          const previous = source.element(i.sub(offset));
          If(less(order.element(winner), order.element(previous)), () => { winner.assign(previous); });
        });
        destination.element(i).assign(winner);
      })().compute(capacity));
      [src, dst] = [dst, src];
    }
    const prefix = src;
    this.sweep.push(Fn(() => {
      const i = instanceIndex;
      If(i.lessThan(this.size), () => {
        const greatest = order.element(prefix.element(i));
        const selected = greatest.toVar();
        If(i.add(1).lessThan(this.size), () => {
          const next = order.element(i.add(1));
          If(less(next, greatest), () => { selected.assign(next); });
        });
        result.element(i).assign(selected);
      });
    })().compute(capacity));
    const copy = Fn(() => {
      If(instanceIndex.lessThan(this.size), () => { order.element(instanceIndex).assign(result.element(instanceIndex)); });
    })().compute(capacity);
    this.sweep.push(copy);
    this.insertion = [
      Fn(() => { atomicStore(place.element(0), this.size); })().compute(1),
      Fn(() => {
        If(instanceIndex.lessThan(this.size), () => {
          If(less(this.incoming, order.element(instanceIndex)), () => { atomicMin(place.element(0), instanceIndex); });
        });
      })().compute(capacity),
      Fn(() => {
        const i = instanceIndex, at = atomicLoad(place.element(0));
        If(i.lessThanEqual(this.size), () => {
          If(i.equal(at), () => { result.element(i).assign(this.incoming); }).Else(() => {
            result.element(i).assign(order.element(select(i.greaterThan(at), i.sub(1), i)));
          });
        });
      })().compute(capacity),
    ];
  }
  step() { this.renderer.compute(this.sweep); }
  insert(id: number) {
    if (this.size.value >= this.order.count) throw new Error('Ground layer capacity exceeded');
    this.incoming.value = id;
    this.renderer.compute(this.insertion);
    this.size.value++;
    this.renderer.compute(this.sweep[this.sweep.length - 1]);
  }
  dispose() {
    for (const kernel of [...this.sweep, ...this.insertion]) kernel.dispose();
    releaseStorage(this.renderer, this.attributes);
  }
}
