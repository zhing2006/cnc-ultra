import { StorageBufferAttribute, type ComputeNode, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, instanceIndex, storage, uint, atomicStore, atomicXor } from 'three/tsl';
import { hashNode } from './integer-nodes.ts';
import { releaseStorage } from './resources.ts';

/** Parallel form of fixed.ts checksum. Buffer order and word positions are part of the digest. */
export class GpuChecksum {
  private readonly output = new StorageBufferAttribute(new Uint32Array(4), 1);
  private readonly kernels: ComputeNode[];
  constructor(private readonly renderer: WebGPURenderer, buffers: readonly StorageBufferAttribute[]) {
    const digest = storage(this.output, 'uint', 4).setName('checksum_digest').toAtomic();
    this.kernels = [Fn(() => { atomicStore(digest.element(instanceIndex), uint(0)); })().compute(4)];
    let offset = 0;
    for (const attribute of buffers) {
      const source = storage(attribute, 'uint', attribute.count).setName('checksum_source').toReadOnly();
      const base = offset, length = attribute.count;
      this.kernels.push(Fn(() => {
        const index = instanceIndex.add(base), word = uint(length).toVar();
        If(instanceIndex.lessThan(length), () => word.assign(source.element(instanceIndex)));
        atomicXor(digest.element(index.bitAnd(3)), hashNode(word.bitXor(hashNode(index))));
      })().compute(length + 1));
      offset += length + 1;
    }
  }
  async read() {
    this.renderer.compute(this.kernels);
    return new Uint32Array(await this.renderer.getArrayBufferAsync(this.output));
  }
  dispose() { for (const kernel of this.kernels) kernel.dispose(); releaseStorage(this.renderer, [this.output]); }
}
