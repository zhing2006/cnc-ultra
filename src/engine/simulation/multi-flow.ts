import { StorageBufferAttribute, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, int, storage, instanceIndex, select } from 'three/tsl';
import { DIRECTIONS, UNREACHABLE, type Grid } from './state.ts';
import { relaxTiles, tiledFlow } from './flow-tiles.ts';
import { releaseStorage } from './resources.ts';

/** Two reserved fields per destination set; readers only see completed generations. */
export class CpuMultiFlowFields {
  readonly fields: Int32Array;
  readonly status: Int32Array;
  readonly distance: Int32Array;
  readonly scratch: Int32Array;
  readonly next: Int32Array;
  constructor(readonly grid: Grid, readonly groups: number, readonly interval: number) {
    this.fields = new Int32Array(groups * 6);
    this.status = new Int32Array(groups * 4);
    for (let group = 0; group < groups; group++) {
      this.fields[group * 6] = this.fields[group * 6 + 3] = -1;
      this.status.set([-1, -1, -interval, 0], group * 4);
    }
    this.distance = new Int32Array(grid.edges.length * groups * 2).fill(UNREACHABLE);
    this.scratch = this.distance.slice(); this.next = new Int32Array(this.distance.length).fill(-1);
  }
  step(mask: Uint32Array, tick: number) {
    const cells = this.grid.edges.length;
    for (let group = 0; group < this.groups; group++) {
      const state = group * 4;
      if (this.status[state + 1] < 0 && tick - this.status[state + 2] >= this.interval) {
        const slot = this.status[state] === group * 2 ? group * 2 + 1 : group * 2;
        this.status[state + 1] = slot; this.status[state + 2] = tick;
        this.fields.set([group, 0, 1], slot * 3);
      }
      const slot = this.status[state + 1];
      if (slot < 0) continue;
      const at = slot * 3, base = slot * cells;
      if (this.fields[at + 2]) {
        for (let cell = 0; cell < cells; cell++) {
          this.distance[base + cell] = this.scratch[base + cell] = mask[group * cells + cell] ? 0 : UNREACHABLE;
          this.next[base + cell] = -1;
        }
        this.fields[at + 2] = 0;
      }
      if (!relaxTiles(this.grid, base, this.distance, this.scratch, true)) continue;
      this.fields[at + 1] = 1;
      for (let cell = 0; cell < cells; cell++) for (let dir = 0; dir < 8; dir++) {
        const other = cell + DIRECTIONS[dir][1] * this.grid.width + DIRECTIONS[dir][0];
        const x=cell%this.grid.width+DIRECTIONS[dir][0],y=Math.trunc(cell/this.grid.width)+DIRECTIONS[dir][1];
        const terminal=x>=0&&y>=0&&x<this.grid.width&&y<this.grid.height&&this.distance[base+other]===0;
        if (((this.grid.edges[cell] & (1 << dir)) || terminal) && this.distance[base + other] + (dir & 1 ? 362 : 256) === this.distance[base + cell]) {
          this.next[base + cell] = other; break;
        }
      }
      this.status[state] = slot; this.status[state + 1] = -1; this.status[state + 3]++;
    }
  }
  buffers() { return [this.fields, this.status, this.distance, this.next]; }
}

export class GpuMultiFlowFields {
  readonly fields: StorageBufferAttribute;
  readonly status: StorageBufferAttribute;
  readonly distance: StorageBufferAttribute;
  readonly next: StorageBufferAttribute;
  readonly prepare;
  readonly kernels;
  private readonly edges: StorageBufferAttribute;
  readonly saveBuffers: StorageBufferAttribute[];
  constructor(private readonly renderer: WebGPURenderer, readonly grid: Grid, mask: StorageBufferAttribute,
    clock: StorageBufferAttribute, groups: number, interval: number) {
    const initial = new CpuMultiFlowFields(grid, groups, interval);
    this.fields = new StorageBufferAttribute(initial.fields, 1);
    this.status = new StorageBufferAttribute(initial.status, 1);
    this.distance = new StorageBufferAttribute(initial.distance, 1);
    this.next = new StorageBufferAttribute(initial.next, 1);
    const scratch = new StorageBufferAttribute(initial.scratch, 1);
    this.edges = new StorageBufferAttribute(Int32Array.from(grid.edges), 1);
    const fields = storage(this.fields, 'int', this.fields.count), status = storage(this.status, 'int', this.status.count);
    const time = storage(clock, 'int', clock.count).toReadOnly();
    const begin = Fn(() => {
      const group = int(instanceIndex), state = group.mul(4);
      If(status.element(state.add(1)).lessThan(int(0)).and(time.element(0).sub(status.element(state.add(2))).greaterThanEqual(int(interval))), () => {
        const slot = select(status.element(state).equal(group.mul(2)), group.mul(2).add(1), group.mul(2)).toVar();
        status.element(state.add(1)).assign(slot); status.element(state.add(2)).assign(time.element(0));
        fields.element(slot.mul(3)).assign(group); fields.element(slot.mul(3).add(1)).assign(0); fields.element(slot.mul(3).add(2)).assign(1);
      });
    })().compute(groups);
    const tiled = tiledFlow(grid, groups * 2, this.fields, this.distance, scratch, this.next, this.edges, mask);
    const publish = Fn(() => {
      const state = int(instanceIndex).mul(4), slot = status.element(state.add(1)).toVar();
      If(slot.greaterThanEqual(int(0)), () => {
        If(fields.element(slot.mul(3).add(1)).notEqual(int(0)), () => {
          status.element(state).assign(slot); status.element(state.add(1)).assign(-1); status.element(state.add(3)).addAssign(1);
        });
      });
    })().compute(groups);
    this.prepare = [begin, tiled.prepare]; this.kernels = [...tiled.kernels, publish];
    this.saveBuffers = [this.fields, this.status, this.distance, this.next, scratch, this.edges, ...tiled.attributes];
  }
  updateEdges(edges: ArrayLike<number>) { (this.edges.array as Int32Array).set(edges); this.edges.needsUpdate = true; }
  step() { this.renderer.compute(this.prepare); this.renderer.compute(this.kernels); }
  buffers() { return [this.fields, this.status, this.distance, this.next]; }
  dispose() { for (const kernel of [...this.prepare, ...this.kernels]) kernel.dispose(); releaseStorage(this.renderer, this.saveBuffers); }
}
