import { trailingZeros } from './integer-nodes.ts';
import { StorageBufferAttribute, type ComputeNode, type WebGPURenderer, type Node } from 'three/webgpu';
import { Fn, If, Break, int, uint, storage, instanceIndex, localId, workgroupId, workgroupArray,
  storageBarrier, workgroupBarrier, atomicStore, atomicOr, atomicLoad, atomicMin, wgslFn, select } from 'three/tsl';
import { loop as Loop } from './loop.ts';
import { DIRECTIONS, UNREACHABLE, type Grid } from './state.ts';
import { releaseStorage } from './resources.ts';
import { relaxTiles, tiledFlow } from './flow-tiles.ts';

export const FIELD_WORDS = 3;
export const FIELD_TARGET = 0, FIELD_READY = 1, FIELD_RESET = 2;
const MAX_FIELDS = 64, BUFFER_BUDGET = 16 * 1024 * 1024;
export const flowCapacity = (cells: number, users: number) => Math.max(1, Math.min(users, MAX_FIELDS, Math.floor(BUFFER_BUDGET / (cells * 4))));
export const flowRounds = (cells: number) => cells <= 4096 ? cells : 64;

/** Bounded target cache. Only pool exhaustion can evict a completed, still-referenced field. */
export class CpuFlowFields {
  readonly capacity: number;
  readonly fields: Int32Array;
  readonly lookup: Int32Array;
  readonly distance: Int32Array;
  readonly scratch: Int32Array;
  readonly next: Int32Array;
  readonly schedule = new Int32Array(1);
  private readonly frontier: Set<number>[];
  constructor(readonly grid: Grid, users: number) {
    const cells = grid.edges.length;
    this.capacity = flowCapacity(cells, users);
    this.fields = new Int32Array(this.capacity * FIELD_WORDS);
    for (let slot = 0; slot < this.capacity; slot++) this.fields[slot * FIELD_WORDS] = -1;
    this.lookup = new Int32Array(cells).fill(-1);
    this.distance = new Int32Array(cells * this.capacity).fill(UNREACHABLE);
    this.scratch = this.distance.slice();
    this.next = new Int32Array(this.distance.length).fill(-1);
    this.frontier = Array.from({ length: this.capacity }, () => new Set());
  }
  step(goals: Int32Array) {
    const cells = this.grid.edges.length, requested = new Set(Array.from(goals).filter(goal => goal >= 0));
    for (let slot = 0; slot < this.capacity; slot++) {
      const at = slot * FIELD_WORDS, target = this.fields[at];
      if (target >= 0 && !requested.has(target)) { this.lookup[target] = -1; this.fields.set([-1, 0, 0], at); }
    }
    const pending = [...requested].filter(target => this.lookup[target] < 0)
      .sort((a, b) => (a - this.schedule[0] + cells) % cells - (b - this.schedule[0] + cells) % cells);
    let cursor = 0;
    for (let pass = 0; pass < 2; pass++) for (let slot = 0; slot < this.capacity && cursor < pending.length; slot++) {
      const at = slot * FIELD_WORDS, old = this.fields[at];
      if (pass === 0 ? old >= 0 : old < 0 || !this.fields[at + FIELD_READY]) continue;
      if (old >= 0) this.lookup[old] = -1;
      const target = pending[cursor++]; this.lookup[target] = slot;
      this.fields.set([target, 0, 1], at); this.schedule[0] = (target + 1) % cells;
    }
    for (let slot = 0; slot < this.capacity; slot++) {
      const at = slot * FIELD_WORDS, target = this.fields[at], base = slot * cells;
      if (target < 0 || this.fields[at + FIELD_READY]) continue;
      if (this.fields[at + FIELD_RESET]) {
        this.distance.fill(UNREACHABLE, base, base + cells); this.scratch.fill(UNREACHABLE, base, base + cells);
        this.distance[base + target] = this.scratch[base + target] = 0;
        this.next.fill(-1, base, base + cells); this.frontier[slot] = new Set([target]); this.fields[at + FIELD_RESET] = 0;
      }
      if (cells > 4096) {
        if (relaxTiles(this.grid, base, this.distance, this.scratch)) this.fields[at + FIELD_READY] = 1;
      } else for (let round = 0; round < flowRounds(cells); round++) {
        const changed = new Set<number>();
        for (const cell of this.frontier[slot]) for (let dir = 0; dir < 8; dir++) {
          const [dx, dy] = DIRECTIONS[dir], x = cell % this.grid.width + dx, y = Math.floor(cell / this.grid.width) + dy;
          if (x < 0 || y < 0 || x >= this.grid.width || y >= this.grid.height) continue;
          const other = y * this.grid.width + x;
          if (!(this.grid.edges[other] & (1 << ((dir + 4) & 7)))) continue;
          const candidate = this.distance[base + cell] + (dir & 1 ? 362 : 256);
          if (candidate < this.scratch[base + other]) { this.scratch[base + other] = candidate; changed.add(other); }
        }
        for (const cell of changed) this.distance[base + cell] = this.scratch[base + cell];
        this.frontier[slot] = changed;
        if (!changed.size) { this.fields[at + FIELD_READY] = 1; break; }
      }
      if (!this.fields[at + FIELD_READY]) continue;
      for (let cell = 0; cell < cells; cell++) {
        let chosen = -1;
        for (let dir = 0; dir < 8; dir++) if (chosen < 0 && (this.grid.edges[cell] & (1 << dir))) {
          const [dx, dy] = DIRECTIONS[dir], other = cell + dy * this.grid.width + dx;
          if (this.distance[base + other] + (dir & 1 ? 362 : 256) === this.distance[base + cell]) chosen = other;
        }
        this.next[base + cell] = chosen;
      }
    }
  }
  buffers() { return [this.fields, this.lookup, this.distance, this.next, this.schedule]; }
}

// TSL does not expose workgroupUniformLoad. Barrier/exit branches must be uniform across lanes.
const uniformLoad = wgslFn('fn flowUniformLoad(value: ptr<workgroup, u32>) -> u32 { return workgroupUniformLoad(value); }');
type WorkgroupUint = { element(index: Node<'uint'>): Node<'uint'> };

export class GpuFlowFields {
  readonly capacity: number;
  readonly fields: StorageBufferAttribute;
  readonly lookup: StorageBufferAttribute;
  readonly distance: StorageBufferAttribute;
  readonly next: StorageBufferAttribute;
  readonly schedule: StorageBufferAttribute;
  private readonly attributes: StorageBufferAttribute[] = [];
  readonly kernels: ComputeNode[];
  readonly prepareKernels: ComputeNode[] = [];
  constructor(private readonly renderer: WebGPURenderer, readonly grid: Grid, goals: StorageBufferAttribute) {
    const cells = grid.edges.length, users = goals.count, words = Math.ceil(cells / 32);
    const capacity = this.capacity = flowCapacity(cells, users);
    const keep = (data: Int32Array | Uint32Array) => {
      const attribute = new StorageBufferAttribute(data, 1); this.attributes.push(attribute); return attribute;
    };
    const initial = new Int32Array(capacity * FIELD_WORDS);
    for (let slot = 0; slot < capacity; slot++) initial[slot * FIELD_WORDS] = -1;
    this.fields = keep(initial); this.lookup = keep(new Int32Array(cells).fill(-1));
    this.distance = keep(new Int32Array(cells * capacity).fill(UNREACHABLE));
    this.next = keep(new Int32Array(cells * capacity).fill(-1)); this.schedule = keep(new Int32Array(1));
    const meta = storage(this.fields, 'int', capacity * FIELD_WORDS).setName('flow_meta'), index = storage(this.lookup, 'int', cells).setName('flow_index');
    const dist = storage(this.distance, 'int', cells * capacity).setName('flow_dist'), next = storage(this.next, 'int', cells * capacity).setName('flow_next');
    const schedule = storage(this.schedule, 'int', 1).setName('flow_schedule');
    const scratchAttribute = keep(new Uint32Array(cells * capacity).fill(UNREACHABLE));
    const scratch = storage(scratchAttribute, 'uint', cells * capacity).setName('flow_scratch').toAtomic();
    const requested = storage(keep(new Uint32Array(words)), 'uint', words).setName('flow_requested').toAtomic();
    // A second bitmap skips empty groups of 1024 cells. Traversal remains in
    // ascending cell order, including when the bounded pool must rotate goals.
    const blockWords = Math.ceil(words / 32);
    const requestedBlocks = storage(keep(new Uint32Array(blockWords)), 'uint', blockWords).setName('flow_requested_blocks').toAtomic();
    const pending = storage(keep(new Int32Array(cells)), 'int', cells).setName('flow_pending');
    const goal = storage(goals, 'int', users).setName('flow_goal').toReadOnly();
    const edgeAttribute = keep(Int32Array.from(grid.edges));
    const edge = storage(edgeAttribute, 'int', cells).setName('flow_edge').toReadOnly();
    const clear = Fn(() => {
      atomicStore(requested.element(instanceIndex), uint(0));
      If(instanceIndex.lessThan(uint(blockWords)), () => { atomicStore(requestedBlocks.element(instanceIndex), uint(0)); });
    })().compute(words);
    const request = Fn(() => {
      const target = goal.element(instanceIndex);
      If(target.greaterThanEqual(int(0)), () => {
        const register = () => {
          atomicOr(requested.element(target.div(int(32))), uint(1).shiftLeft(uint(target.mod(int(32)))));
          const word = target.div(int(32));
          atomicOr(requestedBlocks.element(word.div(int(32))), uint(1).shiftLeft(uint(word.mod(int(32)))));
        };
        // One request per contiguous run preserves the set while avoiding thousands
        // of contending atomics when an army shares a destination.
        If(instanceIndex.equal(uint(0)), register).ElseIf(target.notEqual(goal.element(instanceIndex.sub(uint(1)))), register);
      });
    })().compute(users);
    const reconcile = Fn(() => {
      Loop(capacity, ({ i: slot }) => {
        const at = slot.mul(int(FIELD_WORDS)), target = meta.element(at);
        If(target.greaterThanEqual(int(0)), () => {
          const bits = atomicLoad(requested.element(target.div(int(32))));
          If(bits.bitAnd(uint(1).shiftLeft(uint(target.mod(int(32))))).equal(uint(0)), () => {
            index.element(target).assign(-1); meta.element(at).assign(-1);
            meta.element(at.add(int(FIELD_READY))).assign(0); meta.element(at.add(int(FIELD_RESET))).assign(0);
          });
        });
      });
      const size = int(0).toVar(), start = int(-1).toVar();
      Loop(blockWords, ({ i: block }) => {
        const occupied = atomicLoad(requestedBlocks.element(block)).toVar();
        Loop(() => {
          If(occupied.equal(uint(0)), () => { Break(); });
          const word = block.mul(int(32)).add(int(trailingZeros(occupied))).toVar();
          occupied.assign(occupied.bitAnd(occupied.sub(uint(1))));
          const bits = atomicLoad(requested.element(word)).toVar();
          Loop(() => {
            If(bits.equal(uint(0)), () => { Break(); });
            const target = word.mul(int(32)).add(int(trailingZeros(bits))).toVar();
            bits.assign(bits.bitAnd(bits.sub(uint(1))));
            If(index.element(target).lessThan(int(0)), () => {
              If(start.lessThan(int(0)).and(target.greaterThanEqual(schedule.element(0))), () => { start.assign(size); });
              pending.element(size).assign(target); size.addAssign(int(1));
            });
          });
        });
      });
      If(start.lessThan(int(0)), () => { start.assign(0); });
      const taken = int(0).toVar();
      for (let pass = 0; pass < 2; pass++) Loop(capacity, ({ i: slot }) => {
        const at = slot.mul(int(FIELD_WORDS)), old = meta.element(at);
        const available = pass === 0 ? old.lessThan(int(0)) : meta.element(at.add(int(FIELD_READY))).notEqual(int(0));
        If(taken.lessThan(size).and(available), () => {
          If(old.greaterThanEqual(int(0)), () => { index.element(old).assign(-1); });
          const target = pending.element(start.add(taken).mod(size)).toVar(); taken.addAssign(int(1));
          index.element(target).assign(slot); meta.element(at).assign(target);
          meta.element(at.add(int(FIELD_READY))).assign(0); meta.element(at.add(int(FIELD_RESET))).assign(1);
          schedule.element(0).assign(target.add(int(1)).mod(int(cells)));
        });
      });
    })().compute(1);
    if (cells > 4096) {
      const tiled = tiledFlow(grid, capacity, this.fields, this.distance, scratchAttribute, this.next, edgeAttribute);
      this.attributes.push(...tiled.attributes);
      this.prepareKernels = [clear, request, reconcile, tiled.prepare];
      this.kernels = tiled.kernels;
      this.step();
      return;
    }
    const frontier = storage(keep(new Uint32Array(words * capacity)), 'uint', words * capacity).setName('flow_frontier');
    const changed = storage(keep(new Uint32Array(words * capacity)), 'uint', words * capacity).setName('flow_changed').toAtomic();
    const flag = Object.assign(workgroupArray('uint', 1), {name:'flowStatus'}) as unknown as WorkgroupUint;
    const progress = Object.assign(workgroupArray('uint', 1).toAtomic(), {name:'flowProgress'}) as unknown as WorkgroupUint;
    const active = () => uniformLoad({ value: flag.element(uint(0)) }) as Node<'uint'>;
    // Expand only last round's changed cells. Atomic minima see a frozen distance input;
    // the barrier and copy make each round deterministic, including partially solved fields.
    const solve = Fn(() => {
      const slot = int(workgroupId.x), lane = int(localId.x);
      const at = slot.mul(int(FIELD_WORDS)).toVar(), base = slot.mul(int(cells)).toVar(), bitsBase = slot.mul(int(words)).toVar();
      If(lane.equal(int(0)), () => {
        flag.element(uint(0)).assign(uint(meta.element(at).greaterThanEqual(int(0)).and(meta.element(at.add(int(FIELD_READY))).equal(int(0)))));
      });
      If(active().notEqual(uint(0)), () => {
        If(lane.equal(int(0)), () => { flag.element(uint(0)).assign(uint(meta.element(at.add(int(FIELD_RESET))))); });
        If(active().notEqual(uint(0)), () => {
          Loop({ start: lane, end: int(cells), update: '+= 128', type: 'int' }, ({ i: cell }) => {
            const value = select(cell.equal(meta.element(at)), uint(0), uint(UNREACHABLE)).toVar();
            atomicStore(scratch.element(base.add(cell)), value); dist.element(base.add(cell)).assign(int(value));
            next.element(base.add(cell)).assign(-1);
          });
          Loop({ start: lane, end: int(words), update: '+= 128', type: 'int' }, ({ i: word }) => {
            const target = meta.element(at);
            frontier.element(bitsBase.add(word)).assign(select(word.equal(target.div(int(32))), uint(1).shiftLeft(uint(target.mod(int(32)))), uint(0)));
            atomicStore(changed.element(bitsBase.add(word)), uint(0));
          });
          storageBarrier();
        });
        Loop(flowRounds(cells), () => {
          If(lane.equal(int(0)), () => { atomicStore(progress.element(uint(0)), uint(0)); });
          workgroupBarrier();
          Loop({ start: lane, end: int(words), update: '+= 128', type: 'int' }, ({ i: word }) => {
            const bits = frontier.element(bitsBase.add(word)).toVar();
            Loop(() => {
              If(bits.equal(uint(0)), () => { Break(); });
              const cell = word.mul(int(32)).add(int(trailingZeros(bits))).toVar();
              bits.assign(bits.bitAnd(bits.sub(uint(1))));
              const x = cell.mod(int(grid.width)), y = cell.div(int(grid.width));
              for (let dir = 0; dir < 8; dir++) {
                const [dx, dy] = DIRECTIONS[dir], xx = x.add(int(dx)), yy = y.add(int(dy));
                If(xx.greaterThanEqual(int(0)).and(yy.greaterThanEqual(int(0))).and(xx.lessThan(int(grid.width))).and(yy.lessThan(int(grid.height))), () => {
                  const other = cell.add(int(dy * grid.width + dx)).toVar();
                  If(edge.element(other).bitAnd(int(1 << ((dir + 4) & 7))).notEqual(int(0)), () => {
                    const candidate = uint(dist.element(base.add(cell)).add(int(dir & 1 ? 362 : 256))).toVar();
                    const old = atomicMin(scratch.element(base.add(other)), candidate).toVar();
                    If(candidate.lessThan(old), () => {
                      atomicOr(changed.element(bitsBase.add(other.div(int(32)))), uint(1).shiftLeft(uint(other.mod(int(32)))));
                    });
                  });
                });
              }
            });
          });
          storageBarrier();
          const advanced = uint(0).toVar();
          Loop({ start: lane, end: int(words), update: '+= 128', type: 'int' }, ({ i: word }) => {
            const bits = atomicLoad(changed.element(bitsBase.add(word))).toVar();
            advanced.bitOrAssign(bits);
            frontier.element(bitsBase.add(word)).assign(bits); atomicStore(changed.element(bitsBase.add(word)), uint(0));
            Loop(() => {
              If(bits.equal(uint(0)), () => { Break(); });
              const cell = word.mul(int(32)).add(int(trailingZeros(bits))).toVar();
              bits.assign(bits.bitAnd(bits.sub(uint(1)))); dist.element(base.add(cell)).assign(int(atomicLoad(scratch.element(base.add(cell)))));
            });
          });
          storageBarrier();
          // Each lane reports once while copying its frontier words. Convergence
          // no longer requires lane zero to scan a bitmap proportional to map size.
          If(advanced.notEqual(uint(0)), () => { atomicOr(progress.element(uint(0)), uint(1)); });
          workgroupBarrier();
          If(lane.equal(int(0)), () => {
            flag.element(uint(0)).assign(atomicLoad(progress.element(uint(0))));
          });
          If(active().equal(uint(0)), () => {
            If(lane.equal(int(0)), () => { meta.element(at.add(int(FIELD_READY))).assign(1); }); Break();
          });
        });
        storageBarrier();
        If(lane.equal(int(0)), () => {
          meta.element(at.add(int(FIELD_RESET))).assign(0); flag.element(uint(0)).assign(uint(meta.element(at.add(int(FIELD_READY)))));
        });
        // Write directions just once, when this field finishes.
        If(active().notEqual(uint(0)), () => {
          Loop({ start: lane, end: int(cells), update: '+= 128', type: 'int' }, ({ i: cell }) => {
            const chosen = int(-1).toVar();
            for (let dir = 0; dir < 8; dir++) {
              const [dx, dy] = DIRECTIONS[dir], other = cell.add(int(dy * grid.width + dx));
              If(chosen.lessThan(int(0)).and(edge.element(cell).bitAnd(int(1 << dir)).notEqual(int(0))), () => {
                If(dist.element(base.add(other)).add(int(dir & 1 ? 362 : 256)).equal(dist.element(base.add(cell))), () => { chosen.assign(other); });
              });
            }
            next.element(base.add(cell)).assign(chosen);
          });
        });
      });
    })().compute(capacity * 128, [128]);
    this.kernels = [clear, request, reconcile, solve]; renderer.compute(this.kernels);
  }
  step() {
    if (this.prepareKernels.length) this.renderer.compute(this.prepareKernels);
    this.renderer.compute(this.kernels);
  }
  buffers() { return [this.fields, this.lookup, this.distance, this.next, this.schedule]; }
  dispose() { for (const kernel of new Set([...this.prepareKernels,...this.kernels])) kernel.dispose(); releaseStorage(this.renderer, this.attributes); }
}
