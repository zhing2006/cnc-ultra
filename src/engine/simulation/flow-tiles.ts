import { IndirectStorageBufferAttribute, StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, Break, int, uint, instanceIndex, localId, workgroupId, storage, workgroupArray,
  workgroupBarrier, atomicStore, atomicLoad, atomicOr, select, wgslFn } from 'three/tsl';
import { loop as Loop } from './loop.ts';
import { intMin } from './integer-nodes.ts';
import { DIRECTIONS, UNREACHABLE, type Grid } from './state.ts';

const SIDE = 16, HALO = SIDE + 2, AREA = HALO * HALO;
export const TILE_SWEEPS = 8;

/** Block Jacobi: a sweep reads a frozen halo, then relaxes each tile locally. */
export function relaxTiles(grid: Grid, base: number, distance: Int32Array, scratch: Int32Array) {
  let current = new Int32Array(AREA), other = new Int32Array(AREA);
  for (let sweep = 0; sweep < TILE_SWEEPS; sweep++) {
    const input = sweep & 1 ? scratch : distance, output = sweep & 1 ? distance : scratch;
    let changed = false;
    for (let ty = 0; ty < grid.height; ty += SIDE) for (let tx = 0; tx < grid.width; tx += SIDE) {
      for (let y = 0; y < HALO; y++) for (let x = 0; x < HALO; x++) {
        const gx = tx + x - 1, gy = ty + y - 1, index = y * HALO + x;
        current[index] = other[index] = gx < 0 || gy < 0 || gx >= grid.width || gy >= grid.height
          ? UNREACHABLE : input[base + gy * grid.width + gx];
      }
      for (let round = 0; round < SIDE; round++) {
        let advanced = false;
        for (let y = 0; y < SIDE && ty + y < grid.height; y++) for (let x = 0; x < SIDE && tx + x < grid.width; x++) {
          const cell = (ty + y) * grid.width + tx + x, index = (y + 1) * HALO + x + 1;
          let best = current[index];
          for (let d = 0; d < 8; d++) if (grid.edges[cell] & (1 << d)) {
            best = Math.min(best, current[index + DIRECTIONS[d][1] * HALO + DIRECTIONS[d][0]] + (d & 1 ? 362 : 256));
          }
          other[index] = best;
          advanced ||= best !== current[index];
        }
        [current, other] = [other, current];
        if (!advanced) break;
      }
      for (let y = 0; y < SIDE && ty + y < grid.height; y++) for (let x = 0; x < SIDE && tx + x < grid.width; x++) {
        const cell = base + (ty + y) * grid.width + tx + x, value = current[(y + 1) * HALO + x + 1];
        output[cell] = value;
        changed ||= value !== input[cell];
      }
    }
    // On an unchanged odd sweep both buffers already contain the same field.
    if (!changed) return true;
  }
  return false;
}

type Shared<T extends 'int' | 'uint'> = { element(index: Node<'int'> | Node<'uint'>): Node<T> };
const uniformLoad = wgslFn('fn tileUniformLoad(value: ptr<workgroup, u32>) -> u32 { return workgroupUniformLoad(value); }');

/** One workgroup per 16x16 tile, with dispatch boundaries as global barriers. */
export function tiledFlow(grid: Grid, capacity: number, fields: StorageBufferAttribute,
  distance: StorageBufferAttribute, scratch: StorageBufferAttribute, directions: StorageBufferAttribute, edges: StorageBufferAttribute) {
  const cells = grid.edges.length, columns = Math.ceil(grid.width / SIDE), tiles = columns * Math.ceil(grid.height / SIDE);
  const dispatch = new IndirectStorageBufferAttribute(new Uint32Array(capacity + 3), 1);
  const changes = new StorageBufferAttribute(new Uint32Array(capacity), 1);
  const jobs = storage(dispatch, 'uint', capacity + 3).setName('tile_jobs'), changed = storage(changes, 'uint', capacity).setName('tile_changed').toAtomic();
  const jobList = storage(dispatch, 'uint', capacity + 3).setName('tile_jobList').toReadOnly();
  const meta = storage(fields, 'int', capacity * 3).setName('tile_meta'), edge = storage(edges, 'uint', cells).setName('tile_edge').toReadOnly();
  const a = storage(distance, 'int', distance.count).setName('tile_a'), b = storage(scratch, 'int', scratch.count).setName('tile_b');
  const next = storage(directions, 'int', directions.count).setName('tile_next');
  const indirect = (body: () => void) => {
    const kernel = Fn(body)().computeKernel([128]);
    // Three supports indirect ComputeNode.dispatchSize; its type declaration still omits it.
    (kernel as unknown as { dispatchSize: IndirectStorageBufferAttribute }).dispatchSize = dispatch;
    return kernel;
  };
  const prepare = Fn(() => {
    const count = uint(0).toVar();
    Loop(capacity, ({ i: slot }) => {
      const at = slot.mul(int(3));
      If(meta.element(at).greaterThanEqual(int(0)).and(meta.element(at.add(int(1))).equal(int(0))), () => {
        jobs.element(count.add(uint(3))).assign(uint(slot)); count.addAssign(uint(1));
      });
    });
    jobs.element(0).assign(uint(tiles)); jobs.element(1).assign(count); jobs.element(2).assign(uint(1));
  })().compute(1);
  const tileCells = (body: (slot: Node<'int'>, cell: Node<'int'>, local: Node<'int'>) => void) => {
    const slot = int(jobList.element(workgroupId.y.add(uint(3)))).toVar();
    const tx = int(workgroupId.x).mod(int(columns)).mul(int(SIDE)), ty = int(workgroupId.x).div(int(columns)).mul(int(SIDE));
    Loop({ start: int(localId.x), end: int(SIDE * SIDE), update: '+= 128', type: 'int' }, ({ i }) => {
      const x = tx.add(i.mod(int(SIDE))), y = ty.add(i.div(int(SIDE)));
      If(x.lessThan(int(grid.width)).and(y.lessThan(int(grid.height))), () => body(slot, y.mul(int(grid.width)).add(x), i));
    });
  };
  const initialize = indirect(() => tileCells((slot, cell) => {
    const at = slot.mul(int(3)), index = slot.mul(int(cells)).add(cell);
    If(meta.element(at.add(int(2))).notEqual(int(0)), () => {
      const value = select(cell.equal(meta.element(at)), int(0), int(UNREACHABLE));
      a.element(index).assign(value); b.element(index).assign(value); next.element(index).assign(-1);
    });
  }));
  const clear = Fn(() => { atomicStore(changed.element(instanceIndex), uint(0)); })().compute(capacity);
  const sweep = (input: typeof a, output: typeof a) => {
    // WorkgroupInfoNode.name is supported by Three but missing from its declarations.
    const current = Object.assign(workgroupArray('int', AREA), {name:'tileCurrent'}) as unknown as Shared<'int'>;
    const other = Object.assign(workgroupArray('int', AREA), {name:'tileOther'}) as unknown as Shared<'int'>;
    const progress = Object.assign(workgroupArray('uint', 1).toAtomic(), {name:'tileProgress'}) as unknown as Shared<'uint'>;
    const status = Object.assign(workgroupArray('uint', 1), {name:'tileStatus'}) as unknown as Shared<'uint'>;
    const active = () => uniformLoad({value:status.element(uint(0))}) as Node<'uint'>;
    return indirect(() => {
      const slot = int(jobList.element(workgroupId.y.add(uint(3)))).toVar(), at = slot.mul(int(3)), base = slot.mul(int(cells)).toVar();
      const lane = int(localId.x), tx = int(workgroupId.x).mod(int(columns)).mul(int(SIDE)), ty = int(workgroupId.x).div(int(columns)).mul(int(SIDE));
      If(lane.equal(int(0)), () => { status.element(uint(0)).assign(uint(meta.element(at.add(int(1))).equal(int(0)))); });
      If(active().notEqual(uint(0)), () => {
        Loop({start:lane,end:int(AREA),update:'+= 128',type:'int'}, ({i}) => {
          const x = tx.add(i.mod(int(HALO))).sub(int(1)), y = ty.add(i.div(int(HALO))).sub(int(1));
          const value = int(UNREACHABLE).toVar();
          If(x.greaterThanEqual(int(0)).and(y.greaterThanEqual(int(0))).and(x.lessThan(int(grid.width))).and(y.lessThan(int(grid.height))), () => {
            value.assign(input.element(base.add(y.mul(int(grid.width))).add(x)));
          });
          current.element(i).assign(value); other.element(i).assign(value);
        });
        workgroupBarrier();
        Loop(SIDE, () => {
          If(lane.equal(int(0)), () => { atomicStore(progress.element(uint(0)), uint(0)); });
          workgroupBarrier();
          tileCells((_,cell,i) => {
            const index = i.div(int(SIDE)).add(int(1)).mul(int(HALO)).add(i.mod(int(SIDE))).add(int(1));
            const best = current.element(index).toVar();
            for(let d=0;d<8;d++) If(edge.element(cell).bitAnd(uint(1 << d)).notEqual(uint(0)), () => {
              best.assign(intMin(best,current.element(index.add(int(DIRECTIONS[d][1]*HALO+DIRECTIONS[d][0]))).add(int(d & 1 ? 362 : 256))));
            });
            other.element(index).assign(best);
            If(best.notEqual(current.element(index)), () => { atomicOr(progress.element(uint(0)),uint(1)); });
          });
          workgroupBarrier();
          tileCells((_,cell,i) => {
            const index = i.div(int(SIDE)).add(int(1)).mul(int(HALO)).add(i.mod(int(SIDE))).add(int(1));
            current.element(index).assign(other.element(index));
          });
          workgroupBarrier();
          If(lane.equal(int(0)), () => { status.element(uint(0)).assign(atomicLoad(progress.element(uint(0)))); });
          If(active().equal(uint(0)), () => { Break(); });
        });
        const advanced = uint(0).toVar();
        tileCells((_,cell,i) => {
          const index = i.div(int(SIDE)).add(int(1)).mul(int(HALO)).add(i.mod(int(SIDE))).add(int(1));
          const value = current.element(index);
          If(value.notEqual(input.element(base.add(cell))), () => { advanced.assign(uint(1)); });
          output.element(base.add(cell)).assign(value);
        });
        If(advanced.notEqual(uint(0)), () => { atomicOr(changed.element(slot),uint(1)); });
      });
    });
  };
  const ab = sweep(a,b), ba = sweep(b,a);
  const finish = Fn(() => {
    const slot = int(instanceIndex), at = slot.mul(int(3));
    If(meta.element(at).greaterThanEqual(int(0)).and(meta.element(at.add(int(1))).equal(int(0))), () => {
      If(atomicLoad(changed.element(slot)).equal(uint(0)), () => { meta.element(at.add(int(1))).assign(1); });
      meta.element(at.add(int(2))).assign(0);
    });
  })().compute(capacity);
  const generate = indirect(() => tileCells((slot,cell) => {
    If(meta.element(slot.mul(int(3)).add(int(1))).notEqual(int(0)), () => {
      const base = slot.mul(int(cells)).toVar(), chosen = int(-1).toVar();
      for(let d=0;d<8;d++) {
        const neighbor = cell.add(int(DIRECTIONS[d][1]*grid.width+DIRECTIONS[d][0]));
        If(chosen.lessThan(int(0)).and(edge.element(cell).bitAnd(uint(1<<d)).notEqual(uint(0))), () => {
          If(a.element(base.add(neighbor)).add(int(d&1?362:256)).equal(a.element(base.add(cell))), () => { chosen.assign(neighbor); });
        });
      }
      next.element(base.add(cell)).assign(chosen);
    });
  }));
  const kernels:ComputeNode[]=[initialize];
  for(let pass=0;pass<TILE_SWEEPS;pass++) {
    // Only the final sweep determines convergence at this logical tick boundary.
    if(pass===TILE_SWEEPS-1)kernels.push(clear);
    kernels.push(pass&1?ba:ab);
  }
  kernels.push(finish,generate);
  return { prepare, kernels, attributes:[dispatch,changes] };
}
