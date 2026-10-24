import { StorageBufferAttribute, type WebGPURenderer, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, Loop, int, uint, instanceIndex, storage, uniform, atomicStore, atomicLoad, atomicMin,
  atomicOr, abs, select, ivec2 } from 'three/tsl';
import { intMin, intMax } from './integer-nodes.ts';
import { releaseStorage } from './resources.ts';
import { GpuChecksum } from './checksum.ts';
import { CELL, DEST, DEST_SLOT, DIRECTIONS, FLOW_PASSES, FRAME, KIND, LENGTH, PROGRESS, READY, SLOT,
  SPEED, TARGET, UNIT_WORDS, UNREACHABLE, X, Y, unitState, type MoveCommand, type SimulationSetup } from './state.ts';

export class GpuSimulation {
  readonly units: StorageBufferAttribute;
  readonly control: StorageBufferAttribute;
  readonly distance: StorageBufferAttribute;
  readonly next: StorageBufferAttribute;
  readonly occupancy: StorageBufferAttribute;
  private readonly attributes: StorageBufferAttribute[] = [];
  private readonly kernels: ComputeNode[] = [];
  private readonly tick: ComputeNode[];
  private readonly command: ComputeNode[];
  private readonly target = uniform(-1, 'int');
  private readonly digest: GpuChecksum;
  frame = 0;
  constructor(readonly renderer: WebGPURenderer, readonly setup: SimulationSetup) {
    const buffer = (array: Int32Array | Uint32Array) => {
      const result = new StorageBufferAttribute(array, 1); this.attributes.push(result); return result;
    };
    const kernel = (count: number, body: () => void) => {
      const result = Fn(body)().compute(count); this.kernels.push(result); return result;
    };
    const cells = setup.grid.width * setup.grid.height, count = setup.units.length, slots = setup.spots.length;
    this.units = buffer(unitState(setup));
    this.control = buffer(new Int32Array([0, setup.seed, -1, 0]));
    this.distance = buffer(new Int32Array(cells).fill(UNREACHABLE));
    this.next = buffer(new Int32Array(cells).fill(-1));
    this.occupancy = buffer(new Uint32Array(cells * slots));
    const other = buffer(new Int32Array(cells).fill(UNREACHABLE));
    const u = storage(this.units, 'int', count * UNIT_WORDS);
    const control = storage(this.control, 'int', 4);
    const distance = storage(this.distance, 'int', cells), temporary = storage(other, 'int', cells);
    const next = storage(this.next, 'int', cells);
    const edges = storage(buffer(setup.grid.edges.slice()), 'uint', cells).toReadOnly();
    const occupancy = storage(this.occupancy, 'uint', cells * slots).toAtomic();
    const claims = storage(buffer(new Uint32Array(cells * slots)), 'uint', cells * slots).toAtomic();
    const proposals = storage(buffer(new Int32Array(count)), 'int', count);
    const changed = storage(buffer(new Uint32Array(1)), 'uint', 1).toAtomic();
    const spots = storage(buffer(new Int32Array(setup.spots.flatMap(([x, y]) => [x, y]))), 'int', slots * 2).toReadOnly();
    const point = (cell: Node<'int'>, slot: Node<'int'>) => ivec2(
      cell.mod(setup.grid.width).mul(256).add(spots.element(slot.mul(2))),
      cell.div(setup.grid.width).mul(256).add(spots.element(slot.mul(2).add(1))));

    this.command = [kernel(cells, () => {
      If(this.target.notEqual(control.element(TARGET)), () => {
        const value = select(int(instanceIndex).equal(this.target), int(0), int(UNREACHABLE));
        distance.element(instanceIndex).assign(value); temporary.element(instanceIndex).assign(value);
        next.element(instanceIndex).assign(-1);
      });
    }), kernel(1, () => {
      If(this.target.notEqual(control.element(TARGET)), () => {
        control.element(TARGET).assign(this.target); control.element(READY).assign(0);
      });
    })];
    const clearChanged = kernel(1, () => { atomicStore(changed.element(0), uint(0)); });
    const relax = (source: typeof distance, destination: typeof distance) => kernel(cells, () => {
      If(control.element(TARGET).greaterThanEqual(0).and(control.element(READY).equal(0)), () => {
        const cell = int(instanceIndex), best = source.element(cell).toVar();
        for (let d = 0; d < 8; d++) {
          const [dx, dy] = DIRECTIONS[d];
          If(edges.element(cell).bitAnd(uint(1 << d)).notEqual(0), () => {
            best.assign(intMin(best, source.element(cell.add(dy * setup.grid.width + dx)).add(d & 1 ? 362 : 256)));
          });
        }
        destination.element(cell).assign(best);
        If(best.notEqual(source.element(cell)), () => { atomicOr(changed.element(0), uint(1)); });
      });
    });
    const relaxAB = relax(distance, temporary), relaxBA = relax(temporary, distance);
    const finishFlow = kernel(1, () => {
      If(control.element(TARGET).greaterThanEqual(0).and(atomicLoad(changed.element(0)).equal(0)), () => control.element(READY).assign(1));
    });
    const directions = kernel(cells, () => {
      const cell = int(instanceIndex);
      If(control.element(READY).notEqual(0), () => {
        const chosen = int(-1).toVar();
        If(distance.element(cell).lessThan(UNREACHABLE).and(cell.notEqual(control.element(TARGET))), () => {
          for (let d = 0; d < 8; d++) {
            const [dx, dy] = DIRECTIONS[d], neighbor = cell.add(dy * setup.grid.width + dx);
            If(chosen.lessThan(0).and(edges.element(cell).bitAnd(uint(1 << d)).notEqual(0)), () => {
              If(distance.element(neighbor).add(d & 1 ? 362 : 256).equal(distance.element(cell)), () => chosen.assign(neighbor));
            });
          }
        });
        next.element(cell).assign(chosen);
      });
    });
    const advance = kernel(count, () => {
      const i = instanceIndex.mul(UNIT_WORDS), dest = u.element(i.add(DEST));
      If(dest.greaterThanEqual(0), () => {
        const start = point(u.element(i.add(CELL)), u.element(i.add(SLOT)));
        const end = point(dest, u.element(i.add(DEST_SLOT)));
        const progress = intMin(u.element(i.add(LENGTH)), u.element(i.add(PROGRESS)).add(u.element(i.add(SPEED)))).toVar();
        const position = start.add(end.sub(start).mul(progress).div(u.element(i.add(LENGTH))));
        u.element(i.add(X)).assign(position.x); u.element(i.add(Y)).assign(position.y);
        u.element(i.add(PROGRESS)).assign(progress);
        If(progress.equal(u.element(i.add(LENGTH))), () => {
          u.element(i.add(CELL)).assign(dest); u.element(i.add(SLOT)).assign(u.element(i.add(DEST_SLOT)));
          dest.assign(-1);
        });
      });
    });
    const clearOccupancy = kernel(cells * slots, () => {
      atomicStore(occupancy.element(instanceIndex), uint(0)); atomicStore(claims.element(instanceIndex), uint(0xffffffff));
    });
    const occupy = kernel(count, () => {
      const i = instanceIndex.mul(UNIT_WORDS);
      for (const field of [CELL, DEST]) {
        const cell = u.element(i.add(field));
        If(cell.greaterThanEqual(0), () => {
          Loop(slots, ({ i: slot }) => {
            If(u.element(i.add(KIND)).equal(0).or(int(slot).equal(u.element(i.add(field === CELL ? SLOT : DEST_SLOT)))), () => {
              atomicStore(occupancy.element(cell.mul(slots).add(int(slot))), instanceIndex.add(1));
            });
          });
        });
      }
    });
    const propose = kernel(count, () => {
      const id = instanceIndex, i = id.mul(UNIT_WORDS), cell = next.element(u.element(i.add(CELL)));
      proposals.element(id).assign(-1);
      If(control.element(READY).notEqual(0).and(cell.greaterThanEqual(0)).and(u.element(i.add(DEST)).lessThan(0))
        .and(u.element(i.add(SPEED)).greaterThan(0)), () => {
        const first = cell.mul(slots), chosen = int(-1).toVar(), free = int(0).toVar();
        Loop(slots, ({ i: slot }) => {
          If(atomicLoad(occupancy.element(first.add(int(slot)))).equal(0), () => {
            free.addAssign(1); If(chosen.lessThan(0), () => chosen.assign(int(slot)));
          });
        });
        If(u.element(i.add(KIND)).equal(0).and(free.notEqual(slots)), () => chosen.assign(-1));
        If(chosen.greaterThanEqual(0), () => {
          proposals.element(id).assign(first.add(chosen));
          Loop(slots, ({ i: slot }) => {
            If(u.element(i.add(KIND)).equal(0).or(int(slot).equal(chosen)), () => {
              atomicMin(claims.element(first.add(int(slot))), id);
            });
          });
        });
      });
    });
    const accept = kernel(count, () => {
      const id = instanceIndex, i = id.mul(UNIT_WORDS), proposal = proposals.element(id);
      If(proposal.greaterThanEqual(0), () => {
        const cell = proposal.div(slots), chosen = proposal.mod(slots), won = int(1).toVar();
        Loop(slots, ({ i: slot }) => {
          If(u.element(i.add(KIND)).equal(0).or(int(slot).equal(chosen)), () => {
            If(atomicLoad(claims.element(cell.mul(slots).add(int(slot)))).notEqual(id), () => won.assign(0));
          });
        });
        If(won.notEqual(0), () => {
          u.element(i.add(DEST)).assign(cell); u.element(i.add(DEST_SLOT)).assign(chosen); u.element(i.add(PROGRESS)).assign(0);
          const delta = abs(point(cell, chosen).sub(point(u.element(i.add(CELL)), u.element(i.add(SLOT)))));
          u.element(i.add(LENGTH)).assign(intMax(delta.x, delta.y).add(intMin(delta.x, delta.y).mul(106).div(256)));
        });
      });
    });
    this.tick = [];
    for (let pass = 0; pass < FLOW_PASSES; pass++) this.tick.push(clearChanged, pass & 1 ? relaxBA : relaxAB, finishFlow);
    this.tick.push(directions, advance, clearOccupancy, occupy, propose, accept, clearOccupancy, occupy,
      kernel(1, () => { control.element(FRAME).addAssign(1); }));
    // Compile and initialize before play. No command is active, so only the frame word changes.
    renderer.compute([...this.command, ...this.tick, kernel(1, () => { control.element(FRAME).assign(0); })]);
    this.digest = new GpuChecksum(renderer, this.buffers());
  }
  step(commands: readonly MoveCommand[] = []) {
    for (const command of commands) {
      if (command.frame !== this.frame + 1) throw new Error('Commands must be submitted on their recorded tick');
      this.target.value = command.target; this.renderer.compute(this.command);
    }
    this.renderer.compute(this.tick); this.frame++;
  }
  buffers() { return [this.control, this.units, this.distance, this.next, this.occupancy]; }
  checksum() { return this.digest.read(); }
  async snapshot() {
    const data = await Promise.all(this.buffers().map(buffer => this.renderer.getArrayBufferAsync(buffer)));
    return { control: new Int32Array(data[0]), units: new Int32Array(data[1]), distance: new Int32Array(data[2]),
      next: new Int32Array(data[3]), occupancy: new Uint32Array(data[4]) };
  }
  dispose() { this.digest.dispose(); for (const kernel of this.kernels) kernel.dispose(); releaseStorage(this.renderer, this.attributes); }
}
