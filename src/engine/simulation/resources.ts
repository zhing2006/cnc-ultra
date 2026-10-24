import type { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu';

/** Three r186 has no public disposal method for compute-only storage attributes. */
export function releaseStorage(renderer: WebGPURenderer, attributes: readonly StorageBufferAttribute[]) {
  const owner = renderer as unknown as { _attributes: { delete(attribute: StorageBufferAttribute): void } };
  for (const attribute of attributes) owner._attributes.delete(attribute);
}
