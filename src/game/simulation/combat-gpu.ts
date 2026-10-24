// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { IndirectStorageBufferAttribute, StorageBufferAttribute, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, Break, int, uint, ivec2, storage, instanceIndex, select, abs, atomicLoad, atomicStore, atomicOr, atomicAnd, atomicAdd, atomicMin, atomicMax, wgslFn, localId, workgroupId, workgroupArray, workgroupBarrier } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { intMin, intMax, randomNode, trailingZeros } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { combatTypes, weapons, bullets, warheads, ANIMATION_IDS } from '../data/combat.ts';
import { ATTACK_ROUTE_RADIUS, ATTACK_ROUTE_SIDE, ATTACK_ROUTE_CELLS } from './attack-route.ts';
import { PATH_DELAY } from './navigation.ts';
import { MOVEMENT, GROUND_SPEED, movementType } from '../data/movement.ts';
import { movePoint } from '../coord.ts';
import { GpuUnits } from './units-gpu.ts';
import { unitDistance, unitDirection, unitRotate } from './units-nodes.ts';
import * as U from './units-state.ts';
import * as C from './combat-state.ts';
import { GpuSight } from './sight.ts';
type I = Node<'int'>;
type Shared = {
  element(index: Node<'uint'>): Node<'uint'>;
};
const uniformShared = wgslFn('fn uniformShared(p: ptr<workgroup, u32>) -> u32 { return workgroupUniformLoad(p); }');
const BULLET = { HOMING: 0, ARCING: 1, INVISIBLE: 2, FUELED: 3, INACCURATE: 4, ARMING: 5, RANGE: 6, SPEED: 7, ROTATION: 8, WARHEAD: 9 } as const;
const WEAPON = { BULLET: 0, DAMAGE: 1, ROF: 2, RANGE: 3 } as const;
const TYPE = { PRIMARY: 0, SECONDARY: 1, ARMOR: 2, TURRET: 3, TWO_SHOOTER: 4, LOCK_TURRET: 5, CREW: 6, TRANSPORT: 7, EXPLOSION: 8, LAUNCH: 9, PRONE_LAUNCH: 10, IMMUNE: 11, ROTATION: 12, STRENGTH: 13, FIRE_COUNT: 14, PRONE_FIRE_COUNT: 15, LIE_COUNT: 16, UP_COUNT: 17 } as const;
const exchange = wgslFn('fn combatExchange(p: ptr<storage, atomic<u32>, read_write>, v: u32) -> u32 { return atomicExchange(p, v); }');
const bitCount = wgslFn('fn combatBitCount(v: u32) -> u32 { return countOneBits(v); }');
export class GpuCombat {
  readonly movement: GpuUnits;
  readonly state: StorageBufferAttribute;
  readonly projectiles: StorageBufferAttribute;
  readonly sight: GpuSight;
  readonly routeDispatch: IndirectStorageBufferAttribute;
  readonly projectileDispatch: IndirectStorageBufferAttribute;
  private readonly attributes: StorageBufferAttribute[] = [];
  private readonly kernels: ComputeNode[] = [];
  private readonly before: ComputeNode[];
  private readonly routes: ComputeNode[];
  private readonly impacts: ComputeNode[];
  private readonly after: ComputeNode[];
  private readonly syncProjectiles: ComputeNode;
  private projectileVersion = -1;
  private readonly capture: ComputeNode;
  private readonly apply: ComputeNode;
  private readonly commands: StorageBufferAttribute;
  private readonly upload: ComputeNode;
  constructor(readonly renderer: WebGPURenderer, readonly setup: C.CombatSetup) {
    this.movement = new GpuUnits(renderer, setup);
    this.sight = new GpuSight(renderer, setup.grid.width, setup.grid.height, this.movement.units);
    this.sight.step();
    const count = setup.units.length, cells = setup.grid.edges.length, shots = count * C.SHOTS_PER_UNIT;
    const keep = (a: Int32Array | Uint32Array) => {
      const b = new StorageBufferAttribute(a, 1);
      this.attributes.push(b);
      return b;
    };
    const kernel = (n: number, body: () => void) => {
      const k = Fn(body)().compute(n);
      this.kernels.push(k);
      return k;
    };
    this.state = keep(C.initialCombat(setup));
    this.projectiles = keep(C.initialProjectiles(count));
    this.routeDispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
    this.projectileDispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
    this.attributes.push(this.routeDispatch, this.projectileDispatch);
    const routeDispatch = storage(this.routeDispatch, 'uint', 3);
    const projectileDispatch = storage(this.projectileDispatch, 'uint', 3);
    const indirect = (dispatch: IndirectStorageBufferAttribute, body: () => void) => {
      const node = Fn(body)().computeKernel([64]);
      (node as unknown as { dispatchSize: IndirectStorageBufferAttribute }).dispatchSize = dispatch;
      this.kernels.push(node);
      return node;
    };
    const u = storage(this.movement.units, 'int', this.movement.units.count).setName('combat_units');
    const s = storage(this.state, 'int', this.state.count).setName('combat_state');
    const p = storage(this.projectiles, 'int', this.projectiles.count).setName('combat_projectiles');
    const occupancy = storage(this.movement.occupancy, 'uint', cells * 5).toReadOnly();
    const goals = storage(this.movement.goals, 'int', count).setName('combat_goals');
    const paths = storage(this.movement.pathGoals, 'int', count).setName('combat_paths');
    const control = storage(this.movement.control, 'int', 2).setName('combat_clock').toReadOnly();
    const clock = () => control.element(0);
    const unit = (id: I, field: number) => u.element(id.mul(U.WORDS).add(field));
    const state = (id: I, field: number) => s.element(id.mul(C.CWORDS).add(field));
    const shot = (id: I, field: number) => p.element(id.mul(C.BWORDS).add(field));
    const position = (id: I) => ivec2(unit(id, 0), unit(id, 1));
    const values: number[] = [];
    const append = (a: readonly number[]) => { const start = values.length; values.push(...a); return start; };
    const typeBase = append(combatTypes.flatMap((t, i) => [t.primary, t.secondary, t.armor, t.turret, t.twoShooter,
    t.lockTurret, t.crew, t.transport, t.explosion, t.launch, t.proneLaunch, t.immune,
    MOVEMENT[i].rotation, MOVEMENT[i].strength, t.actions[13] ?? 0, t.actions[25] ?? 0, t.actions[16] ?? 0, t.actions[22] ?? 0]));
    const weaponBase = append(weapons.flatMap(w => [w.bullet, w.damage, w.rof, w.range]));
    const bulletBase = append(bullets.flatMap(b => [b.homing, b.arcing, b.invisible, b.fueled, b.inaccurate,
    b.arming, b.range, b.speed, b.rotation, b.warhead]));
    const warheadBase = append(warheads.flatMap(h => [h.spread, ...h.armor]));
    const trigBase = append(Array.from({ length: 256 }, (_, d) => movePoint(0, 0, d, 128)).flat());
    const groundSpeedBase = append(GROUND_SPEED.flat());
    const landBase = append(Array.from(setup.land));
    const locomotionBase = append(MOVEMENT.map(t => t.locomotion));
    const crusherBase = append(combatTypes.map(t => t.crusher));
    const valueBase = append(combatTypes.map(t => t.risk + t.reward));
    const fraidyBase = append(combatTypes.map(t => Number(t.fraidy)));
    const targetableBase = append(combatTypes.map(t => Number(t.targetable)));
    const gestureBase = append(combatTypes.flatMap(t => [t.actions[27*3+1] ?? 0, t.actions[29*3+1] ?? 0]));
    const smokeBase = append(bullets.map(b => b.smoke));
    const openBase = append(Array.from(setup.grid.edges));
    const neighborsBase = append([0, 0, 0, -1, 1, -1, 1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1]);
    const crewBase = append(setup.units.map((_, id) => setup.crewParents?.indexOf(id) ?? -1));
    const table = storage(keep(Int32Array.from(values)), 'int', values.length).setName('combat_data').toReadOnly();
    const type = (id: I, field: number) => table.element(unit(id, U.UTYPE).mul(18).add(typeBase + field));
    const weapon = (id: I, field: number) => table.element(id.mul(4).add(weaponBase + field));
    const bullet = (id: I, field: number) => table.element(id.mul(10).add(bulletBase + field));
    const move = (pos: Node<'ivec2'>, dir: I, length: I) => {
      const at = dir.bitAnd(255).mul(2).add(trigBase);
      return pos.add(ivec2(table.element(at).mul(length).shiftRight(7), table.element(at.add(1)).negate().mul(length).shiftRight(7).negate()));
    };
    const random = (id: I, stream: number, next = false) => int(randomNode(uint(setup.seed), uint(clock().add(next ? 1 : 0)), uint(id), uint(stream)).bitAnd(0x7fffffff));
    // Preserve all 32 random bits before modulo, as in the CPU reference.
    const pick = (id: I, stream: number, n: I, next = false) => int(randomNode(uint(setup.seed), uint(clock().add(next ? 1 : 0)), uint(id), uint(stream)).mod(uint(n)));
    const inside = (x: I, y: I) => x.greaterThanEqual(int(0)).and(y.greaterThanEqual(int(0))).and(x.lessThan(int(setup.grid.width))).and(y.lessThan(int(setup.grid.height)));
    const cellAt = (pos: Node<'ivec2'>) => pos.y.div(256).mul(setup.grid.width).add(pos.x.div(256));
    const targetPoint = (target: I) => {
      const result = ivec2(0).toVar();
      If(target.greaterThanEqual(int(0)), () => { result.assign(position(target)); }).Else(() => {
        const cell = target.negate().sub(2);
        result.assign(ivec2(cell.mod(setup.grid.width).mul(256).add(128), cell.div(setup.grid.width).mul(256).add(128)));
      });
      return result;
    };
    const muzzle = (id: I, which: I, from?: Node<'ivec2'>, facing?: I) => {
      const pos = (from ?? position(id)).toVar(), kind = unit(id, U.UTYPE);
      const dir = (facing ?? select(type(id, TYPE.TURRET).notEqual(int(0)), state(id, C.CTURRET), unit(id, U.UFACE))).toVar();
      const forward = int(0).toVar(), lateral = int(0).toVar();
      // INFANTRY.CPP Fire_Coord: XYP_COORD(0,-5), except E4.
      If(unit(id, U.UKIND).notEqual(int(0)).and(kind.notEqual(int(movementType('E4')))), () => { pos.y.subAssign(53); });
      for (const [name, offset, distance] of [['ARTY', 64, 96], ['LTNK', 32, 192], ['MTNK', 48, 192], ['APC', 48, 48], ['JEEP', 48, 48], ['BGGY', 48, 48]] as const)
        If(kind.equal(int(MOVEMENT.findIndex(t => t.name === name))), () => { pos.assign(move(pos, int(0), int(offset))); forward.assign(distance); });
      If(kind.equal(int(MOVEMENT.findIndex(t => t.name === 'FTNK'))), () => { forward.assign(48); lateral.assign(32); });
      If(kind.equal(int(MOVEMENT.findIndex(t => t.name === 'HTNK'))), () => {
        pos.assign(move(pos, int(0), int(64)));
        forward.assign(select(which.equal(int(0)), int(192), int(8)));
        lateral.assign(select(which.equal(int(0)), int(40), int(64)));
      });
      pos.assign(move(pos, dir.add(select(state(id, C.CSECOND).notEqual(int(0)), int(64), int(192))), lateral));
      return move(pos, dir, forward);
    };
    const inRange = (id: I, target: I, which: I = int(0)) => {
      const w = select(which.equal(int(0)), type(id, TYPE.PRIMARY), type(id, TYPE.SECONDARY)).toVar(), yes = int(0).toVar();
      If(w.greaterThanEqual(int(0)), () => { yes.assign(int(unitDistance(muzzle(id, which), targetPoint(target)).lessThanEqual(weapon(w, WEAPON.RANGE)))); });
      return yes.notEqual(int(0));
    };
    // Bounded replacement for dynamic-obstacle search in FINDPATH.CPP, Find_Path.
    const recoverApproach = (id: I, target: I) => {
      const recovered = int(0).toVar(), primary = type(id, TYPE.PRIMARY).toVar();
      If(primary.lessThan(int(0)).or(inRange(id, target)), () => {
        state(id, C.CLOCAL_ROUTE).assign(0);
        state(id, C.CLOCAL_DEST).assign(-1);
        state(id, C.CROUTE_LENGTH).assign(0);
      }).Else(() => {
        const close = unitDistance(position(id), targetPoint(target)).lessThanEqual(weapon(primary, WEAPON.RANGE).add(512));
        If(state(id, C.CLOCAL_ROUTE).notEqual(int(0)).or(close), () => {
          const failed = unit(id, U.UWAIT).greaterThan(int(0)).or(unit(id, U.URETRIES).lessThan(int(10)))
            .or(state(id, C.CAPPROACH_GOAL).greaterThanEqual(int(0)).and(goals.element(id).lessThan(int(0)))).toVar();
          If(state(id, C.CLOCAL_ROUTE).notEqual(int(0)).or(failed), () => {
            recovered.assign(1);
            state(id, C.CLOCAL_ROUTE).assign(1);
            const stopped = unit(id, U.UDEST).lessThan(int(0)).and(goals.element(id).lessThan(int(0)).or(failed));
            If(stopped.and(state(id, C.CLOCAL_WAIT).equal(int(0))), () => {
              const start = unit(id, U.UCELL).toVar(), targetPos = targetPoint(target).toVar();
              const targetCell = cellAt(targetPos);
              If(state(id, C.CROUTE_TARGET).notEqual(targetCell), () => {
                state(id, C.CROUTE_LENGTH).assign(0);
                state(id, C.CLOCAL_DEST).assign(-1);
                state(id, C.CROUTE_TARGET).assign(targetCell);
              });
              If(state(id, C.CLOCAL_DEST).equal(start), () => { state(id, C.CLOCAL_DEST).assign(-1); });
              const destination = state(id, C.CLOCAL_DEST).toVar();
              If(destination.greaterThanEqual(int(0)), () => {
                const slots = int(0).toVar();
                Loop(5, ({ i }) => {
                  const owner = int(occupancy.element(destination.mul(5).add(i)));
                  If(owner.equal(int(0)).or(owner.equal(id.add(1))), () => { slots.addAssign(1); });
                });
                If(slots.equal(int(0)).or(unit(id, U.UKIND).equal(int(0)).and(slots.lessThan(int(5)))), () => {
                  destination.assign(-1);
                  state(id, C.CLOCAL_DEST).assign(-1);
                  state(id, C.CROUTE_LENGTH).assign(0);
                });
              });
              const step = int(-1).toVar(), goal = destination.toVar();
              const cursor = state(id, C.CROUTE_CURSOR).toVar(), cached = int(-1).toVar(), free = int(0).toVar();
              If(cursor.greaterThan(int(0)).and(cursor.lessThan(state(id, C.CROUTE_LENGTH)))
                .and(s.element(id.mul(C.CWORDS).add(C.CROUTE_PATH).add(cursor).sub(1)).equal(start)), () => {
                cached.assign(s.element(id.mul(C.CWORDS).add(C.CROUTE_PATH).add(cursor)));
                Loop(5, ({ i }) => {
                  const owner = int(occupancy.element(cached.mul(5).add(i)));
                  If(owner.equal(int(0)).or(owner.equal(id.add(1))), () => { free.addAssign(1); });
                });
              });
              If(cached.greaterThanEqual(int(0)).and(free.equal(int(5)).or(unit(id, U.UKIND).notEqual(int(0)).and(free.greaterThan(int(0))))), () => {
                step.assign(cached);
                state(id, C.CROUTE_CURSOR).addAssign(1);
              }).Else(() => {
                state(id, C.CLOCAL_SEARCH).assign(1);
              });
              state(id, C.CLOCAL_DEST).assign(goal);
              goals.element(id).assign(select(step.equal(start), int(-1), step));
              paths.element(id).assign(select(goals.element(id).greaterThanEqual(int(0)), int(U.DIRECT_STEP), int(-1)));
              unit(id, U.UWAIT).assign(0);
              unit(id, U.URETRIES).assign(10);
              unit(id, U.UROUTE).assign(-1);
              unit(id, U.USTALLED).assign(0);
              state(id, C.CLOCAL_WAIT).assign(select(step.lessThan(int(0)), int(PATH_DELAY), int(0)));
            });
          });
        });
      });
      return recovered;
    };
    // A spatial index includes actual centers, independent of reserved movement cells.
    const UNIT_LINK = cells;
    const DEATH_BITS = UNIT_LINK + count, words = Math.ceil(count / 32), QUEUE = DEATH_BITS + words;
    const COMMANDS = QUEUE + count, DAMAGE = COMMANDS + count * 2, CAUSE = DAMAGE + count;
    const factions = Math.max(...setup.units.map(u => u.owner ?? 0)) + 1;
    const THREATS = CAUSE + count, DEATH_COUNT = THREATS + factions * 2;
    const DEAD_CELLS = DEATH_COUNT + 1;
    const regionColumns = Math.ceil(setup.grid.width / 8), regionCount = regionColumns * Math.ceil(setup.grid.height / 8);
    const GUARD_CELLS = DEAD_CELLS + cells, GUARD_REGIONS = GUARD_CELLS + cells * factions;
    const ROUTE_COUNT = GUARD_REGIONS + regionCount * factions, ROUTE_JOBS = ROUTE_COUNT + 1;
    const projectileWords = Math.ceil(shots / 32);
    const PROJECTILE_BITS = ROUTE_JOBS + count, PROJECTILE_COUNT = PROJECTILE_BITS + projectileWords;
    const PROJECTILE_JOBS = PROJECTILE_COUNT + 1, indexSize = PROJECTILE_JOBS + shots;
    const indexAttribute = keep(new Uint32Array(indexSize));
    const index = storage(indexAttribute, 'uint', indexSize).setName('combat_index').toAtomic();
    const frozenIndex = storage(indexAttribute, 'uint', indexSize).setName('combat_frozen_index').toReadOnly();
    const read = (at: I) => int(atomicLoad(index.element(at)));
    const lookupIndex = (at: I) => int(frozenIndex.element(at));
    const write = (at: I, value: I) => atomicStore(index.element(at), uint(value));
    const projectileBit = (id: I) => uint(1).shiftLeft(uint(id.mod(32)));
    // Activity is a compact, persistent bitmap. A retired projectile remains
    // queued for one tick to clear its impact and trail events exactly once.
    this.syncProjectiles = kernel(projectileWords, () => {
      const word = int(instanceIndex), bits = uint(0).toVar();
      Loop(32, ({ i }) => {
        const id = word.mul(32).add(i);
        If(id.lessThan(int(shots)), () => {
          If(shot(id, C.BACTIVE).notEqual(int(0)).or(shot(id, C.BIMPACT).notEqual(int(0)))
            .or(shot(id, C.BTRAIL_TICK).notEqual(int(-1))), () => { bits.bitOrAssign(projectileBit(id)); });
        });
      });
      atomicStore(index.element(word.add(PROJECTILE_BITS)), bits);
    });
    const clearGuards = kernel(cells * factions, () => {
      const id = int(instanceIndex);
      write(id.add(GUARD_CELLS), int(count));
      If(id.lessThan(int(regionCount * factions)), () => { write(id.add(GUARD_REGIONS), int(0)); });
      If(id.equal(int(0)), () => { write(int(ROUTE_COUNT), int(0)); });
    });
    const clearHeads = kernel(cells, () => { write(int(instanceIndex), int(0)); });
    const link = kernel(count, () => {
      const id = int(instanceIndex);
      If(unit(id, U.UHEALTH).greaterThan(int(0)), () => {
        const previous = exchange({ p: index.element(cellAt(position(id))), v: uint(id.add(1)) }) as Node<'uint'>;
        write(id.add(UNIT_LINK), int(previous));
      });
    });
    const forCell = (cell: I, visit: (id: I) => void, lookup = read) => {
      const entry = lookup(cell).toVar();
      Loop(() => {
        If(entry.equal(int(0)), () => { Break(); });
        const id = entry.sub(1).toVar();
        visit(id);
        entry.assign(lookup(id.add(UNIT_LINK)));
      });
    };
    const scan = (id: I) => {
      const best = int(-1).toVar(), primary = type(id, TYPE.PRIMARY).toVar();
      If(primary.greaterThanEqual(int(0)), () => {
        const origin = muzzle(id, int(0)).div(256).toVar();
        const range = weapon(primary, WEAPON.RANGE).toVar();
        If(type(id, TYPE.SECONDARY).greaterThanEqual(int(0)), () => { range.assign(intMax(range, weapon(type(id, TYPE.SECONDARY), 3))); });
        range.assign(range.div(256).add(1));
        const owner = unit(id, U.UOWNER).toVar(), nearby = int(0).toVar();
        Loop({ start: intMax(int(0), origin.y.sub(range).div(8)), end: intMin(int(Math.ceil(setup.grid.height / 8) - 1), origin.y.add(range).div(8)), condition: '<=', type: 'int' }, ({ i: y }) => {
          Loop({ start: intMax(int(0), origin.x.sub(range).div(8)), end: intMin(int(regionColumns - 1), origin.x.add(range).div(8)), condition: '<=', type: 'int' }, ({ i: x }) => {
            nearby.bitOrAssign(lookupIndex(y.mul(regionColumns).add(x).mul(factions).add(owner).add(GUARD_REGIONS)));
          });
        });
        const visit = (x: I, y: I) => {
          If(inside(x, y), () => {
            const chosen = lookupIndex(y.mul(setup.grid.width).add(x).mul(factions).add(owner).add(GUARD_CELLS)).toVar();
            If(chosen.lessThan(int(count)), () => {
              If(inRange(id, chosen).or(inRange(id, chosen, int(1))), () => { best.assign(chosen); });
            });
          });
        };
        // TECHNO.CPP, Greatest_Threat: bestval is not updated in the original range scan.
        If(nearby.notEqual(int(0)), () => {
          Loop({ start: int(1), end: range, type: 'int' }, ({ i: r }) => {
            Loop({ start: r.negate(), end: r, condition: '<=', type: 'int' }, ({ i: x }) => {
              visit(origin.x.add(x), origin.y.sub(r));
              visit(origin.x.add(x), origin.y.add(r));
            });
            Loop({ start: r.negate().add(1), end: r, type: 'int' }, ({ i: y }) => {
              visit(origin.x.sub(r), origin.y.add(y));
              visit(origin.x.add(r), origin.y.add(y));
            });
            If(best.greaterThanEqual(int(0)).and(r.equal(range.div(4)).or(r.equal(range.div(2)))), () => { Break(); });
          });
        });
      });
      return best;
    };
    const mapped = storage(this.sight.mapped, 'int', cells).toReadOnly();
    const shroud = storage(this.sight.shadow, 'int', cells).toReadOnly();
    const discover = kernel(count, () => {
      const id = int(instanceIndex);
      If(state(id, C.CSEEN).equal(int(0)).and(unit(id, U.UHEALTH).greaterThan(int(0))), () => {
        const cell = cellAt(position(id));
        If(mapped.element(cell).notEqual(int(0)).or(shroud.element(cell).notEqual(int(-2))), () => { state(id, C.CSEEN).assign(1); });
      });
    });
    // TECHNO.CPP Evaluate_Object's non-ADVANCED score bottoms out at two.
    // Reduce the first eligible enemy and maximum numerator once per faction.
    // Only nearby enemies can exceed that baseline, so HUNT never scans the map
    // or every unit for each hunter. Equal scores use stable unit IDs.
    const clearThreats = kernel(factions, () => {
      write(int(instanceIndex).mul(2).add(THREATS), int(count));
      write(int(instanceIndex).mul(2).add(THREATS + 1), int(0));
    });
    const threats = kernel(count, () => {
      const id = int(instanceIndex);
      If(unit(id, U.UHEALTH).greaterThan(int(0))
        .and(table.element(unit(id, U.UTYPE).add(targetableBase)).notEqual(int(0))), () => {
          Loop(factions, ({ i }) => {
            If(int(i).notEqual(unit(id, U.UOWNER)), () => {
              const cell = cellAt(position(id)).toVar();
              const region = cell.div(setup.grid.width).div(8).mul(regionColumns).add(cell.mod(setup.grid.width).div(8));
              If(i.notEqual(int(0)).or(state(id, C.CSEEN).notEqual(int(0))), () => {
                atomicMin(index.element(cell.mul(factions).add(i).add(GUARD_CELLS)), uint(id));
                atomicOr(index.element(region.mul(factions).add(i).add(GUARD_REGIONS)), uint(1));
              });
              If(state(id, C.CSEEN).notEqual(int(0)), () => {
                atomicMin(index.element(int(i).mul(2).add(THREATS)), uint(id));
                atomicMax(index.element(int(i).mul(2).add(THREATS + 1)), uint(table.element(unit(id, U.UTYPE).add(valueBase)).add(state(id, C.CKILLS))));
              });
            });
          });
        });
    });
    const hunt = (id: I) => {
      const base = unit(id, U.UOWNER).mul(2).add(THREATS).toVar();
      const best = lookupIndex(base).toVar();
      If(best.lessThan(int(count)), () => {
        const scoreOf = (other: I) => intMax(int(2), table.element(unit(other, U.UTYPE).add(valueBase)).add(state(other, C.CKILLS))
          .div(intMax(int(1), unitDistance(position(id), position(other)))));
        const score = scoreOf(best).toVar();
        const radius = lookupIndex(base.add(1)).div(score.add(1)).div(256).add(1).toVar();
        const origin = position(id).div(256).toVar();
        Loop({ start: intMax(int(0), origin.y.sub(radius)), end: intMin(int(setup.grid.height - 1), origin.y.add(radius)), condition: '<=', type: 'int' }, ({ i: y }) => {
          Loop({ start: intMax(int(0), origin.x.sub(radius)), end: intMin(int(setup.grid.width - 1), origin.x.add(radius)), condition: '<=', type: 'int' }, ({ i: x }) => {
            forCell(y.mul(setup.grid.width).add(x), other => {
              If(unit(other, U.UOWNER).notEqual(unit(id, U.UOWNER)).and(state(other, C.CSEEN).notEqual(int(0)))
                .and(table.element(unit(other, U.UTYPE).add(targetableBase)).notEqual(int(0))), () => {
                  const value = scoreOf(other).toVar();
                  If(value.greaterThan(score).or(value.equal(score).and(other.lessThan(best))), () => { best.assign(other); score.assign(value); });
                });
            }, lookupIndex);
          });
        });
      }).Else(() => { best.assign(-1); });
      return best;
    };
    const panic = (id: I) => {
      If(unit(id, U.UHEALTH).greaterThan(int(0)).and(table.element(unit(id, U.UTYPE).add(fraidyBase)).notEqual(int(0)))
        .and(unit(id,U.UOWNER).notEqual(int(0))).and(state(id,C.CACTION).equal(int(0)))
        .and(state(id,C.CFEAR).greaterThan(int(10))).and(unit(id,U.UDEST).lessThan(int(0))).and(goals.element(id).lessThan(int(0))), () => {
          // INFANTRY.CPP AI's Scatter(true) passes Coord(1), not forced=true.
          // SPECIAL.H disables unforced scatter for human units. FACING8.ASM
          // gives the direction from (1,0); preserve Scatter's final open neighbor.
          const dx=unit(id,U.UX).sub(1).toVar(), dy=unit(id,U.UY).toVar();
          const start=select(intMin(dx,dy).lessThan(intMax(dx,dy).add(1).shiftRight(1)),
            select(dx.greaterThanEqual(dy),int(2),int(4)),int(3)).toVar();
          start.assign(start.add(pick(id, 1, int(5))).add(6).bitAnd(7));
          const cell = unit(id, U.UCELL).toVar();
          Loop(8, ({ i }) => {
            const dir = start.add(i).bitAnd(7);
            If(table.element(cell.add(openBase)).bitAnd(int(1).shiftLeft(dir)).notEqual(int(0)), () => {
              const next = cell.add(table.element(dir.add(1).mul(2).add(neighborsBase)))
                .add(table.element(dir.add(1).mul(2).add(neighborsBase + 1)).mul(setup.grid.width));
              const free = int(0).toVar();
              Loop(5, ({ i: slot }) => {
                const owner = int(occupancy.element(next.mul(5).add(slot)));
                If(owner.equal(int(0)).or(owner.equal(id.add(1))), () => { free.assign(1); });
              });
              If(free.notEqual(int(0)), () => { goals.element(id).assign(next); });
            });
          });
          unit(id, U.UROUTE).assign(-1);
          unit(id, U.USTALLED).assign(0);
          paths.element(id).assign(-1);
          If(goals.element(id).greaterThanEqual(int(0)), () => { state(id, C.CMISSION).assign(C.MOVE); });
        });
    };
    // Ported from TECHNO.CPP / TURRET.CPP, AI; FOOT.CPP, Mission_Guard and Approach_Target.
    const prepare = kernel(count, () => {
      const id = int(instanceIndex);
      If(unit(id, U.UHEALTH).greaterThan(int(0)), () => {
        state(id, C.CLOCAL_SEARCH).assign(0);
        state(id, C.CLOCAL_WAIT).assign(intMax(int(0), state(id, C.CLOCAL_WAIT).sub(1)));
        state(id, C.CARM).assign(intMax(int(0), state(id, C.CARM).sub(1)));
        state(id, C.CFEAR).assign(intMax(int(0), state(id, C.CFEAR).sub(1)));
        // INFANTRY.CPP, AI under SPECIAL.H's default defender-advantage rule.
        const canLieDown = state(id, C.CPRONE).notEqual(int(0)).or(unit(id, U.UDEST).lessThan(int(0)).and(goals.element(id).lessThan(int(0))));
        const gesturing=state(id,C.CACTION).equal(int(27)).or(state(id,C.CACTION).equal(int(29)));
        const prone = select(gesturing,state(id,C.CPRONE),
          int(unit(id, U.UKIND).notEqual(int(0)).and(canLieDown).and(state(id, C.CFEAR).greaterThanEqual(int(10))))).toVar();
        If(prone.notEqual(state(id, C.CPRONE)), () => {
          state(id, C.CACTION).assign(select(prone.notEqual(int(0)), int(5), int(7)));
          state(id, C.CSTAGE).assign(0);
        }).ElseIf(state(id, C.CACTION).notEqual(int(0)), () => {
          state(id, C.CSTAGE).addAssign(1);
          const action=state(id,C.CACTION).toVar();
          const gestures=table.element(unit(id,U.UTYPE).mul(2).add(gestureBase).add(int(action.equal(int(29))))).mul(2);
          const length = select(action.equal(int(5)), type(id, TYPE.LIE_COUNT).mul(2),
            select(action.equal(int(7)),type(id, TYPE.UP_COUNT).mul(3),gestures));
          If(state(id, C.CSTAGE).greaterThanEqual(length), () => { state(id, C.CACTION).assign(0); });
        });
        state(id, C.CPRONE).assign(prone);
        If(unit(id, U.UKIND).notEqual(int(0)), () => { unit(id, U.USPEED).assign(select(prone.notEqual(int(0)), int(127), int(255))); });
        panic(id);
        // INFANTRY.CPP AI: wait two seconds and a stationary, upright moment.
        If(state(id,C.CSTOKED).notEqual(int(0)).and(state(id,C.CCOMMENT).lessThanEqual(clock().add(1)))
          .and(goals.element(id).lessThan(int(0))).and(prone.equal(int(0))), () => {
          state(id,C.CSTOKED).assign(0);
          state(id,C.CCELEBRATED).assign(clock().add(1));
          state(id,C.CTAUNT).assign(pick(id,101,int(4),true));
          If(state(id,C.CACTION).equal(int(0)), () => {
            state(id,C.CACTION).assign(select(pick(id,100,int(2),true).equal(int(0)),int(27),int(29)));
            state(id,C.CSTAGE).assign(0);state(id,C.CFIRE).assign(-1);
          });
        });
        If(state(id,C.CACTION).equal(int(27)).or(state(id,C.CACTION).equal(int(29))), () => {
          unit(id,U.UWAIT).assign(intMax(unit(id,U.UWAIT),int(2)));
        });
        If(unit(id, U.UTYPE).equal(int(8)).and(state(id, C.CAMMO).lessThan(int(2))).and(unit(id, U.UDEST).lessThan(int(0))), () => {
          state(id, C.CRELOAD).assign(intMax(int(0), state(id, C.CRELOAD).sub(1)));
          If(state(id, C.CRELOAD).equal(int(0)), () => { state(id, C.CAMMO).addAssign(1); If(state(id, C.CAMMO).lessThan(int(2)), () => { state(id, C.CRELOAD).assign(450); }); });
        });
        If(state(id, C.CFIRE).greaterThanEqual(int(0)), () => {
          state(id, C.CFIRE).addAssign(1);
          const length = select(state(id, C.CPRONE).notEqual(int(0)), type(id, TYPE.PRONE_FIRE_COUNT), type(id, TYPE.FIRE_COUNT));
          If(state(id, C.CFIRE).greaterThanEqual(length), () => { state(id, C.CFIRE).assign(-1); });
        });
        If(state(id, C.CFIRE).greaterThanEqual(int(0)).and(unit(id, U.UKIND).notEqual(int(0))), () => { unit(id, U.UWAIT).assign(2); });
        state(id, C.CTURRET).assign(unitRotate(state(id, C.CTURRET), state(id, C.CTURN), type(id, TYPE.ROTATION).add(1)));
        state(id, C.CROTATING).assign(int(state(id, C.CTURRET).notEqual(state(id, C.CTURN))));
        const target = state(id, C.CTARGET).toVar();
        If(target.greaterThanEqual(int(0)), () => { If(unit(target, U.UHEALTH).lessThanEqual(int(0)), () => { target.assign(-1); }); });
        If(target.equal(int(-1)).and(state(id, C.CMISSION).equal(int(C.ATTACK))), () => {
          // UNIT.CPP / INFANTRY.CPP Enter_Idle_Mode keeps a valid NavCom.
          If(state(id,C.CLOCAL_ROUTE).notEqual(int(0)).and(state(id,C.CLOCAL_DEST).greaterThanEqual(int(0))), () => {
            goals.element(id).assign(state(id,C.CLOCAL_DEST));paths.element(id).assign(-1);
          });
          state(id,C.CMISSION).assign(select(goals.element(id).greaterThanEqual(int(0)),int(C.MOVE),int(C.GUARD)));
        });
        If(state(id, C.CMISSION).equal(int(C.MOVE)).and(goals.element(id).lessThan(int(0))), () => { state(id, C.CMISSION).assign(C.GUARD); });
        state(id, C.CSCAN).assign(intMax(int(0), state(id, C.CSCAN).sub(1)));
        If(state(id, C.CSCAN).equal(int(0)).and(state(id, C.CMISSION).notEqual(int(C.MOVE))), () => {
          If(state(id, C.CMISSION).equal(int(C.GUARD)).and(target.notEqual(int(-1))), () => {
            If(inRange(id, target).not().and(inRange(id, target, int(1)).not()), () => { target.assign(-1); });
          });
          If(target.equal(int(-1)), () => {
            If(state(id, C.CMISSION).equal(int(C.HUNT)), () => { target.assign(hunt(id)); })
              .Else(() => { target.assign(scan(id)); });
          });
          state(id, C.CSCAN).assign(select(state(id, C.CMISSION).equal(int(C.HUNT)), int(20), pick(id, 50, int(5), true).add(15)));
        });
        state(id, C.CTARGET).assign(target);
        If(target.notEqual(int(-1)), () => {
          const recovered = int(0).toVar();
          If(state(id, C.CMISSION).greaterThanEqual(int(C.ATTACK)), () => { recovered.assign(recoverApproach(id, target)); });
          If(recovered.equal(int(0)).and(state(id, C.CMISSION).greaterThanEqual(int(C.ATTACK))).and(type(id, TYPE.PRIMARY).greaterThanEqual(int(0))).and(goals.element(id).lessThan(int(0))), () => {
            const overrun = int(0).toVar();
            // DRIVE.CPP, Approach_Target: computer crushers prefer a close overrun,
            // except flame tanks, whose weapon is more effective.
            If(target.greaterThanEqual(int(0)).and(unit(id, U.UOWNER).notEqual(int(0)))
              .and(table.element(unit(id, U.UTYPE).add(crusherBase)).notEqual(int(0))).and(type(id, TYPE.PRIMARY).notEqual(int(6))), () => {
                If(unit(target, U.UKIND).notEqual(int(0)).and(unitDistance(position(id), position(target)).lessThan(int(0x180))), () => {
                  overrun.assign(1);
                  goals.element(id).assign(cellAt(position(target)));
                  paths.element(id).assign(-1);
                });
              });
            If(overrun.equal(int(0)).and(inRange(id, target).not()), () => {
              const pos = targetPoint(target).toVar(), dir = int(unitDirection(pos, position(id))).toVar();
              const range = weapon(type(id, TYPE.PRIMARY), 3).toVar();
              If(type(id, TYPE.SECONDARY).greaterThanEqual(int(0)), () => { range.assign(intMax(range, weapon(type(id, TYPE.SECONDARY), 3))); });
              const goal = cellAt(pos).toVar(), found = int(0).toVar();
              Loop({ start: range.sub(0xB7), end: int(128), condition: '>', update: '-=256', type: 'int' }, ({ i: r }) => {
                for (const angle of [0, 8, -8, 16, -16, 24, -24, 32, -32, 48, -48, 64, -64])
                  If(found.equal(int(0)), () => {
                    const candidate = move(pos, dir.add(angle), r).toVar(), cell = cellAt(candidate).toVar();
                    If(inside(candidate.x.div(256), candidate.y.div(256)).and(candidate.x.greaterThanEqual(int(0))).and(candidate.y.greaterThanEqual(int(0))), () => {
                      If(table.element(cell.add(openBase)).notEqual(int(0)).and(occupancy.element(cell.mul(5)).equal(int(0))).and(unitDistance(candidate, pos).lessThan(r)), () => {
                        goal.assign(cell);
                        found.assign(1);
                      });
                    });
                  });
                If(found.notEqual(int(0)), () => { Break(); });
              });
              goals.element(id).assign(goal);
              paths.element(id).assign(-1);
            });
          });
        });
        If(unit(id, U.UTYPE).equal(int(5)).and(clock().add(1).mod(16).equal(int(0))).and(unit(id, U.UHEALTH).lessThan(type(id, TYPE.STRENGTH).div(2))), () => {
          unit(id, U.UHEALTH).addAssign(1);
        });
      });
    });
    // Keep prepare read-only on the spatial index. Queue writes belong in a
    // separate dispatch, so threat queries need no atomic reads or aliasing.
    const collectRoutes = kernel(count, () => {
      const id = int(instanceIndex);
      If(unit(id, U.UHEALTH).greaterThan(int(0)).and(state(id, C.CLOCAL_SEARCH).notEqual(int(0))), () => {
        const entry = int(atomicAdd(index.element(ROUTE_COUNT), uint(1))).toVar();
        write(entry.add(ROUTE_JOBS), id);
      });
    });
    const prepareRoutes = kernel(1, () => { routeDispatch.element(0).assign(uint(read(int(ROUTE_COUNT)))); });
    const orient = kernel(count, () => {
      const id = int(instanceIndex), target = state(id, C.CTARGET).toVar();
      If(unit(id, U.UHEALTH).greaterThan(int(0)), () => {
        If(target.notEqual(int(-1)), () => {
          state(id, C.CAPPROACH_GOAL).assign(goals.element(id));
          const dir = int(unitDirection(position(id), targetPoint(target))).toVar();
          If(type(id, TYPE.TURRET).notEqual(int(0)), () => {
            state(id, C.CTURN).assign(select(type(id, TYPE.LOCK_TURRET).notEqual(int(0)).and(goals.element(id).greaterThanEqual(int(0))), unit(id, U.UFACE), dir));
            If(type(id, TYPE.LOCK_TURRET).notEqual(int(0)).and(unit(id, U.UDEST).lessThan(int(0))).and(goals.element(id).lessThan(int(0))), () => {
              unit(id, U.UDESIRED).assign(dir);
            });
          }).ElseIf(unit(id, U.UDEST).lessThan(int(0)).and(goals.element(id).lessThan(int(0))), () => {
            unit(id, U.UDESIRED).assign(select(unit(id, U.UTYPE).equal(int(1)), dir.add(16).bitAnd(255).shiftRight(5).mul(32), dir));
          });
        }).Else(() => {
          state(id, C.CTURN).assign(unit(id, U.UFACE));
          If(type(id, TYPE.LOCK_TURRET).equal(int(0)).and(goals.element(id).greaterThanEqual(int(0))), () => {
            state(id, C.CTURN).assign(int(unitDirection(position(id), targetPoint(goals.element(id).negate().sub(2)))));
          });
          state(id, C.CLOCAL_ROUTE).assign(0);
          state(id, C.CAPPROACH_GOAL).assign(-1);
          state(id, C.CROUTE_LENGTH).assign(0);
        });
        // TURRET.CPP, Ok_To_Move waits for the locked turret before starting a track.
        If(type(id, TYPE.LOCK_TURRET).notEqual(int(0)).and(unit(id, U.UDEST).lessThan(int(0))).and(goals.element(id).greaterThanEqual(int(0)))
          .and(state(id, C.CTURRET).notEqual(unit(id, U.UFACE))), () => {
            unit(id, U.UWAIT).assign(intMax(unit(id, U.UWAIT), int(2)));
          });
      });
    });
    // One workgroup explores one requested local route. Cells of each BFS wave
    // run in parallel, and atomic distances only accept the preceding wave.
    // Parents and firing cells break ties by cell index, independent of lane order.
    const routeFlag = Object.assign(workgroupArray('uint', 1), { name: 'routeFlag' }) as unknown as Shared;
    const routeMeta = Object.assign(workgroupArray('uint', 4).toAtomic(), { name: 'routeMeta' }) as unknown as Shared;
    const routeDistance = Object.assign(workgroupArray('uint', ATTACK_ROUTE_CELLS).toAtomic(), { name: 'routeDistance' }) as unknown as Shared;
    const routeCells = Object.assign(workgroupArray('uint', ATTACK_ROUTE_CELLS), { name: 'routeCells' }) as unknown as Shared;
    const routeParent = Object.assign(workgroupArray('uint', ATTACK_ROUTE_CELLS), { name: 'routeParent' }) as unknown as Shared;
    const routeStatus = () => uniformShared({ p: routeFlag.element(uint(0)) }) as Node<'uint'>;
    // Queue order is scratch only: each job keeps the original unit ID and
    // reads the same occupancy snapshot. Jobs never consume one another's output.
    const solveRoutes = indirect(this.routeDispatch, () => {
      const id = read(int(workgroupId.x).add(ROUTE_JOBS)).toVar(), lane = int(localId.x), center = ATTACK_ROUTE_RADIUS * ATTACK_ROUTE_SIDE + ATTACK_ROUTE_RADIUS;
      If(lane.equal(int(0)), () => { routeFlag.element(uint(0)).assign(uint(state(id, C.CLOCAL_SEARCH))); });
      If(routeStatus().notEqual(uint(0)), () => {
        const start = unit(id, U.UCELL).toVar(), target = targetPoint(state(id, C.CTARGET)).toVar();
        const left = start.mod(setup.grid.width).sub(ATTACK_ROUTE_RADIUS).toVar();
        const top = start.div(setup.grid.width).sub(ATTACK_ROUTE_RADIUS).toVar();
        const destination = state(id, C.CLOCAL_DEST).toVar();
        const cellAtLocal = (i: I) => top.add(i.div(ATTACK_ROUTE_SIDE)).mul(setup.grid.width).add(left).add(i.mod(ATTACK_ROUTE_SIDE));
        const point = (i: I) => ivec2(left.add(i.mod(ATTACK_ROUTE_SIDE)).mul(256).add(128), top.add(i.div(ATTACK_ROUTE_SIDE)).mul(256).add(128));
        const towards = target.toVar();
        If(destination.greaterThanEqual(int(0)), () => { towards.assign(targetPoint(destination.negate().sub(2))); });
        const initialScore = unitDistance(point(int(center)), towards).toVar();
        If(lane.equal(int(0)), () => {
          atomicStore(routeMeta.element(uint(0)), uint(0));
          atomicStore(routeMeta.element(uint(1)), uint(0xffffffff));
          atomicStore(routeMeta.element(uint(2)), uint(initialScore));
          atomicStore(routeMeta.element(uint(3)), uint(0xffffffff));
        });
        Loop({ start: lane, end: int(ATTACK_ROUTE_CELLS), update: '+= 64', type: 'int' }, ({ i }) => {
          atomicStore(routeDistance.element(uint(i)), select(i.equal(int(center)), uint(0), uint(0xffff)));
          routeParent.element(uint(i)).assign(uint(center));
          routeCells.element(uint(i)).assign(uint(0));
          const x = left.add(i.mod(ATTACK_ROUTE_SIDE)), y = top.add(i.div(ATTACK_ROUTE_SIDE));
          If(inside(x, y), () => {
            const cell = cellAtLocal(i).toVar(), free = int(0).toVar();
            Loop(5, ({ i: slot }) => {
              const owner = int(occupancy.element(cell.mul(5).add(slot)));
              If(owner.equal(int(0)).or(owner.equal(id.add(1))), () => { free.addAssign(1); });
            });
            const terrain = table.element(cell.add(landBase));
            const locomotion = table.element(unit(id, U.UTYPE).add(locomotionBase));
            const speed = table.element(terrain.mul(7).add(locomotion).add(groundSpeedBase));
            const enter = i.equal(int(center)).or(speed.notEqual(int(0)).and(free.equal(int(5)).or(unit(id, U.UKIND).notEqual(int(0)).and(free.greaterThan(int(0))))));
            const firing = int(0).toVar();
            If(destination.greaterThanEqual(int(0)), () => { firing.assign(int(cell.equal(destination))); }).Else(() => {
              const pos = point(i).toVar(), dir = int(unitDirection(pos, target)).toVar();
              firing.assign(int(unitDistance(muzzle(id, int(0), pos, dir), target).lessThanEqual(weapon(type(id, TYPE.PRIMARY), WEAPON.RANGE))));
            });
            routeCells.element(uint(i)).assign(uint(table.element(cell.add(openBase))).shiftLeft(uint(2))
              .bitOr(uint(firing).shiftLeft(uint(1))).bitOr(uint(enter)));
          });
        });
        workgroupBarrier();
        If(lane.equal(int(0)), () => {
          If(routeCells.element(uint(center)).bitAnd(uint(2)).notEqual(uint(0)), () => {
            atomicStore(routeMeta.element(uint(1)), uint(center));
            routeFlag.element(uint(0)).assign(uint(2));
          });
        });
        Loop(ATTACK_ROUTE_CELLS, ({ i: wave }) => {
          If(routeStatus().notEqual(uint(1)), () => { Break(); });
          If(lane.equal(int(0)), () => { atomicStore(routeMeta.element(uint(0)), uint(0)); });
          workgroupBarrier();
          Loop({ start: lane, end: int(ATTACK_ROUTE_CELLS), update: '+= 64', type: 'int' }, ({ i }) => {
            If(routeCells.element(uint(i)).bitAnd(uint(1)).notEqual(uint(0))
              .and(atomicLoad(routeDistance.element(uint(i))).equal(uint(0xffff))), () => {
                const parent = int(ATTACK_ROUTE_CELLS).toVar(), x = i.mod(ATTACK_ROUTE_SIDE), y = i.div(ATTACK_ROUTE_SIDE);
                Loop(8, ({ i: dir }) => {
                  const xx = x.sub(table.element(dir.add(1).mul(2).add(neighborsBase)));
                  const yy = y.sub(table.element(dir.add(1).mul(2).add(neighborsBase + 1)));
                  If(xx.greaterThanEqual(int(0)).and(yy.greaterThanEqual(int(0))).and(xx.lessThan(int(ATTACK_ROUTE_SIDE))).and(yy.lessThan(int(ATTACK_ROUTE_SIDE))), () => {
                    const other = yy.mul(ATTACK_ROUTE_SIDE).add(xx);
                    If(atomicLoad(routeDistance.element(uint(other))).equal(uint(wave))
                      .and(routeCells.element(uint(other)).bitAnd(uint(1).shiftLeft(uint(dir.add(2)))).notEqual(uint(0))), () => {
                        parent.assign(intMin(parent, other));
                      });
                  });
                });
                If(parent.lessThan(int(ATTACK_ROUTE_CELLS)), () => {
                  routeParent.element(uint(i)).assign(uint(parent));
                  atomicStore(routeDistance.element(uint(i)), uint(wave.add(1)));
                  atomicStore(routeMeta.element(uint(0)), uint(1));
                  If(routeCells.element(uint(i)).bitAnd(uint(2)).notEqual(uint(0)), () => { atomicMin(routeMeta.element(uint(1)), uint(i)); });
                });
              });
          });
          workgroupBarrier();
          If(lane.equal(int(0)), () => {
            const found = atomicLoad(routeMeta.element(uint(1))).toVar();
            const advanced = atomicLoad(routeMeta.element(uint(0))).toVar();
            routeFlag.element(uint(0)).assign(select(found.notEqual(uint(0xffffffff)), uint(2), advanced));
          });
        });
        If(routeStatus().notEqual(uint(2)), () => {
          Loop({ start: lane, end: int(ATTACK_ROUTE_CELLS), update: '+= 64', type: 'int' }, ({ i }) => {
            If(atomicLoad(routeDistance.element(uint(i))).notEqual(uint(0xffff)), () => {
              atomicMin(routeMeta.element(uint(2)), uint(unitDistance(point(i), towards)));
            });
          });
          workgroupBarrier();
          Loop({ start: lane, end: int(ATTACK_ROUTE_CELLS), update: '+= 64', type: 'int' }, ({ i }) => {
            const score = unitDistance(point(i), towards).toVar(), d = atomicLoad(routeDistance.element(uint(i)));
            If(d.notEqual(uint(0xffff)).and(score.lessThan(initialScore))
              .and(uint(score).equal(atomicLoad(routeMeta.element(uint(2))))), () => {
                atomicMin(routeMeta.element(uint(3)), d.mul(uint(ATTACK_ROUTE_CELLS)).add(uint(i)));
              });
          });
        });
        workgroupBarrier();
        If(lane.equal(int(0)), () => {
          const chosen = atomicLoad(routeMeta.element(uint(1))).toVar();
          If(chosen.equal(uint(0xffffffff)), () => {
            const fallback = atomicLoad(routeMeta.element(uint(3)));
            If(fallback.notEqual(uint(0xffffffff)), () => { chosen.assign(fallback.mod(uint(ATTACK_ROUTE_CELLS))); });
          });
          state(id, C.CLOCAL_SEARCH).assign(0);
          state(id, C.CROUTE_LENGTH).assign(0);
          state(id, C.CROUTE_CURSOR).assign(1);
          If(chosen.notEqual(uint(0xffffffff)), () => {
            const at = chosen.toVar(), length = int(atomicLoad(routeDistance.element(chosen))).toVar();
            state(id, C.CROUTE_LENGTH).assign(intMin(int(C.ROUTE_STEPS), length));
            state(id, C.CLOCAL_DEST).assign(cellAtLocal(int(chosen)));
            Loop({ start: length.sub(1), end: int(0), condition: '>=', update: '--', type: 'int' }, ({ i }) => {
              If(i.lessThan(int(C.ROUTE_STEPS)), () => { s.element(id.mul(C.CWORDS).add(C.CROUTE_PATH).add(i)).assign(cellAtLocal(int(at))); });
              at.assign(routeParent.element(at));
            });
            goals.element(id).assign(select(length.greaterThan(int(0)), state(id, C.CROUTE_PATH), int(-1)));
            paths.element(id).assign(select(length.greaterThan(int(0)), int(U.DIRECT_STEP), int(-1)));
            state(id, C.CLOCAL_WAIT).assign(0);
          }).Else(() => { state(id, C.CLOCAL_DEST).assign(-1); goals.element(id).assign(-1); state(id, C.CLOCAL_WAIT).assign(PATH_DELAY); });
        });
      });
    });
    // TARCOM.CPP, AI tries the secondary after any primary Can_Fire failure.
    const canVehicleFire = (id: I, target: I, which: I) => {
      const w = select(which.equal(int(0)), type(id, TYPE.PRIMARY), type(id, TYPE.SECONDARY)).toVar();
      const allowed = int(0).toVar();
      If(w.greaterThanEqual(int(0)), () => {
        const bt = weapon(w, WEAPON.BULLET).toVar();
        const desired = int(unitDirection(position(id), targetPoint(target))).toVar();
        const dir = select(type(id, TYPE.TURRET).notEqual(int(0)), state(id, C.CTURRET), unit(id, U.UFACE)).toVar();
        const diff = abs(desired.sub(dir).add(128).bitAnd(255).sub(128)).toVar();
        If(unit(id, U.UTYPE).equal(int(1)).and(desired.add(16).bitAnd(255).shiftRight(5).equal(dir.add(16).bitAnd(255).shiftRight(5))), () => { diff.assign(0); });
        If(bullet(bt, BULLET.HOMING).notEqual(int(0)), () => { diff.assign(diff.shiftRight(2)); });
        allowed.assign(int(state(id, C.CARM).equal(int(0)).and(inRange(id, target, which)).and(diff.lessThan(int(8)))
          .and(type(id, TYPE.LOCK_TURRET).equal(int(0)).and(type(id, TYPE.TURRET).notEqual(int(0))).or(goals.element(id).lessThan(int(0))))
          .and(bullet(bt, BULLET.HOMING).notEqual(int(0)).or(type(id, TYPE.TURRET).equal(int(0))).or(state(id, C.CROTATING).equal(int(0))))));
      });
      return allowed.notEqual(int(0));
    };
    // Ported from TECHNO.CPP, Can_Fire / Fire_At / Rearm_Delay; INFANTRY.CPP, AI.
    const fire = kernel(count, () => {
      const id = int(instanceIndex), target = state(id, C.CTARGET).toVar(), primary = type(id, TYPE.PRIMARY).toVar();
      If(target.greaterThanEqual(int(0)), () => {
        If(unit(target, U.UHEALTH).lessThanEqual(int(0)), () => { target.assign(-1); state(id, C.CTARGET).assign(-1); });
      });
      If(unit(id, U.UHEALTH).greaterThan(int(0)).and(primary.greaterThanEqual(int(0))).and(target.notEqual(int(-1))).and(state(id, C.CAMMO).notEqual(int(0))), () => {
        const which = int(0).toVar(), w = primary.toVar(), weaponReady = int(1).toVar();
        If(unit(id, U.UKIND).equal(int(0)), () => {
          If(canVehicleFire(id, target, int(0)).not(), () => {
            If(canVehicleFire(id, target, int(1)), () => { which.assign(1); w.assign(type(id, TYPE.SECONDARY)); })
              .Else(() => { weaponReady.assign(0); });
          });
        });
        const bt = weapon(w, WEAPON.BULLET).toVar(), pos = targetPoint(target).toVar();
        const dir = select(type(id, TYPE.TURRET).notEqual(int(0)), state(id, C.CTURRET), unit(id, U.UFACE)).toVar();
        const desired = int(unitDirection(position(id), pos)).toVar();
        const launch = int(0).toVar();
        If(unit(id, U.UKIND).notEqual(int(0)), () => {
          If(state(id, C.CFIRE).lessThan(int(0)).and(state(id, C.CACTION).equal(int(0))).and(state(id, C.CARM).equal(int(0))).and(unit(id, U.UDEST).lessThan(int(0))).and(inRange(id, target, which)), () => {
            state(id, C.CFIRE).assign(0);
            state(id, C.CSHOT).assign(0);
            unit(id, U.UFACE).assign(desired.add(16).bitAnd(255).shiftRight(5).mul(32));
            unit(id, U.UDESIRED).assign(unit(id, U.UFACE));
          });
          launch.assign(int(state(id, C.CFIRE).equal(select(state(id, C.CPRONE).notEqual(int(0)), type(id, TYPE.PRONE_LAUNCH), type(id, TYPE.LAUNCH))).and(state(id, C.CSHOT).equal(int(0)))));
        }).Else(() => {
          launch.assign(weaponReady);
        });
        If(launch.notEqual(int(0)), () => {
          const b = id.mul(C.SHOTS_PER_UNIT).add(state(id, C.CCURSOR)).toVar();
          If(shot(b, C.BACTIVE).equal(int(0)), () => {
            state(id, C.CCURSOR).assign(state(id, C.CCURSOR).add(1).mod(C.SHOTS_PER_UNIT));
            const from = muzzle(id, which).toVar(), to = pos.toVar();
            const direction = select(bullet(bt, BULLET.HOMING).notEqual(int(0)), dir, int(unitDirection(from, to))).toVar();
            const targetInfantry = int(target.lessThan(int(-1))).toVar();
            If(target.greaterThanEqual(int(0)), () => { targetInfantry.assign(unit(target, U.UKIND)); });
            If(unit(id, U.UDEST).greaterThanEqual(int(0)).or(bullet(bt, BULLET.INACCURATE).notEqual(int(0))).or(targetInfantry.notEqual(int(0)).and(bullet(bt, BULLET.WARHEAD).equal(int(2)).or(bullet(bt, BULLET.FUELED).notEqual(int(0))))), () => {
              If(bullet(bt, BULLET.HOMING).notEqual(int(0)).or(bullet(bt, BULLET.ARCING).notEqual(int(0))), () => {
                const spread = intMin(select(bt.equal(int(11)), int(128), int(512)), unitDistance(from, to).div(select(bt.equal(int(11)), int(4), int(3))));
                direction.assign(direction.add(pick(id, 51, int(11))).sub(5).bitAnd(255));
                to.assign(move(to, random(id, 52).bitAnd(255), pick(id, 53, spread.add(1))));
              }).Else(() => { to.assign(move(to, direction, pick(id, 53, int(257)))); });
              const range = weapon(type(id, TYPE.PRIMARY), WEAPON.RANGE).toVar();
              If(type(id, TYPE.SECONDARY).greaterThanEqual(int(0)), () => { range.assign(intMax(range, weapon(type(id, TYPE.SECONDARY), WEAPON.RANGE))); });
              const excess = unitDistance(from, to).sub(range).toVar();
              const outside = unitDistance(muzzle(id, int(0)), to).greaterThan(weapon(type(id, TYPE.PRIMARY), WEAPON.RANGE)).toVar();
              If(type(id, TYPE.SECONDARY).greaterThanEqual(int(0)), () => {
                outside.assign(outside.and(unitDistance(muzzle(id, int(1)), to).greaterThan(weapon(type(id, TYPE.SECONDARY), WEAPON.RANGE))));
              });
              If(outside, () => { to.assign(move(to, int(unitDirection(to, from)), excess)); });
            });
            Loop(C.BWORDS, ({ i }) => { p.element(b.mul(C.BWORDS).add(i)).assign(0); });
            const instant = bullet(bt, BULLET.INVISIBLE).notEqual(int(0)).and(bullet(bt, BULLET.SPEED).equal(int(255)));
            shot(b, C.BX).assign(select(instant, to.x, from.x));
            shot(b, C.BY).assign(select(instant, to.y, from.y));
            const d = unitDistance(ivec2(shot(b, 0), shot(b, 1)), to).toVar();
            const speed = select(bullet(bt, BULLET.ARCING).notEqual(int(0)), intMax(int(25), bullet(bt, BULLET.SPEED).add(d.shiftRight(5))), select(bullet(bt, BULLET.SPEED).equal(int(255)), int(0), bullet(bt, BULLET.SPEED))).toVar();
            shot(b, C.BTARGET).assign(target);
            shot(b, C.BTYPE).assign(bt);
            shot(b, C.BDAMAGE).assign(weapon(w, WEAPON.DAMAGE));
            shot(b, C.BACTIVE).assign(1);
            atomicOr(index.element(b.div(32).add(PROJECTILE_BITS)), projectileBit(b));
            shot(b, C.BFACE).assign(direction);
            shot(b, C.BDESIRED).assign(direction);
            shot(b, C.BSPEED).assign(speed.mul(255).add(128).shiftRight(8));
            shot(b, C.BTIMER).assign(intMin(int(255), intMax(bullet(bt, BULLET.ARMING), select(bullet(bt, BULLET.RANGE).notEqual(int(0)), bullet(bt, BULLET.RANGE), d.div(bullet(bt, BULLET.SPEED)).add(4)))));
            shot(b, C.BARM).assign(bullet(bt, BULLET.ARMING));
            shot(b, C.BTO_X).assign(to.x);
            shot(b, C.BTO_Y).assign(to.y);
            shot(b, C.BPROXIMITY).assign(d);
            shot(b, C.BALTITUDE).assign(int(bullet(bt, BULLET.ARCING).notEqual(int(0))));
            shot(b, C.BRISER).assign(select(bullet(bt, BULLET.ARCING).notEqual(int(0)), intMax(int(10), d.div(2).div(speed.add(1)).mul(3)), int(0)));
            shot(b, C.BEXPLODED).assign(-1);
            shot(b, C.BSOURCE).assign(id);
            shot(b, C.BFIRE_X).assign(from.x);
            shot(b, C.BFIRE_Y).assign(from.y);
            // TECHNO.CPP, Fire_At: directional effects follow Fire_Direction.
            shot(b, C.BFIRE_FACE).assign(select(type(id, TYPE.TURRET).notEqual(int(0)), state(id, C.CTURRET), unit(id, U.UFACE)));
            shot(b, C.BWEAPON).assign(w);
            shot(b, C.BBORN).assign(clock());
            state(id, C.CARM).assign(select(state(id, C.CSECOND).notEqual(int(0)), weapon(primary, WEAPON.ROF).add(3), int(9)));
            If(type(id, TYPE.TWO_SHOOTER).notEqual(int(0)), () => { state(id, C.CSECOND).assign(state(id, C.CSECOND).bitXor(1)); });
            If(state(id, C.CAMMO).greaterThan(int(0)), () => { state(id, C.CAMMO).subAssign(1); });
            If(unit(id, U.UTYPE).equal(int(8)).and(state(id, C.CRELOAD).equal(int(0))), () => { state(id, C.CRELOAD).assign(450); });
            state(id, C.CLAST_FIRE).assign(clock());
            state(id, C.CSHOT).assign(1);
            If(target.greaterThanEqual(int(0)), () => { If(unit(target, U.UOWNER).equal(int(0)), () => { state(id, C.CSEEN).assign(1); }); });
          });
        });
      });
    });
    const clearImpacts = kernel(count, () => {
      const id = int(instanceIndex);
      If(id.lessThan(int(count)), () => { write(id.add(DAMAGE), int(0)); write(id.add(CAUSE), int(shots)); });
      If(id.lessThan(int(words)), () => { write(id.add(DEATH_BITS), int(0)); });
    });
    const clearDeaths = kernel(cells, () => {
      write(int(instanceIndex).add(DEAD_CELLS), int(0));
      If(instanceIndex.equal(int(0)), () => { write(int(DEATH_COUNT), int(0)); });
    });
    const clearProjectileJobs = kernel(1, () => { write(int(PROJECTILE_COUNT), int(0)); });
    const collectProjectiles = kernel(projectileWords, () => {
      const word = int(instanceIndex), bits = uint(read(word.add(PROJECTILE_BITS))).toVar();
      If(bits.notEqual(uint(0)), () => {
        const count = bitCount({ v: bits }) as Node<'uint'>;
        const entry = int(atomicAdd(index.element(PROJECTILE_COUNT), count)).toVar();
        Loop(() => {
          If(bits.equal(uint(0)), () => { Break(); });
          const id = word.mul(32).add(int(trailingZeros(bits))).toVar();
          bits.assign(bits.bitAnd(bits.sub(uint(1))));
          write(entry.add(PROJECTILE_JOBS), id);
          entry.addAssign(1);
        });
      });
    });
    const prepareProjectiles = kernel(1, () => {
      projectileDispatch.element(0).assign(uint(read(int(PROJECTILE_COUNT)).add(63).div(64)));
    });
    const explosive = (id: I) => type(id, TYPE.EXPLOSION).equal(int(ANIMATION_IDS.ANIM_NAPALM3))
      .or(unit(id, U.UTYPE).equal(int(movementType('E2')))).or(unit(id, U.UTYPE).equal(int(movementType('E4'))))
      .or(unit(id, U.UTYPE).equal(int(movementType('E5'))));
    // DRIVE.CPP, Overrun_Square. Only vehicles crossing a cell boundary search
    // that cell. CAUSE is scratch here and is cleared again before projectile damage.
    const claimCrush = kernel(count, () => {
      const id = int(instanceIndex), cell = unit(id, U.UOVERRUN_CELL).toVar();
      If(cell.greaterThanEqual(int(0)).and(unit(id, U.UHEALTH).greaterThan(int(0))), () => {
        const kind = unit(id, U.UTYPE).toVar();
        // UNIT.CPP, Per_Cell_Process: setup delay after artillery/launchers stop.
        If(kind.equal(int(movementType('ARTY'))).or(kind.equal(int(movementType('MLRS')))).or(kind.equal(int(movementType('MSAM'))))
          .and(goals.element(id).lessThan(int(0))), () => { state(id, C.CARM).assign(18); });
        If(table.element(kind.add(crusherBase)).notEqual(int(0)), () => {
          const pos = ivec2(unit(id, U.UOVERRUN_X), unit(id, U.UOVERRUN_Y)).toVar();
          forCell(cell, other => {
            If(unit(other, U.UKIND).notEqual(int(0)).and(unit(other, U.UHEALTH).greaterThan(int(0)))
              .and(unit(other, U.UOWNER).notEqual(unit(id, U.UOWNER))).and(unitDistance(position(other), pos).lessThan(int(0x80))), () => {
                atomicMin(index.element(other.add(CAUSE)), uint(id));
              });
          });
        });
      });
    });
    // Each victim owns its removal; the lowest vehicle ID wins attribution.
    const crush = kernel(count, () => {
      const id = int(instanceIndex), killer = read(id.add(CAUSE)).toVar();
      If(killer.lessThan(int(count)), () => {
        unit(id, U.UHEALTH).assign(0);
        state(id, C.CDEATH).assign(clock());
        state(id, C.CWARHEAD).assign(C.CRUSHED);
        state(id, C.CKILLER).assign(killer);
        state(id, C.CTARGET).assign(-1);
        state(id, C.CFIRE).assign(-1);
        goals.element(id).assign(-1);
        paths.element(id).assign(-1);
        for (const field of [U.UDEST, U.UMIDDLE, U.UTRACK, U.UJUMP])
          unit(id, field).assign(-1);
        unit(id, U.UDESIRED).assign(unit(id, U.UFACE));
        write(cellAt(position(id)).add(DEAD_CELLS), int(1));
      });
    });
    // Ported from BULLET.CPP, AI / Unlimbo; FLY.CPP, Physics; FUSE.CPP, Fuse_Checkup.
    const fly = indirect(this.projectileDispatch, () => {
      If(int(instanceIndex).lessThan(read(int(PROJECTILE_COUNT))), () => {
        const b = read(int(instanceIndex).add(PROJECTILE_JOBS)).toVar();
        shot(b, C.BIMPACT).assign(0);
        shot(b, C.BTRAIL_TICK).assign(-1);
        If(shot(b, C.BACTIVE).notEqual(int(0)), () => {
          const bt = shot(b, C.BTYPE).toVar(), target = shot(b, C.BTARGET).toVar(), forced = int(0).toVar();
          If(table.element(bt.add(smokeBase)).notEqual(int(0)).and(clock().sub(shot(b, C.BBORN)).bitAnd(1).notEqual(int(0))), () => {
            shot(b, C.BTRAIL_X).assign(shot(b, 0));
            shot(b, C.BTRAIL_Y).assign(shot(b, 1));
            shot(b, C.BTRAIL_TICK).assign(clock());
          });
          If(bullet(bt, BULLET.ARCING).notEqual(int(0)), () => {
            shot(b, C.BALTITUDE).addAssign(shot(b, C.BRISER));
            forced.assign(int(shot(b, C.BALTITUDE).lessThanEqual(int(0))));
            If(shot(b, C.BRISER).greaterThan(int(-100)), () => { shot(b, C.BRISER).subAssign(3); });
          });
          If(bullet(bt, BULLET.HOMING).notEqual(int(0)).and(clock().bitAnd(1).notEqual(int(0))).and(target.greaterThanEqual(int(0))), () => {
            If(unit(target, U.UHEALTH).greaterThan(int(0)), () => { shot(b, C.BDESIRED).assign(int(unitDirection(ivec2(shot(b, 0), shot(b, 1)), position(target)))); });
          });
          shot(b, C.BFACE).assign(unitRotate(shot(b, C.BFACE), shot(b, C.BDESIRED), bullet(bt, BULLET.ROTATION)));
          const actual = shot(b, C.BACCUM).add(shot(b, C.BSPEED)).toVar();
          shot(b, C.BACCUM).assign(actual.mod(10));
          const pos = move(ivec2(shot(b, 0), shot(b, 1)), shot(b, C.BFACE), actual.sub(actual.mod(10))).toVar();
          If(pos.x.lessThan(int(0)).or(pos.y.lessThan(int(0))).or(pos.x.greaterThanEqual(int(setup.grid.width * 256))).or(pos.y.greaterThanEqual(int(setup.grid.height * 256))), () => {
            shot(b, C.BACTIVE).assign(0);
          }).Else(() => {
            const explode = forced.toVar();
            If(forced.equal(int(0)), () => {
              shot(b, C.BTIMER).assign(intMax(int(0), shot(b, C.BTIMER).sub(1)));
              If(shot(b, C.BARM).greaterThan(int(0)), () => { shot(b, C.BARM).subAssign(1); }).Else(() => {
                const d = unitDistance(pos, ivec2(shot(b, C.BTO_X), shot(b, C.BTO_Y))).toVar();
                explode.assign(int(shot(b, C.BTIMER).equal(int(0)).or(d.lessThan(int(16))).or(d.lessThan(int(256)).and(d.greaterThan(shot(b, C.BPROXIMITY))))));
                shot(b, C.BPROXIMITY).assign(d);
              });
            });
            If(explode.notEqual(int(0)), () => {
              If(forced.equal(int(0)).and(bullet(bt, BULLET.ARCING).equal(int(0))).and(bullet(bt, BULLET.HOMING).equal(int(0))), () => {
                shot(b, 0).assign(shot(b, C.BTO_X));
                shot(b, 1).assign(shot(b, C.BTO_Y));
              });
              shot(b, C.BACTIVE).assign(0);
              shot(b, C.BIMPACT).assign(1);
              shot(b, C.BEXPLODED).assign(clock());
            }).Else(() => {
              shot(b, 0).assign(pos.x);
              shot(b, 1).assign(pos.y);
              If(bt.equal(int(1)).and(shot(b, C.BDAMAGE).greaterThan(int(5))), () => { shot(b, C.BDAMAGE).subAssign(1); });
            });
          });
        }).Else(() => {
          atomicAnd(index.element(b.div(32).add(PROJECTILE_BITS)), projectileBit(b).bitNot());
        });
      });
    });
    // Ported from COMBAT.CPP, Modify_Damage; INFANTRY.CPP, Take_Damage.
    const damage = (id: I, raw: I, warhead: I, pos: Node<'ivec2'>, source: I) => {
      const result = int(0).toVar(), d = unitDistance(pos, position(id)).toVar();
      If(unit(id, U.UHEALTH).greaterThan(int(0)).and(type(id, TYPE.IMMUNE).equal(int(0))).and(id.notEqual(source)).and(d.lessThan(int(384))), () => {
        const delta = abs(pos.div(256).sub(position(id).div(256)));
        If(delta.x.lessThanEqual(int(1)).and(delta.y.lessThanEqual(int(1))), () => {
          const modifier = table.element(warhead.mul(6).add(warheadBase + 1).add(type(id, TYPE.ARMOR))).toVar();
          const shift = intMin(int(16), d.shiftRight(table.element(warhead.mul(6).add(warheadBase)).bitAnd(31))).toVar();
          result.assign(select(state(id, C.CPRONE).notEqual(int(0)), raw.shiftRight(1), raw).mul(modifier).add(128).shiftRight(8).shiftRight(shift));
          If(result.notEqual(int(0)).and(unit(id, U.UTYPE).equal(int(MOVEMENT.findIndex(t => t.name === 'E4')))), () => {
            result.addAssign(modifier.mul(5).add(128).shiftRight(8).shiftRight(shift));
          });
        });
      });
      return result;
    };
    // COMBAT.CPP, Explosion_Damage: center, N, NE, E, SE, S, SW, W, NW; at most 32 objects.
    const victims = (pos: Node<'ivec2'>, source: I, visit: (id: I) => void) => {
      const total = int(0).toVar(), origin = pos.div(256).toVar();
      Loop(9, ({ i: neighbor }) => {
        const dx = table.element(neighbor.mul(2).add(neighborsBase)), dy = table.element(neighbor.mul(2).add(neighborsBase + 1));
        const x = origin.x.add(dx), y = origin.y.add(dy);
        If(inside(x, y).and(total.lessThan(int(32))), () => {
          const last = int(-1).toVar();
          Loop(() => {
            const chosen = int(count).toVar();
            forCell(y.mul(setup.grid.width).add(x), other => {
              If(other.greaterThan(last).and(other.notEqual(source)).and(unit(other, U.UHEALTH).greaterThan(int(0))), () => { chosen.assign(intMin(chosen, other)); });
            });
            If(chosen.equal(int(count)).or(total.greaterThanEqual(int(32))), () => { Break(); });
            last.assign(chosen);
            total.addAssign(1);
            visit(chosen);
          });
        });
      });
    };
    const scatterDamage = indirect(this.projectileDispatch, () => {
      If(int(instanceIndex).lessThan(read(int(PROJECTILE_COUNT))), () => {
        const b = read(int(instanceIndex).add(PROJECTILE_JOBS)).toVar();
        If(shot(b, C.BIMPACT).notEqual(int(0)), () => {
          const pos = ivec2(shot(b, 0), shot(b, 1)).toVar(), source = shot(b, C.BSOURCE).toVar();
          victims(pos, source, id => {
            const value = damage(id, shot(b, C.BDAMAGE), bullet(shot(b, C.BTYPE), BULLET.WARHEAD), pos, source);
            If(value.notEqual(int(0)), () => { atomicAdd(index.element(id.add(DAMAGE)), uint(value)); atomicMin(index.element(id.add(CAUSE)), uint(b)); });
          });
        });
      });
    });
    // Ported from OBJECT.CPP / FOOT.CPP / UNIT.CPP / INFANTRY.CPP, Take_Damage.
    const injure = (id: I, amount: I, warhead: I, source: I, death: () => void) => {
      unit(id, U.UHEALTH).assign(intMax(int(0), unit(id, U.UHEALTH).sub(amount)));
      If(unit(id, U.UHEALTH).equal(int(0)), () => {
        state(id, C.CDEATH).assign(clock());
        state(id, C.CWARHEAD).assign(warhead);
        state(id, C.CKILLER).assign(source);
        state(id, C.CTARGET).assign(-1);
        state(id, C.CFIRE).assign(-1);
        goals.element(id).assign(-1);
        paths.element(id).assign(-1);
        for (const f of [U.UDEST, U.UMIDDLE, U.UTRACK, U.UJUMP])
          unit(id, f).assign(-1);
        unit(id, U.UDESIRED).assign(unit(id, U.UFACE));
        write(cellAt(position(id)).add(DEAD_CELLS), int(1));
        death();
      }).Else(() => {
        If(unit(id, U.UKIND).notEqual(int(0)), () => {
          const fear = state(id, C.CFEAR).toVar();
          state(id, C.CFEAR).assign(select(source.greaterThanEqual(int(0)).and(fear.lessThan(int(100))), select(table.element(unit(id, U.UTYPE).add(fraidyBase)).notEqual(int(0)), int(200), int(100)), intMin(int(255), fear.add(select(unit(id, U.UHEALTH).mul(2).greaterThan(type(id, TYPE.STRENGTH)), int(2), int(10))))));
          state(id, C.CFIRE).assign(-1);
        });
        If(source.greaterThanEqual(int(0)), () => {
          If(unit(source, U.UOWNER).notEqual(unit(id, U.UOWNER)).and(type(id, TYPE.PRIMARY).greaterThanEqual(int(0)))
            .and(state(id, C.CMISSION).equal(int(C.GUARD)).or(state(id, C.CMISSION).equal(int(C.ATTACK)))), () => {
              const target = state(id, C.CTARGET).toVar(), respond = int(target.equal(int(-1))).toVar();
              If(target.notEqual(int(-1)).and(unit(id, U.UOWNER).notEqual(int(0))), () => { respond.assign(int(inRange(id, target).not())); });
              If(respond.notEqual(int(0)).and(unit(id, U.UOWNER).notEqual(int(0)).or(inRange(id, source))), () => {
                state(id, C.CTARGET).assign(source);
                If(unit(id, U.UOWNER).notEqual(int(0)), () => { state(id, C.CMISSION).assign(C.HUNT); });
              });
            });
        });
      });
    };
    const resolve = kernel(count, () => {
      const id = int(instanceIndex), total = read(id.add(DAMAGE)).toVar(), cause = read(id.add(CAUSE)).toVar();
      If(total.notEqual(int(0)), () => {
        injure(id, total, bullet(shot(cause, C.BTYPE), BULLET.WARHEAD), shot(cause, C.BSOURCE), () => {
          If(explosive(id), () => {
            atomicOr(index.element(id.div(32).add(DEATH_BITS)), uint(1).shiftLeft(uint(id.mod(32))));
            atomicAdd(index.element(DEATH_COUNT), uint(1));
          });
        });
      });
    });
    // Only death cascades use ordered processing. The initial queue is built from a bitset, not
    // atomic append order. Neighbor victims are visited in ascending ID order.
    const deaths = kernel(1, () => {
      If(read(int(DEATH_COUNT)).greaterThan(int(0)), () => {
        const end = int(0).toVar();
        Loop(words, ({ i }) => {
          const bits = uint(read(int(i).add(DEATH_BITS))).toVar();
          Loop(() => {
            If(bits.equal(uint(0)), () => { Break(); });
            write(end.add(QUEUE), int(i).mul(32).add(int(trailingZeros(bits))));
            end.addAssign(1);
            bits.assign(bits.bitAnd(bits.sub(uint(1))));
          });
        });
        Loop({ start: int(0), end, type: 'int' }, ({ i }) => {
          const dead = read(int(i).add(QUEUE)).toVar(), kind = unit(dead, U.UTYPE).toVar();
          const napalm = type(dead, TYPE.EXPLOSION).equal(int(ANIMATION_IDS.ANIM_NAPALM3));
          const raw = select(napalm, int(200), select(kind.equal(int(23)), int(30), select(kind.equal(int(25)).or(kind.equal(int(26))), int(80), int(0)))).toVar();
          const wh = select(napalm.or(kind.equal(int(25))), int(3), int(1)).toVar();
          const source = select(kind.equal(int(1)), state(dead, C.CKILLER), int(-1)).toVar();
          If(raw.notEqual(int(0)), () => {
            victims(position(dead), source, chosen => {
              const d = damage(chosen, raw, wh, position(dead), source);
              If(d.notEqual(int(0)), () => {
                injure(chosen, d, wh, source, () => {
                  If(explosive(chosen), () => { write(end.add(QUEUE), chosen); end.addAssign(1); });
                });
              });
            });
          });
        });
      });
    });
    // TECHNO.CPP Record_The_Kill; CREW.H/INFANTRY.CPP Made_A_Kill. Reuse damage
    // scratch after all deaths are settled. Counts commute; RNG uses per-source
    // ordinals, so neither victim scheduling nor atomic arrival order matters.
    const clearCredits=kernel(count, () => {write(int(instanceIndex).add(DAMAGE),int(0));});
    const gatherCredits=kernel(count, () => {
      const id=int(instanceIndex), killer=state(id,C.CKILLER).toVar();
      If(state(id,C.CDEATH).equal(clock()).and(killer.greaterThanEqual(int(0))), () => {
        atomicAdd(index.element(killer.add(DAMAGE)),uint(1));
      });
    });
    const recordKills=kernel(count, () => {
      const id=int(instanceIndex), credits=read(id.add(DAMAGE)).toVar();
      If(credits.greaterThan(int(0)), () => {
        const old=state(id,C.CKILLS).toVar();
        If(unit(id,U.UKIND).notEqual(int(0)), () => {
          const excited=int(unit(id,U.UTYPE).equal(int(movementType('RMBO')))).toVar();
          Loop({start:int(0),end:credits,type:'int'}, ({i}) => {
            If(excited.notEqual(int(0)), () => {Break();});
            const draw=int(randomNode(uint(setup.seed),uint(clock()),uint(id),uint(i.add(80))).mod(uint(6)));
            excited.assign(int(draw.lessThan(old.add(i).bitAnd(65535))));
          });
          If(excited.notEqual(int(0)), () => {
            state(id,C.CSTOKED).assign(1);state(id,C.CCOMMENT).assign(clock().add(30));
          });
        });
        state(id,C.CKILLS).assign(old.add(credits).bitAnd(65535));
      });
    });
    // Each affected cell allocates its own five spots in ascending parent ID.
    // Different cells run in parallel; no winner depends on atomic arrival order.
    const occupancyChanges = storage(this.movement.occupancyChanges, 'uint', count + 1).toAtomic();
    const crews = kernel(cells, () => {
      const cell = int(instanceIndex);
      If(read(cell.add(DEAD_CELLS)).notEqual(int(0)), () => {
        atomicStore(occupancyChanges.element(count), uint(1));
        const mask = int(0).toVar(), last = int(-1).toVar();
        forCell(cell, other => {
          If(unit(other, U.UHEALTH).greaterThan(int(0)), () => { mask.bitOrAssign(select(unit(other, U.UKIND).equal(int(0)), int(31), int(1).shiftLeft(unit(other, U.USLOT)))); });
        });
        Loop(5, ({ i: spot }) => {
          const owner = int(occupancy.element(cell.mul(5).add(spot))).sub(1);
          If(owner.greaterThanEqual(int(0)), () => { If(unit(owner, U.UHEALTH).greaterThan(int(0)), () => { mask.bitOrAssign(int(1).shiftLeft(spot)); }); });
        });
        Loop(() => {
          const dead = int(count).toVar();
          forCell(cell, other => {
            If(other.greaterThan(last).and(state(other, C.CDEATH).equal(clock())).and(table.element(other.add(crewBase)).greaterThanEqual(int(0))), () => { dead.assign(intMin(dead, other)); });
          });
          If(dead.equal(int(count)).or(mask.equal(int(31))), () => { Break(); });
          last.assign(dead);
          const id = table.element(dead.add(crewBase)).toVar();
          If(id.greaterThanEqual(int(0)).and(type(dead, TYPE.CREW).notEqual(int(0))).and(type(dead, TYPE.TRANSPORT).equal(int(0))).and(pick(dead, 60, int(2)).equal(int(0))), () => {
            const slot = int(-1).toVar();
            Loop(5, ({ i: j }) => { If(slot.lessThan(int(0)).and(mask.bitAnd(int(1).shiftLeft(j)).equal(int(0))), () => { slot.assign(j); }); });
            If(slot.greaterThanEqual(int(0)), () => {
              const x = select(slot.equal(int(0)), int(128), select(slot.equal(int(1)).or(slot.equal(int(3))), int(64), int(192)));
              const y = select(slot.equal(int(0)), int(128), select(slot.lessThan(int(3)), int(64), int(192)));
              unit(id, 0).assign(cell.mod(setup.grid.width).mul(256).add(x));
              unit(id, 1).assign(cell.div(setup.grid.width).mul(256).add(y));
              unit(id, U.UCELL).assign(cell);
              unit(id, U.USLOT).assign(slot);
              unit(id, U.UHEALTH).assign(pick(dead, 61, type(id, TYPE.STRENGTH).div(2).sub(4)).add(5));
              state(id, C.CMISSION).assign(select(unit(id, U.UOWNER).equal(int(0)), int(C.GUARD), int(C.HUNT)));
              mask.bitOrAssign(int(1).shiftLeft(slot));
            });
          });
        });
      });
    });
    const scatterCrews = kernel(count, () => {
      const id = int(instanceIndex), parent = state(id, C.CCREW).toVar();
      If(parent.greaterThanEqual(int(0)).and(unit(id, U.UHEALTH).greaterThan(int(0))), () => {
        If(state(parent, C.CDEATH).equal(clock()), () => {
          const cell = unit(id, U.UCELL).toVar();
          for (const [dx, dy] of [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]) {
            const xx = cell.mod(setup.grid.width).add(dx), yy = cell.div(setup.grid.width).add(dy), next = yy.mul(setup.grid.width).add(xx);
            If(inside(xx, yy), () => {
              If(occupancy.element(next.mul(5)).equal(int(0)).and(table.element(next.add(openBase)).notEqual(int(0))), () => { goals.element(id).assign(next); });
            });
          }
        });
      });
    });
    const pending = storage(this.movement.pending, 'int', count * 2).setName('combat_pending');
    this.capture = kernel(count, () => {
      const id = int(instanceIndex);
      write(id.mul(2).add(COMMANDS), pending.element(id.mul(2)));
      write(id.mul(2).add(COMMANDS + 1), pending.element(id.mul(2).add(1)));
      If(pending.element(id.mul(2)).notEqual(int(2)), () => { pending.element(id.mul(2)).assign(-1); });
    });
    this.apply = kernel(count, () => {
      const id = int(instanceIndex), kind = read(id.mul(2).add(COMMANDS)).toVar(), target = read(id.mul(2).add(COMMANDS + 1)).toVar();
      If(kind.greaterThanEqual(int(0)).and(unit(id, U.UHEALTH).greaterThan(int(0))).and(unit(id, U.UOWNER).equal(int(0))), () => {
        state(id, C.CTARGET).assign(select(kind.equal(int(3)), target, select(kind.equal(int(4)), target.negate().sub(2), int(-1))));
        state(id, C.CMISSION).assign(select(kind.greaterThanEqual(int(3)), int(C.ATTACK), select(kind.equal(int(0)), int(C.MOVE), int(C.GUARD))));
        state(id, C.CAPPROACH_GOAL).assign(-1);
        state(id, C.CLOCAL_ROUTE).assign(0);
        state(id, C.CLOCAL_WAIT).assign(0);
        state(id, C.CLOCAL_DEST).assign(-1);
        state(id, C.CROUTE_LENGTH).assign(0);
        state(id, C.CSCAN).assign(0);
        state(id, C.CFIRE).assign(-1);
        If(kind.notEqual(int(2)), () => { goals.element(id).assign(select(kind.equal(int(0)), target, int(-1))); });
        paths.element(id).assign(-1);
        unit(id, U.UWAIT).assign(0);
        unit(id, U.URETRIES).assign(10);
        unit(id, U.UROUTE).assign(-1);
      });
    });
    this.commands = keep(new Int32Array(count * 2).fill(-1));
    const incoming = storage(this.commands, 'int', count * 2).setName('combat_incoming').toReadOnly();
    this.upload = kernel(count * 2, () => { write(int(instanceIndex).add(COMMANDS), incoming.element(instanceIndex)); });
    this.before = [this.capture, clearHeads, link, discover, clearThreats, clearGuards, threats, prepare, collectRoutes, prepareRoutes];
    this.routes = [solveRoutes, orient];
    this.impacts = [clearHeads, link, clearImpacts, clearDeaths, claimCrush, crush, fire, clearImpacts,
      clearProjectileJobs, collectProjectiles, prepareProjectiles];
    this.after = [fly, scatterDamage, resolve, deaths, clearCredits, gatherCredits, recordKills, crews, ...this.movement.occupancyPasses, scatterCrews,
      this.apply, ...this.sight.kernels];
  }
  get units() { return this.movement.units; }
  get frame() { return this.movement.frame; }
  /** The first displayed frame has no logic tick; compile combat before exposing input. */
  async prepareForPlay() {
    await this.movement.prepareForPlay();
    await this.renderer.compileComputeAsync(this.kernels);
  }
  step(commands: readonly (U.UnitCommand | C.AttackCommand)[] = []) {
    this.stepMany(1);
    if (commands.length) {
      const data = this.commands.array as Int32Array;
      data.fill(-1);
      for (const command of commands) {
        if (command.frame !== this.frame)
          throw new Error('Commands must be submitted on their recorded tick');
        const kind = command.kind === 'move' ? 0 : command.kind === 'stop' ? 1 : command.kind === 'scatter' ? 2 : command.kind === 'attack' ? 3 : 4;
        for (const id of command.ids) {
          data[id * 2] = kind;
          data[id * 2 + 1] = command.target ?? -1;
        }
      }
      this.commands.needsUpdate = true;
      this.movement.applyCommands(commands.filter((c): c is U.UnitCommand => c.kind === 'scatter'));
      this.renderer.compute([this.upload, this.apply]);
    }
  }
  /** Producer and indirect consumer dispatches must be in separate compute passes. */
  syncUploads() {
    if (this.projectileVersion !== this.projectiles.version) {
      this.renderer.compute(this.syncProjectiles);
      this.projectileVersion = this.projectiles.version;
    }
  }
  prepareStep() {
    this.syncUploads();
    this.renderer.compute(this.before);
    this.renderer.compute(this.routes);
  }
  resolveStep() {
    this.renderer.compute(this.impacts);
    this.renderer.compute(this.after);
  }
  stepMany(ticks: number) {
    for (let tick = 0; tick < ticks; tick++) {
      this.prepareStep();
      this.movement.step();
      this.resolveStep();
    }
  }
  buffers() { return [...this.movement.buffers(), this.state, this.projectiles, this.sight.mapped]; }
  async snapshot() { return Promise.all(this.buffers().map(async (b) => new Int32Array(await this.renderer.getArrayBufferAsync(b)))); }
  dispose() {
    this.sight.dispose();
    this.movement.dispose();
    for (const k of this.kernels)
      k.dispose();
    releaseStorage(this.renderer, this.attributes);
  }
}
