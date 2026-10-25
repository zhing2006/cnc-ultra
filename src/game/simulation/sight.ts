import { trailingZeros } from '../../engine/simulation/integer-nodes.ts';
import { loop as Loop } from '../../engine/simulation/loop.ts';
// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, Break, int, uint, storage, instanceIndex, atomicStore, atomicOr, atomicLoad, select, abs } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { intMax, intMin } from '../../engine/simulation/integer-nodes.ts';
import { DIRECTIONS } from '../../engine/simulation/state.ts';
import { CARD_SHADOW, DIAG_SHADOW, SIGHT_COUNT, SIGHT_OFFSETS } from '../data/sight.ts';
import { MOVEMENT,movementType } from '../data/movement.ts';
import { WORDS, UX, UY, UOWNER, UTYPE, UHEALTH, UATTACHED,UDOMAIN, type UnitsSetup } from './units-state.ts';
type SightBounds = NonNullable<UnitsSetup['bounds']>;
/** Ported from DISPLAY.CPP, Cell_Shadow. */
export function cellShadow(mapped: Int32Array, width: number, height: number, cell: number) {
  const x = cell % width;
  const y = Math.floor(cell / width);
  if (y < 1 || y >= height - 1)
    return -2;
  if (mapped[cell])
    return -1;
  const has = (dx: number, dy: number) => x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height ? mapped[cell + dy * width + dx] : 0;
  const card = CARD_SHADOW[has(0, -1) | has(1, 0) << 1 | has(0, 1) << 2 | has(-1, 0) << 3];
  return card !== -2 ? card : DIAG_SHADOW[has(1, -1) | has(1, 1) << 1 | has(-1, 1) << 2 | has(-1, -1) << 3];
}
export class CpuSight {
  readonly mapped: Int32Array;
  readonly current: Int32Array;
  readonly shadow: Int32Array;
  private readonly previous: Int32Array;
  constructor(readonly width: number, readonly height: number, private readonly count: number, readonly owner = 0,
    readonly bounds: SightBounds = { x: 0, y: 0, width, height }) {
    this.mapped = new Int32Array(width * height);
    this.current = new Int32Array(width * height);
    this.shadow = new Int32Array(width * height).fill(-2);
    this.previous = new Int32Array(count * 2).fill(-1);
  }
  /** Ported from DISPLAY.CPP, Map_Cell, retaining its depth-first neighbor order. */
  private map(cell: number) {
    if (this.mapped[cell])
      return;
    this.mapped[cell] = 1;
    const stack: [
      number,
      number
    ][] = [[cell, 0]];
    while (stack.length) {
      const item = stack[stack.length - 1];
      if (item[1] === 8) {
        stack.pop();
        continue;
      }
      const [dx, dy] = DIRECTIONS[item[1]++];
      const x = item[0] % this.width + dx;
      const y = Math.floor(item[0] / this.width) + dy;
      if (x < 0 || x >= this.width || y < 0 || y >= this.height)
        continue;
      const next = y * this.width + x;
      if (!this.mapped[next] && cellShadow(this.mapped, this.width, this.height, next) === -1) {
        this.mapped[next] = 1;
        stack.push([next, 0]);
      }
    }
  }
  /** Ported from MAP.CPP, Sight_From; the current mask is a diagnostic overlay. */
  step(units: Int32Array) {
    this.current.fill(0);
    for (let id = 0; id < this.count; id++) {
      const at = id * WORDS, prior = id * 2;
      // Design constitution §3: friendly aircraft other than C-17 reveal one cell, including in flight.
      const radius = units[at+UDOMAIN]===1&&units[at+UTYPE]!==movementType('C17')?1:MOVEMENT[units[at + UTYPE]].sight;
      const x = Math.floor(units[at + UX] / 256);
      const y = Math.floor(units[at + UY] / 256);
      const { bounds } = this;
      // Ported from MAP.CPP, Sight_From / In_Radar: reject an off-map source, not its footprint.
      if (units[at + UOWNER] !== this.owner || units[at + UHEALTH] <= 0 || units[at + UATTACHED] !== 0
        || !radius || radius > 10 || x < bounds.x || x >= bounds.x + bounds.width || y < bounds.y || y >= bounds.y + bounds.height) {
        this.previous[prior] = this.previous[prior + 1] = -1;
        continue;
      }
      const center = y * this.width + x;
      const changed = this.previous[prior] !== center || this.previous[prior + 1] !== radius;
      for (let o = 0; o < SIGHT_COUNT[radius]; o++) {
        const [dx, dy] = SIGHT_OFFSETS[o];
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || xx >= this.width || yy < 0 || yy >= this.height || Math.max(Math.abs(dx), Math.abs(dy)) + Math.floor(Math.min(Math.abs(dx), Math.abs(dy)) / 2) > radius)
          continue;
        const cell = yy * this.width + xx;
        this.current[cell] = 1;
        if (changed) this.map(cell);
      }
      this.previous[prior] = center;
      this.previous[prior + 1] = radius;
    }
    for (let cell = 0; cell < this.shadow.length; cell++)
      this.shadow[cell] = cellShadow(this.mapped, this.width, this.height, cell);
  }
}
export class GpuSight {
  get saveBuffers() { return this.attributes; }
  readonly mapped: StorageBufferAttribute;
  readonly current: StorageBufferAttribute;
  readonly shadow: StorageBufferAttribute;
  private readonly attributes: StorageBufferAttribute[] = [];
  readonly kernels: ComputeNode[];
  constructor(readonly renderer: WebGPURenderer, readonly width: number, readonly height: number, units: StorageBufferAttribute, readonly owner = 0,
    readonly bounds: SightBounds = { x: 0, y: 0, width, height }) {
    const count = units.count / WORDS;
    const cells = width * height;
    const keep = (a: Int32Array | Uint32Array) => {
      const b = new StorageBufferAttribute(a, 1);
      this.attributes.push(b);
      return b;
    };
    this.mapped = keep(new Int32Array(cells));
    this.current = keep(new Uint32Array(cells));
    this.shadow = keep(new Int32Array(cells).fill(-2));
    const mapped = storage(this.mapped, 'int', cells).setName('sight_mapped');
    const current = storage(this.current, 'uint', cells).setName('sight_current').toAtomic();
    const shadow = storage(this.shadow, 'int', cells).setName('sight_shadow');
    const u = storage(units, 'int', units.count).setName('sight_u').toReadOnly();
    // A reused actor slot may have a different radius without changing its center cell.
    const previous = storage(keep(new Int32Array(count * 2).fill(-1)), 'int', count * 2).setName('sight_previous');
    const dirtyWords = Math.ceil(count / 32);
    const dirty = storage(keep(new Uint32Array(dirtyWords)), 'uint', dirtyWords).setName('sight_dirty').toAtomic();
    const stack = storage(keep(new Int32Array(cells * 2)), 'int', cells * 2).setName('sight_stack');
    const values = [...CARD_SHADOW, ...DIAG_SHADOW, ...SIGHT_COUNT, ...MOVEMENT.map(t => t.sight), ...SIGHT_OFFSETS.flat()];
    const table = storage(keep(Int32Array.from(values)), 'int', values.length).setName('sight_table').toReadOnly();
    const offsetBase = 43 + MOVEMENT.length;
    const inside = (x: Node<'int'>, y: Node<'int'>) => x.greaterThanEqual(int(0))
      .and(x.lessThan(int(width)))
      .and(y.greaterThanEqual(int(0)))
      .and(y.lessThan(int(height)));
    // Ported from MAP.CPP, Sight_From / In_Radar; revealed neighbors still use grid bounds.
    const inRadar = (x: Node<'int'>, y: Node<'int'>) => x.greaterThanEqual(bounds.x).and(x.lessThan(bounds.x + bounds.width))
      .and(y.greaterThanEqual(bounds.y)).and(y.lessThan(bounds.y + bounds.height));
    const shadowAt = (cell: Node<'int'>) => {
      const x = cell.mod(int(width));
      const y = cell.div(int(width));
      const value = int(-2).toVar();
      If(y.greaterThan(int(0)).and(y.lessThan(int(height - 1))), () => {
        If(mapped.element(cell).notEqual(int(0)), () => {
          value.assign(-1);
        }).Else(() => {
          const has = (dx: number, dy: number) => {
            const result = int(0).toVar();
            If(inside(x.add(int(dx)), y.add(int(dy))), () => {
              result.assign(mapped.element(cell.add(int(dy * width + dx))));
            });
            return result;
          };
          const card = has(0, -1).bitOr(has(1, 0).shiftLeft(int(1))).bitOr(has(0, 1).shiftLeft(int(2))).bitOr(has(-1, 0).shiftLeft(int(3)));
          value.assign(table.element(card));
          If(value.equal(int(-2)), () => {
            const diag = has(1, -1).bitOr(has(1, 1).shiftLeft(int(1))).bitOr(has(-1, 1).shiftLeft(int(2))).bitOr(has(-1, -1).shiftLeft(int(3)));
            value.assign(table.element(diag.add(int(16))));
          });
        });
      });
      return value;
    };
    const clear = Fn(() => {
      atomicStore(current.element(instanceIndex), 0);
    })().compute(cells);
    const clearDirty = Fn(() => {
      atomicStore(dirty.element(instanceIndex), uint(0));
    })().compute(dirtyWords);
    // Current visibility is commutative, so every unit can mark its footprint in parallel.
    const footprint = Fn(() => {
      const id = int(instanceIndex);
      const at = id.mul(int(WORDS));
      const type=u.element(at.add(UTYPE));
      const radius = select(u.element(at.add(UDOMAIN)).equal(1).and(type.notEqual(movementType('C17'))),int(1),table.element(type.add(43)));
      const x = u.element(at).div(int(256));
      const y = u.element(at.add(int(1))).div(int(256));
      const center = y.mul(int(width)).add(x);
      const oldCenter = previous.element(id.mul(2)), oldRadius = previous.element(id.mul(2).add(1));
      If(u.element(at.add(int(UHEALTH))).greaterThan(0).and(u.element(at.add(UATTACHED)).equal(0)).and(u.element(at.add(int(UOWNER))).equal(int(owner)))
        .and(radius.greaterThan(int(0))).and(radius.lessThanEqual(int(10))).and(inRadar(x, y)), () => {
        const unexplored = int(0).toVar();
        Loop({ start: int(0), end: table.element(radius.add(int(32))), type: 'int' }, ({ i: o }) => {
          const dx = table.element(o.mul(int(2)).add(int(offsetBase)));
          const dy = table.element(o.mul(int(2)).add(int(offsetBase + 1)));
          const xx = x.add(dx);
          const yy = y.add(dy);
          If(inside(xx, yy).and(intMax(abs(dx), abs(dy)).add(intMin(abs(dx), abs(dy)).div(int(2))).lessThanEqual(radius)), () => {
            atomicOr(current.element(yy.mul(int(width)).add(xx)), uint(1));
            If(mapped.element(yy.mul(int(width)).add(xx)).equal(int(0)), () => {
              unexplored.assign(1);
            });
          });
        });
        If(oldCenter.notEqual(center).or(oldRadius.notEqual(radius)).and(unexplored.notEqual(int(0))), () => {
          atomicOr(dirty.element(id.div(int(32))), uint(1).shiftLeft(uint(id.mod(int(32)))));
        }).Else(() => {
          oldCenter.assign(center); oldRadius.assign(radius);
        });
      }).Else(() => { oldCenter.assign(-1); oldRadius.assign(-1); });
    })().compute(count);
    const reveal = Fn(() => {
      // Map_Cell can recursively reveal neighbors. Keep its traversal deterministic; only changed
      // footprints with unexplored cells are processed, and mapped cells return immediately.
      Loop(dirtyWords, ({ i: word }) => {
        const bits = atomicLoad(dirty.element(word)).toVar();
        Loop(() => {
          If(bits.equal(uint(0)), () => {
            Break();
          });
          const id = word.mul(int(32)).add(int(trailingZeros(bits))).toVar();
          bits.assign(bits.bitAnd(bits.sub(uint(1))));
          const at = int(id).mul(int(WORDS));
          const type=u.element(at.add(UTYPE));
          const radius = select(u.element(at.add(UDOMAIN)).equal(1).and(type.notEqual(movementType('C17'))),int(1),table.element(type.add(43)));
          const x = u.element(at).div(int(256));
          const y = u.element(at.add(int(1))).div(int(256));
          const center = y.mul(int(width)).add(x);
          If(u.element(at.add(int(UHEALTH))).greaterThan(0).and(u.element(at.add(UATTACHED)).equal(0)).and(u.element(at.add(int(UOWNER))).equal(int(owner)))
            .and(radius.greaterThan(int(0))).and(radius.lessThanEqual(int(10))).and(inRadar(x, y)), () => {
            Loop({ start: int(0), end: table.element(radius.add(int(32))), type: 'int' }, ({ i: o }) => {
              const dx = table.element(int(o).mul(int(2)).add(int(offsetBase)));
              const dy = table.element(int(o).mul(int(2)).add(int(offsetBase + 1)));
              const xx = x.add(dx);
              const yy = y.add(dy);
              const cell = yy.mul(int(width)).add(xx);
              If(inside(xx, yy).and(intMax(abs(dx), abs(dy)).add(intMin(abs(dx), abs(dy)).div(int(2))).lessThanEqual(radius)), () => {
                If(mapped.element(cell).equal(int(0)), () => {
                  mapped.element(cell).assign(1);
                  stack.element(0).assign(cell);
                  stack.element(1).assign(0);
                  const top = int(1).toVar();
                  Loop(() => {
                    If(top.lessThanEqual(int(0)), () => {
                      Break();
                    });
                    const index = top.sub(int(1)).mul(int(2));
                    const parent = stack.element(index);
                    const dir = stack.element(index.add(int(1))).toVar();
                    If(dir.equal(int(8)), () => {
                      top.subAssign(int(1));
                    }).Else(() => {
                      stack.element(index.add(int(1))).addAssign(int(1));
                      const nx = parent.mod(int(width)).toVar();
                      const ny = parent.div(int(width)).toVar();
                      for (let d = 0; d < 8; d++)
                        If(dir.equal(int(d)), () => {
                          nx.addAssign(int(DIRECTIONS[d][0]));
                          ny.addAssign(int(DIRECTIONS[d][1]));
                        });
                      If(inside(nx, ny), () => {
                        const next = ny.mul(int(width)).add(nx);
                        If(mapped.element(next).equal(int(0)), () => {
                          If(shadowAt(next).equal(int(-1)), () => {
                            mapped.element(next).assign(1);
                            stack.element(top.mul(int(2))).assign(next);
                            stack.element(top.mul(int(2)).add(int(1))).assign(0);
                            top.addAssign(int(1));
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
            previous.element(id.mul(2)).assign(center);
            previous.element(id.mul(2).add(1)).assign(radius);
          });
        });
      });
    })().compute(1);
    const finish = Fn(() => {
      shadow.element(instanceIndex).assign(shadowAt(int(instanceIndex)));
    })().compute(cells);
    this.kernels = [clear, clearDirty, footprint, reveal, finish];
    this.step();
  }
  step() {
    this.renderer.compute(this.kernels);
  }
  dispose() {
    for (const k of this.kernels)
      k.dispose();
    releaseStorage(this.renderer, this.attributes);
  }
}
