import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { Fn, int, uint, instanceIndex, select, storage, uniform } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import type { GpuSight } from './sight.ts';

export type SightPerspective = 0 | 1 | 'all';

/**
 * One packed display buffer keeps shroud consumers within WebGPU's eight-storage-buffer limit.
 * The projection never writes back to either house's exploration or gameplay visibility.
 */
export class SightView {
  readonly perspective = uniform(0, 'int');
  private readonly packed: StorageBufferAttribute;
  private readonly project;
  private readonly sources: StorageBufferAttribute[];
  private versions: number[] = [];
  private frame = -1;
  readonly mappedAt: (cell: Node<'int'>) => Node<'int'>;
  readonly currentAt: (cell: Node<'int'>) => Node<'uint'>;
  readonly shadowAt: (cell: Node<'int'>) => Node<'int'>;
  constructor(private readonly first: GpuSight, second: GpuSight = first) {
    const cells = first.width * first.height;
    this.sources = [first.mapped, first.current, first.shadow, second.mapped, second.current, second.shadow];
    const sources = [first, second].map(sight => ({
      mapped: storage(sight.mapped, 'int', cells).toReadOnly(),
      current: storage(sight.current, 'uint', cells).toReadOnly(),
      shadow: storage(sight.shadow, 'int', cells).toReadOnly(),
    }));
    this.packed = new StorageBufferAttribute(new Int32Array(cells * 3), 1);
    const out = storage(this.packed, 'int', cells * 3);
    this.project = Fn(() => {
      const cell = int(instanceIndex), at = cell.mul(3);
      const full = this.perspective.equal(-1), other = this.perspective.equal(1);
      out.element(at).assign(select(full, int(1), select(other, sources[1].mapped.element(cell), sources[0].mapped.element(cell))));
      out.element(at.add(1)).assign(int(select(full, sources[0].current.element(cell).bitOr(sources[1].current.element(cell)),
        select(other, sources[1].current.element(cell), sources[0].current.element(cell)))));
      out.element(at.add(2)).assign(select(full, int(-1), select(other, sources[1].shadow.element(cell), sources[0].shadow.element(cell))));
    })().compute(cells);
    const view = storage(this.packed, 'int', cells * 3).toReadOnly();
    this.mappedAt = cell => view.element(cell.mul(3));
    this.currentAt = cell => uint(view.element(cell.mul(3).add(1)));
    this.shadowAt = cell => view.element(cell.mul(3).add(2));
    this.update();
  }
  setPerspective(perspective: SightPerspective) {
    this.perspective.value = perspective === 'all' ? -1 : perspective;
    this.frame = -1;
  }
  update(frame?: number) {
    if (frame !== undefined && frame === this.frame && this.sources.every((source, i) => source.version === this.versions[i])) return;
    this.first.renderer.compute(this.project);
    this.frame = frame ?? -1;
    this.versions = this.sources.map(source => source.version);
  }
  dispose() { this.project.dispose(); releaseStorage(this.first.renderer, [this.packed]); }
}
