import { StorageBufferAttribute } from 'three/webgpu';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { Fn, If, int, storage } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { movementType } from '../data/movement.ts';
import type { GpuCombat } from '../simulation/combat-gpu.ts';
import type { CpuCombat } from '../simulation/combat-cpu.ts';
import { GUARD, MOVE, CWORDS, CMISSION, CTARGET } from '../simulation/combat-state.ts';
import * as U from '../simulation/units-state.ts';

const BOAT = movementType('BOAT'), LST = movementType('LST');
export const NAVAL_WORDS = 5;
const STRIDE = NAVAL_WORDS, PHASE = 0, BEACH = 1, POLL = 2, GENERATION = 3, TETHER = 4;
export interface NavalMap { width: number; land: Uint8Array; clear: Uint8Array; bounds: { x: number; y: number; width: number; height: number }; desert: boolean }

/** Ported from DISPLAY.CPP Calculated_Cell(SOURCE_BEACH), including the three-column preference. */
export function landingCell(map: NavalMap, occupied: (cell: number) => boolean) {
  const { width, bounds } = map, cells: number[] = [];
  for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
    let row = bounds.y + bounds.height;
    if (map.land[row * width + x] !== 2 || map.land[(row - 1) * width + x] !== 2) continue;
    while (row > bounds.y && map.land[row * width + x] === 2 && !occupied(row * width + x)) row--;
    const cell = row * width + x;
    if (![0, 1, 6].includes(map.land[cell])) continue;
    if ([cell, cell - width, cell - width * 2].every(c => !occupied(c) && !!map.clear[c])) cells.push(cell);
  }
  const alternate = cells.filter((cell, i) => i > 0 && i + 1 < cells.length && cells[i - 1] % width + 1 === cell % width && cells[i + 1] % width - 1 === cell % width);
  const options = alternate.length ? alternate : cells;
  if (!options.length) return -1;
  return options[options.length < 4 ? options.length - 1 : options.length - Math.trunc(options.length / 4)] + (map.desert ? width : 0);
}

/** Original gunboat patrol and hovercraft delivery; ground tracks still perform the actual motion. */
export function stepNaval(battle: CpuCombat, state: Int32Array, map: NavalMap) {
  const u = battle.units, c = battle.state, m = battle.movement, count = battle.setup.units.length, width = map.width;
  for (let id = 0; id < count; id++) {
    const at = id * U.WORDS, p = id * STRIDE, type = u[at + U.UTYPE];
    const parent = u[at + U.UATTACHED] - 1;
    if (parent >= 0 && u[parent * U.WORDS + U.UHEALTH] <= 0) u[at + U.UHEALTH] = 0;
    if (u[at + U.UHEALTH] <= 0 || type !== BOAT && type !== LST) continue;
    if (state[p + GENERATION] !== u[at + U.UGENERATION]) { state.fill(0, p, p + STRIDE); state[p + GENERATION] = u[at + U.UGENERATION]; }
    const occupied = (cell: number) => m.occupancy.subarray(cell * 5, cell * 5 + 5).some(value => value && value !== id + 1);
    if (type === BOAT) {
      c[id * CWORDS + CMISSION] = GUARD;
      if (u[at + U.UDEST] >= 0) continue;
      const x = u[at + U.UCELL] % width;
      if (x <= map.bounds.x - 1) u[at + U.UFACE] = 64;
      else if (x >= map.bounds.x + map.bounds.width) u[at + U.UFACE] = 192;
      u[at + U.UDESIRED] = u[at + U.UFACE];
      m.goals[id] = u[at + U.UCELL] + (u[at + U.UFACE] === 192 ? -1 : 1); m.pathGoals[id] = U.DIRECT_STEP;
      continue;
    }
    if (!state[p + PHASE]) {
      const cell = landingCell(map, occupied);
      if (cell < 0) { u[at + U.UHEALTH] = 0; continue; }
      state[p + BEACH] = cell; state[p + PHASE] = 1;
      u[at + U.UCELL] = (map.bounds.y + map.bounds.height) * width + cell % width;
      u[at + U.UX] = (cell % width) * 256 + 128; u[at + U.UY] = (map.bounds.y + map.bounds.height) * 256 + 128;
    }
    c[id * CWORDS + CMISSION] = MOVE; c[id * CWORDS + CTARGET] = -1;
    if (u[at + U.UDEST] >= 0) continue;
    const cell = u[at + U.UCELL];
    if (state[p + PHASE] === 1) {
      if (cell !== state[p + BEACH]) { m.goals[id] = cell - width; m.pathGoals[id] = U.DIRECT_STEP; continue; }
      state[p + PHASE] = 2;
    }
    if (state[p + PHASE] === 2 && battle.frame >= state[p + POLL]) {
      state[p + POLL] = battle.frame + 15;
      const north = cell - width;
      if (occupied(north) || !map.clear[north]) continue;
      let slot = 0;
      for (let passenger = count - 1; passenger >= 0; passenger--) {
        const pp = passenger * U.WORDS;
        if (u[pp + U.UHEALTH] <= 0 || u[pp + U.UATTACHED] !== id + 1) continue;
        u[pp + U.UATTACHED] = 0; u[pp + U.UCELL] = cell;
        const x = slot ? 64 + ((slot - 1) % 2) * 128 : 128, y = slot ? 64 + Math.trunc((slot - 1) / 2) * 128 : 128;
        u[pp + U.UX] = cell % width * 256 + x; u[pp + U.UY] = Math.trunc(cell / width) * 256 + y;
        // Ported from UNIT.CPP, Unload_Hovercraft_Process: the second passenger
        // holds the hovercraft while all passengers use their unloading sort coordinates.
        u[pp + U.UFLAGS] |= U.UNLOADING;
        if (slot < 2) { state[p + TETHER] = passenger + 1; u[at + U.UFLAGS] |= U.HOVER_TETHERED; }
        u[pp + U.USLOT] = u[pp + U.UDSLOT] = slot++; u[pp + U.UFACE] = u[pp + U.UDESIRED] = 0;
        u[pp + U.UDEST] = -1; u[pp + U.USPEED] = 128; m.goals[passenger] = north; m.pathGoals[passenger] = U.DIRECT_STEP;
        c[passenger * CWORDS + CMISSION] = MOVE;
      }
      state[p + PHASE] = 3;
    }
    if (state[p + PHASE] === 3) {
      const tether = state[p + TETHER] - 1;
      if (tether >= 0 && u[tether * U.WORDS + U.UHEALTH] > 0 && (u[tether * U.WORDS + U.UDEST] >= 0 || u[tether * U.WORDS + U.UCELL] === cell)) continue;
      // UNIT/INFANTRY.CPP Per_Cell_Process -> TECHNO.CPP RADIO_UNLOADED:
      // the next ground sort sees the released contact even before the mission poll.
      u[at + U.UFLAGS] &= ~U.HOVER_TETHERED;
      if (battle.frame < state[p + POLL] || occupied(cell)) continue;
      state[p + PHASE] = 4; state[p + POLL] = battle.frame + 15;
    }
    if (state[p + PHASE] === 4 && battle.frame >= state[p + POLL]) {
      // DRIVE.CPP Exit_Map checks the entire three-column swath before returning.
      state[p + POLL] = battle.frame + 15;
      let blocked = false;
      for (let x = cell % width - 1; x <= cell % width + 1; x++) for (let y = Math.trunc(cell / width) + 1; y < map.bounds.y + map.bounds.height; y++)
        blocked ||= occupied(y * width + x);
      if (blocked) continue;
      state[p + PHASE] = 5;
    }
    if (state[p + PHASE] === 5) {
      if (Math.trunc(cell / width) >= map.bounds.y + map.bounds.height) { u[at + U.UHEALTH] = 0; continue; }
      m.goals[id] = cell + width; m.pathGoals[id] = U.DIRECT_STEP;
    }
  }
}

/** Same decisions on GPU; only a few campaign transports enter the serial delivery pass. */
export class GpuNaval {
  readonly state: StorageBufferAttribute;
  private readonly mapData: StorageBufferAttribute;
  private readonly pass;
  constructor(private readonly battle: GpuCombat, map: NavalMap) {
    const count = battle.setup.units.length, width = map.width, { bounds } = map;
    this.state = new StorageBufferAttribute(new Int32Array(count * STRIDE), 1);
    this.mapData = new StorageBufferAttribute(Int32Array.from([...map.land, ...map.clear]), 1);
    const u = storage(battle.units, 'int', battle.units.count), c = storage(battle.state, 'int', battle.state.count);
    const goals = storage(battle.movement.goals, 'int', count), paths = storage(battle.movement.pathGoals, 'int', count);
    const s = storage(this.state, 'int', count * STRIDE), data = storage(this.mapData, 'int', this.mapData.count).toReadOnly();
    const occupancy = storage(battle.movement.occupancy, 'uint', battle.movement.occupancy.count).toReadOnly();
    const clock = storage(battle.movement.control, 'int', 2).toReadOnly();
    this.pass = Fn(() => {
      Loop({ start: 0, end: count, type: 'int' }, ({ i: id }) => {
        const at = id.mul(U.WORDS), p = id.mul(STRIDE), type = u.element(at.add(U.UTYPE));
        const parent = u.element(at.add(U.UATTACHED)).sub(1);
        If(parent.greaterThanEqual(int(0)), () => { If(u.element(parent.mul(U.WORDS).add(U.UHEALTH)).lessThanEqual(int(0)), () => { u.element(at.add(U.UHEALTH)).assign(0); }); });
        If(u.element(at.add(U.UHEALTH)).greaterThan(int(0)).and(type.equal(BOAT).or(type.equal(LST))), () => {
          const occupied = (cell: import('three/webgpu').Node<'int'>) => {
            const busy = int(0).toVar();
            Loop({ start: 0, end: 5, type: 'int' }, ({ i: spot }) => { const owner = int(occupancy.element(cell.mul(5).add(spot))); If(owner.notEqual(int(0)).and(owner.notEqual(id.add(1))), () => { busy.assign(1); }); });
            return busy.notEqual(int(0));
          };
          If(s.element(p.add(GENERATION)).notEqual(u.element(at.add(U.UGENERATION))), () => {
            s.element(p.add(PHASE)).assign(0); s.element(p.add(POLL)).assign(0); s.element(p.add(BEACH)).assign(0); s.element(p.add(TETHER)).assign(0); s.element(p.add(GENERATION)).assign(u.element(at.add(U.UGENERATION)));
          });
          If(type.equal(BOAT), () => {
            c.element(id.mul(CWORDS).add(CMISSION)).assign(GUARD);
            If(u.element(at.add(U.UDEST)).lessThan(int(0)), () => {
              const x = u.element(at.add(U.UCELL)).mod(width);
              If(x.lessThanEqual(int(bounds.x - 1)), () => { u.element(at.add(U.UFACE)).assign(64); });
              If(x.greaterThanEqual(int(bounds.x + bounds.width)), () => { u.element(at.add(U.UFACE)).assign(192); });
              u.element(at.add(U.UDESIRED)).assign(u.element(at.add(U.UFACE)));
              const next = u.element(at.add(U.UCELL)).add(1).toVar();
              If(u.element(at.add(U.UFACE)).equal(int(192)), () => { next.subAssign(2); });
              goals.element(id).assign(next); paths.element(id).assign(U.DIRECT_STEP);
            });
          }).Else(() => {
            // A candidate scan counts the same ordered columns as Calculated_Cell; no CPU readback.
            If(s.element(p.add(PHASE)).equal(int(0)), () => {
              const candidates = int(0).toVar(), wide = int(0).toVar(), previous = int(-10).toVar(), previous2 = int(-10).toVar();
              const chosen = int(-1).toVar(), wideChosen = int(-1).toVar();
              // First count; then choose the original three-quarter entry without storing a list.
              Loop({ start: 0, end: 2, type: 'int' }, ({ i: sweep }) => {
                const seen = int(0).toVar(), wideSeen = int(0).toVar(); previous.assign(-10); previous2.assign(-10);
                Loop({ start: bounds.x, end: bounds.x + bounds.width, type: 'int' }, ({ i: x }) => {
                  const bottom = int((bounds.y + bounds.height) * width).add(x);
                  If(data.element(bottom).equal(int(2)).and(data.element(bottom.sub(width)).equal(int(2))), () => {
                    const row = int(bounds.y + bounds.height).toVar(), searching = int(1).toVar();
                    Loop({ start: 0, end: bounds.height + 1, type: 'int' }, () => { If(searching.notEqual(int(0)).and(row.greaterThan(int(bounds.y))), () => {
                      const cell = row.mul(width).add(x);
                      If(data.element(cell).equal(int(2)).and(occupied(cell).not()), () => { row.subAssign(1); }).Else(() => { searching.assign(0); });
                    }); });
                    const cell = row.mul(width).add(x), land = data.element(cell), clear = int(1).toVar();
                    Loop({ start: 0, end: 3, type: 'int' }, ({ i: inland }) => { const check = cell.sub(inland.mul(width)); If(data.element(check.add(map.land.length)).equal(int(0)).or(occupied(check)), () => { clear.assign(0); }); });
                    If(land.equal(int(0)).or(land.equal(int(1))).or(land.equal(int(6))).and(clear.notEqual(int(0))), () => {
                      If(sweep.equal(int(0)), () => { candidates.addAssign(1); }).Else(() => {
                        const target = candidates.sub(1).toVar(); If(candidates.greaterThanEqual(int(4)), () => { target.assign(candidates.sub(candidates.div(4))); });
                        If(seen.equal(target), () => { chosen.assign(cell); });
                      });
                      seen.addAssign(1);
                      If(previous.mod(width).equal(x.sub(1)).and(previous2.mod(width).equal(x.sub(2))), () => {
                        If(sweep.equal(int(0)), () => { wide.addAssign(1); }).Else(() => {
                          const target = wide.sub(1).toVar(); If(wide.greaterThanEqual(int(4)), () => { target.assign(wide.sub(wide.div(4))); });
                          If(wideSeen.equal(target), () => { wideChosen.assign(previous); });
                        }); wideSeen.addAssign(1);
                      });
                      previous2.assign(previous); previous.assign(cell);
                    });
                  });
                });
              });
              If(wideChosen.greaterThanEqual(int(0)), () => { chosen.assign(wideChosen); });
              If(chosen.lessThan(int(0)), () => { u.element(at.add(U.UHEALTH)).assign(0); }).Else(() => {
                s.element(p.add(BEACH)).assign(chosen.add(map.desert ? width : 0)); s.element(p.add(PHASE)).assign(1);
                u.element(at.add(U.UCELL)).assign(int((bounds.y + bounds.height) * width).add(chosen.mod(width)));
                u.element(at.add(U.UX)).assign(chosen.mod(width).mul(256).add(128)); u.element(at.add(U.UY)).assign((bounds.y + bounds.height) * 256 + 128);
              });
            });
            c.element(id.mul(CWORDS).add(CMISSION)).assign(MOVE); c.element(id.mul(CWORDS).add(CTARGET)).assign(-1);
            If(u.element(at.add(U.UHEALTH)).greaterThan(int(0)).and(u.element(at.add(U.UDEST)).lessThan(int(0))), () => {
              const cell = u.element(at.add(U.UCELL)).toVar();
              If(s.element(p.add(PHASE)).equal(int(1)), () => {
                If(cell.notEqual(s.element(p.add(BEACH))), () => { goals.element(id).assign(cell.sub(width)); paths.element(id).assign(U.DIRECT_STEP); })
                  .Else(() => { s.element(p.add(PHASE)).assign(2); });
              });
              If(s.element(p.add(PHASE)).equal(int(2)).and(clock.element(0).greaterThanEqual(s.element(p.add(POLL)))), () => {
                s.element(p.add(POLL)).assign(clock.element(0).add(15));
                const north = cell.sub(width);
                If(occupied(north).not().and(data.element(north.add(map.land.length)).notEqual(int(0))), () => {
                  const slot = int(0).toVar();
                  Loop({ start: 0, end: count, type: 'int' }, ({ i: i }) => {
                    const passenger = int(count - 1).sub(i), pp = passenger.mul(U.WORDS);
                    If(u.element(pp.add(U.UHEALTH)).greaterThan(int(0)).and(u.element(pp.add(U.UATTACHED)).equal(id.add(1))), () => {
                      u.element(pp.add(U.UATTACHED)).assign(0); u.element(pp.add(U.UCELL)).assign(cell);
                      const x = int(128).toVar(), y = int(128).toVar();
                      If(slot.greaterThan(int(0)), () => { x.assign(slot.sub(1).mod(2).mul(128).add(64)); y.assign(slot.sub(1).div(2).mul(128).add(64)); });
                      u.element(pp.add(U.UX)).assign(cell.mod(width).mul(256).add(x)); u.element(pp.add(U.UY)).assign(cell.div(width).mul(256).add(y));
                      u.element(pp.add(U.UFLAGS)).bitOrAssign(U.UNLOADING);
                      If(slot.lessThan(int(2)), () => { s.element(p.add(TETHER)).assign(passenger.add(1)); u.element(at.add(U.UFLAGS)).bitOrAssign(U.HOVER_TETHERED); });
                      u.element(pp.add(U.USLOT)).assign(slot); u.element(pp.add(U.UDSLOT)).assign(slot); slot.addAssign(1);
                      u.element(pp.add(U.UFACE)).assign(0); u.element(pp.add(U.UDESIRED)).assign(0); u.element(pp.add(U.UDEST)).assign(-1); u.element(pp.add(U.USPEED)).assign(128);
                      goals.element(passenger).assign(north); paths.element(passenger).assign(U.DIRECT_STEP); c.element(passenger.mul(CWORDS).add(CMISSION)).assign(MOVE);
                    });
                  }); s.element(p.add(PHASE)).assign(3);
                });
              });
              const tether = s.element(p.add(TETHER)).sub(1), waiting = int(0).toVar();
              If(tether.greaterThanEqual(int(0)), () => {
                const passenger = tether.mul(U.WORDS);
                If(u.element(passenger.add(U.UHEALTH)).greaterThan(int(0)).and(u.element(passenger.add(U.UDEST)).greaterThanEqual(int(0)).or(u.element(passenger.add(U.UCELL)).equal(cell))), () => { waiting.assign(1); });
              });
              If(s.element(p.add(PHASE)).equal(int(3)).and(waiting.equal(int(0))), () => {
                u.element(at.add(U.UFLAGS)).bitAndAssign(~U.HOVER_TETHERED);
              });
              If(s.element(p.add(PHASE)).equal(int(3)).and(clock.element(0).greaterThanEqual(s.element(p.add(POLL)))).and(occupied(cell).not()).and(waiting.equal(int(0))), () => {
                s.element(p.add(PHASE)).assign(4); s.element(p.add(POLL)).assign(clock.element(0).add(15));
              });
              If(s.element(p.add(PHASE)).equal(int(4)).and(clock.element(0).greaterThanEqual(s.element(p.add(POLL)))), () => {
                s.element(p.add(POLL)).assign(clock.element(0).add(15));
                const blocked = int(0).toVar();
                Loop({ start: -1, end: 2, type: 'int' }, ({ i: dx }) => {
                  Loop({ start: cell.div(width).add(1), end: bounds.y + bounds.height, type: 'int' }, ({ i: y }) => {
                    If(occupied(y.mul(width).add(cell.mod(width)).add(dx)), () => { blocked.assign(1); });
                  });
                });
                If(blocked.equal(int(0)), () => { s.element(p.add(PHASE)).assign(5); });
              });
              If(s.element(p.add(PHASE)).equal(int(5)), () => {
                If(cell.div(width).greaterThanEqual(int(bounds.y + bounds.height)), () => { u.element(at.add(U.UHEALTH)).assign(0); })
                  .Else(() => { goals.element(id).assign(cell.add(width)); paths.element(id).assign(U.DIRECT_STEP); });
              });
            });
          });
        });
      });
    })().compute(1);
  }
  prepare() { return this.battle.renderer.compileComputeAsync(this.pass); }
  step() { this.battle.renderer.compute(this.pass); this.battle.movement.refreshOccupancy(); }
  dispose() { this.pass.dispose(); releaseStorage(this.battle.renderer, [this.state, this.mapData]); }
}
