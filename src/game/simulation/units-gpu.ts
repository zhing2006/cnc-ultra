import { loop as Loop } from '../../engine/simulation/loop.ts';
// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type ComputeNode, type WebGPURenderer, type Node } from 'three/webgpu';
import { Fn, If, Break, int, uint, instanceIndex, storage, uniform, atomicStore, atomicLoad, atomicMin, atomicOr, wgslFn, ivec2, select } from 'three/tsl';
import { GpuFlowFields, FIELD_WORDS } from '../../engine/simulation/flow.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { randomNode, intMin, intMax } from '../../engine/simulation/integer-nodes.ts';
import { GpuChecksum } from '../../engine/simulation/checksum.ts';
import { DIRECTIONS, UNREACHABLE } from '../../engine/simulation/state.ts';
import { MOVEMENT, GROUND_SPEED,movementType } from '../data/movement.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { combatTypes } from '../data/combat.ts';
import { TRACKS, TRACK_CONTROL, RAW_TRACKS } from '../data/tracks.ts';
import { movePoint } from '../coord.ts';
import { INFANTRY_SPOTS } from './map.ts';
import { direction8, unitDirection, unitDistance, unitRotate } from './units-nodes.ts';
import { SPOT_SEQUENCE } from './infantry-spots.ts';
import { DESTINATION_NEIGHBORS, PATH_DELAY } from './navigation.ts';
import * as S from './units-state.ts';
import { GpuOccupancyEdits } from './occupancy-edits.ts';
import { GpuActorIndex } from './actor-index.ts';
type I = Node<'int'>;
/** Passes surrounding each movement tick, including ticks submitted in a batch. */
export interface UnitTickExtension {
  before: ComputeNode[];
  after: ComputeNode[];
  refreshOccupancy?: boolean;
}
const PROPOSAL_WORDS = 20;
const P_CELL = 0;
const P_MIDDLE = 1;
const P_SLOT = 2;
const P_TRACK = 3;
const P_WAS_DRIVING = 4;
const P_ROTATED = 5;
const P_NEXT = 6;
const P_FOLLOWING = 7;
const P_COST = 8;
const P_GOAL = 16;
const P_READY = 17;
const P_JUMP_NEXT = 18;
const P_APPROACH = 19;
const TYPE_INFANTRY = 0;
const TYPE_SPEED = 1;
const TYPE_ROTATION = 2;
const TYPE_STRENGTH = 3;
const TYPE_LOCOMOTION = 4;
const TYPE_CRUSHER = 5;
const TYPE_WORDS = 6;
const TRACK_START = 0;
const TRACK_RAW = 1;
const TRACK_FACING = 2;
const TRACK_FLAGS = 3;
const TRACK_JUMP = 4;
const TRACK_ENTRY = 5;
const TRACK_CELL = 6;
const TRACK_WORDS = 7;
// TSL has no atomicExchange wrapper. Only the cell-list link needs this WGSL primitive.
const exchangeHead = wgslFn('fn exchangeHead(head: ptr<storage, atomic<u32>, read_write>, value: u32) -> u32 { return atomicExchange(head, value); }');
export class GpuUnits {
  readonly mapObservers=new Set<(edges:Uint32Array,passable:Uint8Array,land:Uint8Array)=>void>();
  readonly units: StorageBufferAttribute;
  readonly goals: StorageBufferAttribute;
  /** Basic_Path's effective destination, separate from the player's NavCom. */
  readonly pathGoals: StorageBufferAttribute;
  readonly control: StorageBufferAttribute;
  readonly occupancy: StorageBufferAttribute;
  /** Per-unit scatter flags followed by an occupancy invalidation flag. */
  readonly occupancyChanges: StorageBufferAttribute;
  readonly flow: GpuFlowFields;
  /** Shared scatter operations use the same writable bindings as movement. */
  readonly scattering:{unit(id:I,field:number):I;goal(id:I):I;move(id:I):I};
  readonly pending: StorageBufferAttribute;
  private readonly mapData:StorageBufferAttribute;
  private readonly mapOffsets:{land:number;edges:number;open:number};
  private readonly applyPending: ComputeNode;
  private readonly resolvePaths: ComputeNode;
  private readonly attributes: StorageBufferAttribute[] = [];
  private readonly kernels: ComputeNode[] = [];
  private readonly tick: ComputeNode[];
  private readonly prepare: ComputeNode[];
  private readonly batch: ComputeNode[];
  private readonly extendedBatches = new WeakMap<UnitTickExtension, {step: ComputeNode[]; batch: ComputeNode[]}>();
  readonly occupancyPasses: ComputeNode[];
  private readonly command: ComputeNode;
  private readonly ids: StorageBufferAttribute;
  private readonly commandKind = uniform(0, 'int');
  private readonly target = uniform(-1, 'int');
  private readonly digest: GpuChecksum;
  private readonly invalidateOccupancy: ComputeNode;
  private unitsVersion = -1;
  private relations?:GpuActorIndex;
  private edits?:GpuOccupancyEdits;
  private editingOccupancy=false;
  enableOccupancyEdits(){this.edits??=new GpuOccupancyEdits(this);}
  beginOccupancyEdits(){this.enableOccupancyEdits();this.edits!.begin();this.editingOccupancy=true;}
  endOccupancyEdits(){this.editingOccupancy=false;}
  get actorIndex(){return this.relations??=new GpuActorIndex(this);}
  frame = 0;
  constructor(readonly renderer: WebGPURenderer, readonly setup: S.UnitsSetup) {
    const count = setup.units.length;
    const cells = setup.grid.edges.length;
    const keep = (a: Int32Array | Uint32Array) => {
      const b = new StorageBufferAttribute(a, 1);
      this.attributes.push(b);
      return b;
    };
    const kernel = (n: number, body: () => void) => {
      const k = Fn(() => {
        body();
      })().compute(n);
      this.kernels.push(k);
      return k;
    };
    this.units = keep(S.initialUnits(setup));
    this.goals = keep(new Int32Array(count).fill(-1));
    this.pathGoals = keep(new Int32Array(count).fill(-1));
    this.control = keep(new Int32Array([0, setup.seed]));
    this.occupancy = keep(new Uint32Array(cells * 5));
    this.ids = keep(new Int32Array(count));
    this.pending = keep(new Int32Array(count * 2).fill(-1));
    this.flow = new GpuFlowFields(renderer, setup.grid, this.pathGoals);
    const u = storage(this.units, 'int', count * S.WORDS).setName('unit_u');
    const goals = storage(this.goals, 'int', count).setName('unit_goals');
    const pathGoals = storage(this.pathGoals, 'int', count).setName('unit_pathGoals');
    const control = storage(this.control, 'int', 2).setName('unit_control');
    const occupancy = storage(this.occupancy, 'uint', cells * 5).setName('unit_occupancy').toAtomic();
    const claims = storage(keep(new Uint32Array(cells * 5)), 'uint', cells * 5).setName('unit_claims').toAtomic();
    const changes = new Uint32Array(count + 1);
    changes[count] = 1;
    this.occupancyChanges = keep(changes);
    const nudges = storage(this.occupancyChanges, 'uint', count + 1).setName('unit_nudges').toAtomic();
    // Rebuild passes consume the flag after all invalidation writes. Reading
    // it through atomics in every cell invocation serializes AMD's D3D path.
    const occupancyStatus = storage(this.occupancyChanges, 'uint', count + 1).setName('unit_occupancy_status').toReadOnly();
    const invalidateOccupancy = () => { atomicStore(nudges.element(count), uint(1)); };
    const proposal = storage(keep(new Int32Array(count * PROPOSAL_WORDS)), 'int', count * PROPOSAL_WORDS).setName('unit_proposal');
    const heads = storage(keep(new Uint32Array(cells)), 'uint', cells).setName('unit_heads').toAtomic();
    const links = storage(keep(new Uint32Array(count)), 'uint', count).setName('unit_links');
    const ids = storage(this.ids, 'int', count).setName('unit_ids').toReadOnly();
    const pending = storage(this.pending, 'int', count * 2).setName('unit_pending');
    const constants: number[] = [];
    const append = (values: readonly number[]) => {
      const offset = constants.length;
      constants.push(...values);
      return offset;
    };
    const typeBase = append(MOVEMENT.flatMap((t, i) => [t.infantry, t.speed, t.rotation, t.strength, t.locomotion, combatTypes[i].crusher]));
    const landBase = append(Array.from(setup.land));
    const edgeBase = append(Array.from(setup.grid.edges));
    const directionsBase = append(DIRECTIONS.flat());
    const openBase = append(Array.from(setup.passable ?? setup.grid.edges, value => value ? 1 : 0));
    const groundBase = append(GROUND_SPEED.flat());
    const spotBase = append(INFANTRY_SPOTS.flat());
    const sequenceBase = append(SPOT_SEQUENCE.flat());
    const trigBase = append(Array.from({ length: 256 }, (_, d) => {
      const [x, y] = movePoint(0, 0, d, 128);
      return [x, -y];
    }).flat());
    const trackStarts = TRACKS.map(t => append(t.flat()));
    const trackBase = append(TRACK_CONTROL.flatMap(t => [trackStarts[Math.max(0, t[0])], t[0], t[2], t[3], ...RAW_TRACKS[Math.max(0, t[0])]]));
    this.mapData=keep(Int32Array.from(constants));this.mapOffsets={land:landBase,edges:edgeBase,open:openBase};
    const data = storage(this.mapData, 'int', constants.length).setName('unit_data').toReadOnly();
    const point = (cell: I, slot: I = int(0)) => ivec2(
      cell.mod(int(setup.grid.width)).mul(int(256)).add(data.element(slot.mul(int(2)).add(int(spotBase)))),
      cell.div(int(setup.grid.width)).mul(int(256)).add(data.element(slot.mul(int(2)).add(int(spotBase + 1)))));
    const position = (at: I) => ivec2(u.element(at), u.element(at.add(int(1))));
    const type = (at: I, field: number) => data.element(u.element(at.add(int(S.UTYPE))).mul(int(TYPE_WORDS)).add(int(typeBase + field)));
    const terrainOpen = (cell: I, at: I) => data.element(cell.add(int(openBase))).notEqual(int(0)).and(
      data.element(data.element(cell.add(int(landBase))).mul(int(7)).add(type(at, TYPE_LOCOMOTION)).add(int(groundBase))).notEqual(int(0)));
    // Ported from FACING8.ASM, Desired_Facing8: half the major axis, rounded up.
    const cellFacing = (deltaX: I, deltaY: I) => {
      // Materialize both axes before the branches; each branch and the axis test use them.
      const dx = deltaX.toVar(), dy = deltaY.toVar();
      const ax = intMax(dx, dx.negate()).toVar(), ay = intMax(dy, dy.negate()).toVar();
      const facing = select(dx.lessThan(int(0)), select(dy.greaterThan(int(0)), int(5), int(7)),
        select(dy.greaterThan(int(0)), int(3), int(1))).toVar();
      If(intMin(ax, ay).lessThan(intMax(ax, ay).add(int(1)).shiftRight(int(1))), () => {
        facing.assign(select(ax.greaterThanEqual(ay), select(dx.lessThan(int(0)), int(6), int(2)),
          select(dy.lessThan(int(0)), int(0), int(4))));
      });
      return facing;
    };
    // Ported from FOOT.CPP, Basic_Path. NavCom stays at the clicked cell; only the path goal changes.
    this.resolvePaths = kernel(count, () => {
      const id = int(instanceIndex), at = id.mul(int(S.WORDS)), goal = goals.element(id);
      If(goal.lessThan(int(0)).or(u.element(at.add(S.UDOMAIN)).notEqual(0)), () => { pathGoals.element(id).assign(-1); })
        .ElseIf(pathGoals.element(id).equal(int(-1)), () => {
          const target = goal.toVar();
          If(terrainOpen(goal, at).not(), () => {
            const gx = goal.mod(int(setup.grid.width)).toVar(), gy = goal.div(int(setup.grid.width)).toVar();
            const sx = u.element(at).div(int(256)).toVar(), sy = u.element(at.add(int(1))).div(int(256)).toVar();
            If(unitDistance(position(at), point(goal)).greaterThan(int(0x300)), () => {
              const facing = cellFacing(sx.sub(gx), sy.sub(gy));
              for (const offset of DESTINATION_NEIGHBORS) {
                const direction = facing.add(int(offset + 8)).bitAnd(int(7));
                If(target.equal(goal), () => {
                  const xx = gx.add(data.element(direction.mul(int(2)).add(int(directionsBase))));
                  const yy = gy.add(data.element(direction.mul(int(2)).add(int(directionsBase + 1))));
                  If(xx.greaterThanEqual(int(0)).and(yy.greaterThanEqual(int(0)))
                    .and(xx.lessThan(int(setup.grid.width))).and(yy.lessThan(int(setup.grid.height))), () => {
                    const cell = yy.mul(int(setup.grid.width)).add(xx), free = int(0).toVar();
                    If(terrainOpen(cell, at), () => {
                      Loop(5, ({ i: slot }) => {
                        const owner = atomicLoad(occupancy.element(cell.mul(int(5)).add(slot)));
                        If(owner.equal(uint(0)).or(owner.equal(uint(id.add(int(1))))), () => { free.addAssign(int(1)); });
                      });
                      If(free.equal(int(5)).or(type(at, TYPE_INFANTRY).notEqual(int(0)).and(free.greaterThan(int(0)))), () => {
                        target.assign(cell);
                      });
                    });
                  });
                });
              }
            });
            If(target.equal(goal), () => {
              // FINDPATH.CPP, Find_Path looks through intervening obstacles. The
              // shared flow field routes around them to the final legal prefix.
              const source = sy.mul(int(setup.grid.width)).add(sx), prefix = source.toVar(), cursor = source.toVar();
              Loop(Math.max(setup.grid.width, setup.grid.height), () => {
                const direction = cellFacing(gx.sub(cursor.mod(int(setup.grid.width))), gy.sub(cursor.div(int(setup.grid.width))));
                const dx = data.element(direction.mul(int(2)).add(int(directionsBase)));
                const dy = data.element(direction.mul(int(2)).add(int(directionsBase + 1)));
                cursor.addAssign(dy.mul(int(setup.grid.width)).add(dx));
                If(cursor.equal(goal), () => { Break(); });
                If(terrainOpen(cursor, at), () => { prefix.assign(cursor); });
              });
              If(prefix.notEqual(source), () => { target.assign(prefix); });
            });
          });
          pathGoals.element(id).assign(target);
        });
    });
    // INFANTRY.CPP, Start_Driver: the backed-up coordinate can stay in the source cell.
    const entryPoint = (cell: I, at: I) => {
      const source = position(at).toVar();
      const target = point(cell).sub(ivec2(128, 128)).add(ivec2(source.x.bitAnd(int(255)), source.y.bitAnd(int(255)))).toVar();
      const dir = int(unitDirection(source, target)).add(int(128)).bitAnd(int(255)).toVar();
      return ivec2(
        target.x.add(data.element(dir.mul(int(2)).add(int(trigBase))).mul(int(124)).shiftRight(int(7))),
        target.y.sub(data.element(dir.mul(int(2)).add(int(trigBase + 1))).mul(int(124)).shiftRight(int(7))));
    };
    const free = (cell: I, id: I, withClaims = false, physicalCell: I = cell) => {
      const chosen = int(-1).toVar();
      const available = int(0).toVar(), hostile = int(0).toVar();
      const at = id.mul(int(S.WORDS)).toVar();
      Loop(5, ({ i: s }) => {
        const owner = atomicLoad(occupancy.element(cell.mul(int(5)).add(s)));
        const unused = owner.equal(uint(0)).or(owner.equal(uint(id.add(int(1))))).toVar();
        // UNIT.CPP, Can_Enter_Cell: crushers may enter enemy infantry reservations.
        If(owner.greaterThan(uint(0)).and(type(at, TYPE_CRUSHER).notEqual(0)), () => {
          const other = int(owner).sub(1).mul(S.WORDS).toVar();
          If(u.element(other.add(S.UKIND)).notEqual(0).and(u.element(other.add(S.UOWNER)).notEqual(u.element(at.add(S.UOWNER)))), () => {
            unused.assign(true);
          });
        });
        If(owner.greaterThan(uint(0)).and(unused.not()),()=>{
          If(u.element(int(owner).sub(1).mul(S.WORDS).add(S.UOWNER)).notEqual(u.element(at.add(S.UOWNER))),()=>{hostile.assign(1);});
        });
        const physicalOwner = atomicLoad(occupancy.element(physicalCell.mul(int(5)).add(s)));
        const physicalFree = physicalOwner.equal(uint(0)).or(physicalOwner.equal(uint(id.add(int(1)))));
        if(withClaims){
          If(physicalOwner.greaterThan(uint(0)),()=>{
            If(u.element(int(physicalOwner).sub(1).mul(S.WORDS).add(S.UOWNER)).notEqual(u.element(at.add(S.UOWNER))),()=>{hostile.assign(1);});
          });
          const claim=atomicLoad(claims.element(physicalCell.mul(5).add(s)));
          If(claim.lessThan(uint(id)),()=>{
            If(u.element(int(claim).mul(S.WORDS).add(S.UOWNER)).notEqual(u.element(at.add(S.UOWNER))),()=>{hostile.assign(1);});
          });
        }
        const progress = unitDistance(point(physicalCell, s), point(cell)).lessThan(unitDistance(position(at), point(cell)));
        const allowed = withClaims
          ? unused.and(physicalFree).and(progress).and(atomicLoad(claims.element(physicalCell.mul(int(5)).add(s))).greaterThan(uint(id)))
          : unused;
        If(allowed, () => {
          available.bitOrAssign(int(1).shiftLeft(s));
        });
      });
      If(u.element(at.add(int(S.UKIND))).equal(int(0)), () => {
        If(available.equal(int(31)), () => {
          chosen.assign(0);
        });
      }).Else(() => {
        // Ported from INFANTRY.CPP, Start_Driver; CELL.CPP, Spot_Index/Closest_Free_Spot.
        const backed = entryPoint(cell, at).toVar();
        const xx = backed.x.bitAnd(int(255)), yy = backed.y.bitAnd(int(255));
        const preferred = select(unitDistance(ivec2(xx, yy), ivec2(128, 128)).lessThan(int(60)), int(0),
          int(1).add(int(xx.greaterThan(int(128)))).add(int(yy.greaterThan(int(128))).mul(int(2)))).toVar();
        const random = int(randomNode(uint(setup.seed), uint(control.element(0)), uint(id), uint(2)).mod(uint(4)));
        Loop(5, ({ i: rank }) => {
          const slot = preferred.toVar();
          If(rank.greaterThan(int(0)), () => {
            slot.assign(select(preferred.equal(int(0)), rank.sub(int(1)).add(random).bitAnd(int(3)).add(int(1)),
              data.element(preferred.mul(int(4)).add(rank).sub(int(1)).add(int(sequenceBase)))));
          });
          If(chosen.lessThan(int(0)).and(available.bitAnd(int(1).shiftLeft(slot)).notEqual(int(0))), () => {
            chosen.assign(slot);
          });
        });
      });
      If(hostile.notEqual(int(0)),()=>{chosen.assign(-1);});
      return chosen;
    };
    // UNIT.CPP / INFANTRY.CPP Can_Enter_Cell: report the enemy without changing a mission here.
    const recordObstruction=(id:I,at:I,cell:I)=>{
      const blocking=int(0).toVar();
      Loop(5,({i:slot})=>{
        const owner=int(atomicLoad(occupancy.element(cell.mul(5).add(slot)))).toVar();
        If(owner.greaterThan(int(0)).and(blocking.equal(int(0))),()=>{
          const other=owner.sub(1).mul(S.WORDS);
          If(u.element(other.add(S.UOWNER)).notEqual(u.element(at.add(S.UOWNER)))
            .and(type(at,TYPE_CRUSHER).equal(int(0)).or(u.element(other.add(S.UKIND)).equal(int(0)))),()=>{blocking.assign(owner);});
        });
      });
      If(blocking.greaterThan(int(0)),()=>{
        If(u.element(blocking.sub(1).mul(S.WORDS).add(S.UCLOAK)).equal(int(2)),()=>{
          // Defer shimmer until every mover has read the same cloak state.
          atomicOr(nudges.element(blocking.sub(1)),uint(2));
        }).Else(()=>{u.element(at.add(S.UOBSTRUCTION)).assign(blocking);u.element(at.add(S.UOBSTRUCTION_GOAL)).assign(goals.element(id));});
      });
    };
    const meta = storage(this.flow.fields, 'int', this.flow.fields.count).setName('unit_meta').toReadOnly();
    const lookup = storage(this.flow.lookup, 'int', cells).setName('unit_lookup').toReadOnly();
    const next = storage(this.flow.next, 'int', this.flow.next.count).setName('unit_next').toReadOnly();
    const distance = storage(this.flow.distance, 'int', this.flow.distance.count).setName('unit_distance').toReadOnly();
    const overrun = (at: I) => {
      If(type(at, TYPE_INFANTRY).equal(0), () => {
        u.element(at.add(S.UOVERRUN_CELL)).assign(u.element(at.add(1)).div(256).mul(setup.grid.width).add(u.element(at).div(256)));
        u.element(at.add(S.UOVERRUN_X)).assign(u.element(at));
        u.element(at.add(S.UOVERRUN_Y)).assign(u.element(at.add(1)));
      });
    };
    const arrive = (id: I, at: I) => {
      u.element(at).assign(u.element(at.add(int(S.UHEAD_X))));
      u.element(at.add(int(1))).assign(u.element(at.add(int(S.UHEAD_Y))));
      u.element(at.add(int(S.UCELL))).assign(u.element(at.add(int(S.UDEST))));
      overrun(at);
      u.element(at.add(int(S.USLOT))).assign(u.element(at.add(int(S.UDSLOT))));
      u.element(at.add(int(S.UDEST))).assign(-1);
      u.element(at.add(int(S.UMIDDLE))).assign(-1);
      u.element(at.add(int(S.UTRACK))).assign(-1);
      u.element(at.add(int(S.UTRACK_STEP))).assign(0);
      u.element(at.add(int(S.UWALK))).assign(0);
      If(goals.element(id).equal(u.element(at.add(int(S.UCELL)))), () => {
        goals.element(id).assign(-1);
      });
      If(pathGoals.element(id).equal(u.element(at.add(int(S.UCELL)))), () => { pathGoals.element(id).assign(-1); });
    };
    // Ported from DRIVE.CPP, While_Moving/Smooth_Turn, and INFANTRY.CPP, AI.
    const advance = (id: I, addSpeed = true) => {
      const at = id.mul(int(S.WORDS)).toVar();
      If(u.element(at.add(int(S.UDEST))).greaterThanEqual(int(0)), () => {
        const head = ivec2(u.element(at.add(int(S.UHEAD_X))), u.element(at.add(int(S.UHEAD_Y))));
        If(u.element(at.add(int(S.UKIND))).notEqual(int(0)), () => {
          u.element(at.add(int(S.UWALK))).addAssign(int(1));
          If(unitDistance(position(at), head).lessThan(int(16)), () => {
            arrive(id, at);
          }).Else(() => {
            const dir = int(unitDirection(position(at), head)).toVar();
            const speed = type(at, TYPE_SPEED).mul(select(u.element(at.add(S.USPEED)).equal(0), int(255), u.element(at.add(S.USPEED)))).add(int(128)).shiftRight(int(8));
            u.element(at).addAssign(data.element(dir.mul(int(2)).add(int(trigBase))).mul(speed).shiftRight(int(7)));
            u.element(at.add(int(1))).subAssign(data.element(dir.mul(int(2)).add(int(trigBase + 1))).mul(speed).shiftRight(int(7)));
          });
        }).Else(() => {
          const increment = addSpeed ? type(at, TYPE_SPEED).mul(u.element(at.add(int(S.USPEED)))).add(int(128)).shiftRight(int(8)) : int(0);
          const actual = u.element(at.add(int(S.UACCUM))).add(increment).toVar();
          const tc = u.element(at.add(int(S.UTRACK))).mul(int(TRACK_WORDS)).add(int(trackBase));
          const flags = data.element(tc.add(int(TRACK_FLAGS)));
          Loop({ start: int(0), end: int(64), type: 'int' }, () => {
            If(actual.greaterThan(int(10)).and(u.element(at.add(int(S.UDEST))).greaterThanEqual(int(0))), () => {
              actual.subAssign(int(10));
              const step = u.element(at.add(int(S.UTRACK_STEP))).toVar();
              const tr = data.element(tc.add(int(TRACK_START))).add(step.mul(int(3)));
              const x = data.element(tr).toVar();
              const y = data.element(tr.add(int(1))).toVar();
              const dir = data.element(tr.add(int(2))).toVar();
              If(x.equal(int(0)).and(y.equal(int(0))).and(step.notEqual(int(0))), () => {
                arrive(id, at);
                actual.assign(0);
              }).Else(() => {
                If(flags.bitAnd(int(1)).notEqual(int(0)), () => {
                  const old = x.toVar();
                  x.assign(y);
                  y.assign(old);
                  dir.assign(int(192).sub(dir));
                });
                If(flags.bitAnd(int(2)).notEqual(int(0)), () => {
                  x.assign(x.negate());
                  dir.assign(dir.negate());
                });
                If(flags.bitAnd(int(4)).notEqual(int(0)), () => {
                  y.assign(y.negate());
                  dir.assign(int(128).sub(dir));
                });
                u.element(at).assign(head.x.add(x));
                u.element(at.add(int(1))).assign(head.y.add(y));
                u.element(at.add(int(S.UFACE))).assign(dir.bitAnd(int(255)));
                u.element(at.add(int(S.UDESIRED))).assign(dir.bitAnd(int(255)));
                u.element(at.add(int(S.UTRACK_STEP))).addAssign(int(1));
                If(step.equal(data.element(tc.add(int(TRACK_CELL)))), () => {
                  u.element(at.add(int(S.UCELL))).assign(u.element(at.add(int(1))).div(int(256))
                    .mul(int(setup.grid.width)).add(u.element(at).div(int(256))));
                  overrun(at);
                });
                If(step.equal(data.element(tc.add(int(TRACK_JUMP)))), () => {
                  const following = proposal.element(id.mul(int(PROPOSAL_WORDS)).add(int(P_JUMP_NEXT)));
                  If(following.greaterThanEqual(int(0)), () => {
                    const face = direction8(point(u.element(at.add(int(S.UDEST)))), point(following));
                    const endFace = data.element(tc.add(int(TRACK_FACING))).add(int(16)).bitAnd(int(255)).shiftRight(int(5));
                    const candidate = endFace.mul(int(8)).add(face);
                    const newTrack = candidate.mul(int(TRACK_WORDS)).add(int(trackBase));
                    If(face.notEqual(endFace)
                      .and(data.element(newTrack.add(int(TRACK_RAW))).greaterThanEqual(int(0)))
                      .and(data.element(newTrack.add(int(TRACK_ENTRY))).notEqual(int(0))), () => {
                      u.element(at.add(int(S.UJUMP))).assign(following);
                      u.element(at.add(int(S.UJUMP_TRACK))).assign(candidate);
                    });
                  });
                });
              });
              If(u.element(at.add(int(S.UJUMP))).greaterThanEqual(int(0)), () => {
                Break();
              });
            });
          });
          u.element(at.add(int(S.UACCUM))).assign(actual);
        });
      });
    };
    // Ported from UNIT.CPP and INFANTRY.CPP, Scatter.
    const scatter = (id: I) => {
      const at = id.mul(int(S.WORDS)).toVar();
      const cell = u.element(at.add(int(S.UCELL)));
      const chosen = int(-1).toVar();
      const start = u.element(at.add(int(S.UFACE))).add(int(16)).bitAnd(int(255)).shiftRight(int(5)).toVar();
      If(u.element(at.add(int(S.UKIND))).notEqual(int(0)), () => {
        const local = ivec2(u.element(at).mod(int(256)), u.element(at.add(int(1))).mod(int(256)));
        If(local.x.notEqual(int(128)).or(local.y.notEqual(int(128))), () => {
          start.assign(direction8(ivec2(128, 128), local));
        });
        start.assign(start.add(int(randomNode(uint(setup.seed), uint(control.element(0)), uint(id), uint(1)).mod(uint(5)))).add(int(6)).bitAnd(int(7)));
      });
      Loop(8, ({ i }) => {
        const dir = start.add(int(i)).bitAnd(int(7));
        const offset = int(0).toVar();
        for (let d = 0; d < 8; d++)
          If(dir.equal(int(d)), () => {
            offset.assign(DIRECTIONS[d][1] * setup.grid.width + DIRECTIONS[d][0]);
          });
        If(data.element(cell.add(int(edgeBase))).bitAnd(int(1).shiftLeft(dir)).notEqual(int(0)), () => {
          const other = cell.add(offset);
          If(free(other, id).greaterThanEqual(int(0)), () => {
            chosen.assign(other);
          });
        });
      });
      If(chosen.greaterThanEqual(int(0)), () => {
        goals.element(id).assign(chosen);
        u.element(at.add(S.USCATTER_GOAL)).assign(chosen.add(1));
      });
      u.element(at.add(int(S.UROUTE))).assign(-1);
      u.element(at.add(int(S.USTALLED))).assign(0);
      pathGoals.element(id).assign(-1);
      return chosen;
    };
    this.scattering={unit:(id,field)=>u.element(id.mul(S.WORDS).add(field)),goal:id=>goals.element(id),move:scatter};
    // Ported from DRIVE.CPP, Start_Of_Move, and INFANTRY.CPP, AI; FOOT.H path constants.
    const failedPath = (id: I, at: I) => {
      u.element(at.add(int(S.UWAIT))).assign(PATH_DELAY);
      If(u.element(at.add(int(S.URETRIES))).equal(int(0))
        .or(unitDistance(position(at), point(goals.element(id))).lessThan(int(0x280))), () => {
        goals.element(id).assign(-1);
      })
        .Else(() => {
        u.element(at.add(int(S.URETRIES))).subAssign(int(1));
      });
    };
    const begin = kernel(1, () => control.element(0).addAssign(int(1)));
    const motion = kernel(count, () => {
      const id = int(instanceIndex);
      const at = id.mul(int(S.WORDS)).toVar();
      const p = id.mul(int(PROPOSAL_WORDS)).toVar();
      const ground = u.element(at.add(S.UDOMAIN)).equal(0).and(u.element(at.add(S.UATTACHED)).equal(0));
      const driving = u.element(at.add(int(S.UDEST))).greaterThanEqual(int(0)).and(ground).toVar();
      proposal.element(p.add(int(P_CELL))).assign(-1);
      proposal.element(p.add(int(P_WAS_DRIVING))).assign(int(driving));
      proposal.element(p.add(int(P_ROTATED))).assign(0);
      u.element(at.add(int(S.UJUMP))).assign(-1);
      u.element(at.add(S.UOVERRUN_CELL)).assign(-1);
      u.element(at.add(S.UOBSTRUCTION)).assign(0);
      u.element(at.add(int(S.UJUMP_TRACK))).assign(-1);
      atomicStore(nudges.element(id), 0);
      If(u.element(at.add(int(S.UWAIT))).greaterThan(int(0)), () => {
        u.element(at.add(int(S.UWAIT))).subAssign(int(1));
      });
      If(driving, () => {
        invalidateOccupancy();
        advance(id);
      }).Else(() => {
        If(ground.and(u.element(at.add(S.UTYPE)).notEqual(movementType('APC')).or(u.element(at.add(S.UDOOR)).equal(0))).and(u.element(at.add(int(S.UFACE))).notEqual(u.element(at.add(int(S.UDESIRED))))), () => {
          u.element(at.add(int(S.UFACE))).assign(unitRotate(u.element(at.add(int(S.UFACE))), u.element(at.add(int(S.UDESIRED))), type(at, TYPE_ROTATION)));
          proposal.element(p.add(int(P_ROTATED))).assign(1);
          If(u.element(at.add(int(S.UROTATED))).equal(int(0)), () => {
            u.element(at.add(int(S.UROTATED))).assign(control.element(0));
          });
        });
      });
    });
    const clear = kernel(cells * 5, () => {
      If(occupancyStatus.element(count).notEqual(uint(0)), () => {
        atomicStore(occupancy.element(instanceIndex), 0);
      });
      atomicStore(claims.element(instanceIndex), 0x7fffffff);
    });
    const buildingMasks=storage(keep(Int32Array.from(MOVEMENT.map(t=>BUILDINGS.get(t.name)?.occupy.reduce((bits,[x,y])=>bits|(1<<(y*4+x)),0)??0))),'int',MOVEMENT.length).toReadOnly();
    const buildingOccupancy=kernel(count,()=>{
      const id=int(instanceIndex),at=id.mul(S.WORDS);
      If(occupancyStatus.element(count).notEqual(uint(0)).and(u.element(at.add(S.UDOMAIN)).equal(2)).and(u.element(at.add(S.UHEALTH)).greaterThan(0)),()=>{
        const mask=buildingMasks.element(u.element(at.add(S.UTYPE))),origin=u.element(at.add(S.UORIGIN));
        Loop(16,({i})=>{If(mask.bitAnd(int(1).shiftLeft(i)).notEqual(0),()=>{
          const cell=origin.add(i.div(4).mul(setup.grid.width)).add(i.mod(4));
          Loop(5,({i:slot})=>{atomicStore(occupancy.element(cell.mul(5).add(slot)),uint(id.add(1)));});
        });});
      });
    });
    // Separate passes make a docked unit's reservation independent of invocation order.
    const occupy = [buildingOccupancy,...[1, 0].map(infantry => kernel(count, () => {
      If(occupancyStatus.element(count).notEqual(uint(0)), () => {
        const id = int(instanceIndex);
        const at = id.mul(int(S.WORDS)).toVar();
        for (const field of [S.UCELL, S.UDEST, S.UMIDDLE]) {
          const cell = u.element(at.add(int(field)));
          const reserved = field === S.UCELL
            ? u.element(at.add(int(S.UKIND))).equal(int(0)).or(u.element(at.add(int(S.UDEST))).lessThan(int(0)))
            : int(1).equal(int(1));
          If(cell.greaterThanEqual(int(0)).and(reserved).and(u.element(at.add(S.UHEALTH)).greaterThan(0)).and(u.element(at.add(S.UATTACHED)).equal(0))
            .and(u.element(at.add(S.UKIND)).equal(infantry))
            .and(u.element(at.add(S.UDOMAIN)).notEqual(2))
            .and(u.element(at.add(S.UDOMAIN)).notEqual(1).or(u.element(at.add(S.UALTITUDE)).lessThan(16)
              .and(u.element(at.add(S.UTYPE)).notEqual(movementType('C17'))).and(u.element(at.add(S.UTYPE)).notEqual(movementType('A10'))))), () => {
            const slot = u.element(at.add(field === S.UCELL ? S.USLOT : S.UDSLOT));
            Loop(5, ({ i: s }) => {
              If(u.element(at.add(int(S.UKIND))).equal(int(0)).or(slot.equal(int(s))), () => {
                atomicStore(occupancy.element(cell.mul(int(5)).add(s)), uint(id.add(int(1))));
              });
            });
          });
        }
      });
    }))];
    const finishOccupancy = kernel(1, () => { atomicStore(nudges.element(count), uint(0)); });
    this.invalidateOccupancy = kernel(1, invalidateOccupancy);
    const clearOccupancy = kernel(cells * 5, () => {
      If(occupancyStatus.element(count).notEqual(uint(0)), () => {
        atomicStore(occupancy.element(instanceIndex), uint(0));
      });
    });
    const makeQuery = (resolvePrefix:boolean) => kernel(count, () => {
      const id = int(instanceIndex);
      const p = id.mul(int(PROPOSAL_WORDS)).toVar();
      const at = id.mul(int(S.WORDS)).toVar();
      const goal = pathGoals.element(id).toVar();
      const cell = u.element(at.add(int(S.UCELL))).toVar();
      proposal.element(p.add(int(P_NEXT))).assign(-1);
      proposal.element(p.add(int(P_FOLLOWING))).assign(-1);
      proposal.element(p.add(int(P_READY))).assign(0);
      proposal.element(p.add(int(P_JUMP_NEXT))).assign(-1);
      If(goal.equal(int(S.DIRECT_STEP)), () => {
        proposal.element(p.add(int(P_READY))).assign(1);
        // snapshotGoals precedes the proposal query. Reuse it to keep this
        // kernel within WebGPU's eight-storage-buffer baseline.
        proposal.element(p.add(int(P_NEXT))).assign(proposal.element(p.add(int(P_GOAL))));
      }).ElseIf(goal.greaterThanEqual(int(0)), () => {
        const field = lookup.element(goal).toVar();
        If(field.greaterThanEqual(int(0)), () => {
          If(meta.element(field.mul(int(FIELD_WORDS)).add(int(1))).notEqual(int(0)), () => {
            proposal.element(p.add(int(P_READY))).assign(1);
            If(u.element(at.add(int(S.UDEST))).greaterThanEqual(int(0)), () => {
              proposal.element(p.add(int(P_JUMP_NEXT))).assign(next.element(field.mul(int(cells)).add(u.element(at.add(int(S.UDEST))))));
            });
            const route = u.element(at.add(int(S.UROUTE)));
            const first = select(route.greaterThanEqual(int(0)), route, next.element(field.mul(int(cells)).add(cell)));
            proposal.element(p.add(int(P_NEXT))).assign(first);
            If(first.greaterThanEqual(int(0)), () => {
              proposal.element(p.add(int(P_FOLLOWING))).assign(next.element(field.mul(int(cells)).add(first)));
            });
            for (let d = 0; d < 8; d++) {
              proposal.element(p.add(int(P_COST + d))).assign(0x7fffffff);
              If(data.element(cell.add(int(edgeBase))).bitAnd(int(1 << d)).notEqual(int(0)), () => {
                const neighbor = cell.add(int(DIRECTIONS[d][1] * setup.grid.width + DIRECTIONS[d][0]));
                const neighborCost = distance.element(field.mul(int(cells)).add(neighbor));
                If(neighborCost.lessThan(distance.element(field.mul(int(cells)).add(cell))), () => {
                  proposal.element(p.add(int(P_COST + d))).assign(neighborCost.add(d & 1 ? 362 : 256));
                });
              });
            }
            if(resolvePrefix){
              const requested=proposal.element(p.add(P_GOAL)).toVar();
              const defer=()=>{proposal.element(p.add(P_READY)).assign(0);proposal.element(p.add(P_NEXT)).assign(-1);};
              If(requested.greaterThanEqual(int(0)).and(u.element(at.add(S.UHEALTH)).greaterThan(int(0))).and(u.element(at.add(S.UATTACHED)).equal(int(0))).and(u.element(at.add(S.UDOMAIN)).equal(int(0))).and(u.element(at.add(S.UDEST)).lessThan(int(0))).and(u.element(at.add(S.UWAIT)).equal(int(0))),()=>{
                If(goal.equal(cell).and(requested.notEqual(cell)),()=>{
                  const cursor=cell.toVar(),prefix=cell.toVar();
                  Loop(Math.max(setup.grid.width,setup.grid.height),()=>{
                    If(cursor.equal(requested),()=>{Break();});
                    const direction=cellFacing(requested.mod(setup.grid.width).sub(cursor.mod(setup.grid.width)),requested.div(setup.grid.width).sub(cursor.div(setup.grid.width)));
                    cursor.addAssign(data.element(direction.mul(2).add(directionsBase+1)).mul(setup.grid.width).add(data.element(direction.mul(2).add(directionsBase))));
                    If(distance.element(field.mul(cells).add(cursor)).lessThan(int(UNREACHABLE)),()=>{prefix.assign(cursor);});
                  });
                  If(prefix.notEqual(cell),()=>{pathGoals.element(id).assign(prefix);defer();})
                    .Else(()=>{pathGoals.element(id).assign(-1);});
                }).ElseIf(distance.element(field.mul(cells).add(cell)).equal(int(UNREACHABLE)),()=>{
                  pathGoals.element(id).assign(cell);defer();
                });
              });
            }
          });
        });
      });
    });
    const query=makeQuery(false),proposalQuery=makeQuery(true);
    const snapshotGoals = kernel(count, () => {
      proposal.element(int(instanceIndex).mul(int(PROPOSAL_WORDS)).add(int(P_GOAL))).assign(goals.element(instanceIndex));
    });
    const clearHeads = kernel(cells, () => {
      atomicStore(heads.element(instanceIndex), uint(0xffffffff));
    });
    // Ported from DRIVE.CPP, Start_Of_Move, and UNIT.CPP, Can_Enter_Cell.
    const propose = kernel(count, () => {
      const id = int(instanceIndex);
      const at = id.mul(int(S.WORDS)).toVar();
      const p = id.mul(int(PROPOSAL_WORDS)).toVar();
      const goal = goals.element(id);
      const infantry = u.element(at.add(int(S.UKIND)));
      const cell = proposal.element(p.add(int(P_NEXT))).toVar();
      const middle = int(-1).toVar();
      const track = int(0).toVar();
      const slot = int(-1).toVar();
      const ok = int(1).toVar();
      If(u.element(at.add(int(S.UJUMP))).greaterThanEqual(int(0)), () => {
        const target = u.element(at.add(int(S.UJUMP)));
        If(free(target, id).greaterThanEqual(int(0)), () => {
          proposal.element(p.add(int(P_CELL))).assign(target);
          proposal.element(p.add(int(P_MIDDLE))).assign(-1);
          proposal.element(p.add(int(P_SLOT))).assign(0);
          proposal.element(p.add(int(P_TRACK))).assign(u.element(at.add(int(S.UJUMP_TRACK))));
          Loop(5, ({ i: s }) => {
            atomicMin(claims.element(target.mul(int(5)).add(s)), uint(id));
          });
        }).Else(()=>{recordObstruction(id,at,target);});
      });
      If(u.element(at.add(S.UTYPE)).notEqual(movementType('APC')).or(u.element(at.add(S.UDOOR)).equal(0)).and(goal.greaterThanEqual(int(0))).and(cell.lessThan(int(0))).and(proposal.element(p.add(int(P_READY))).notEqual(int(0)))
        .and(u.element(at.add(int(S.UDEST))).lessThan(int(0))).and(u.element(at.add(int(S.UWAIT))).equal(int(0)))

          .and(proposal.element(p.add(int(P_ROTATED))).equal(int(0)))
          .and(infantry.equal(int(0))
          .or(proposal.element(p.add(int(P_WAS_DRIVING))).equal(int(0)))), () => {
        const source=u.element(at.add(S.UCELL)).toVar();
        If(goal.notEqual(source),()=>{
          const direction=cellFacing(goal.mod(setup.grid.width).sub(source.mod(setup.grid.width)),goal.div(setup.grid.width).sub(source.div(setup.grid.width)));
          const next=source.add(data.element(direction.mul(2).add(directionsBase+1)).mul(setup.grid.width)).add(data.element(direction.mul(2).add(directionsBase)));
          recordObstruction(id,at,next);
        });
        failedPath(id, at);
      });
      If(u.element(at.add(S.UTYPE)).notEqual(movementType('APC')).or(u.element(at.add(S.UDOOR)).equal(0)).and(goal.greaterThanEqual(int(0))).and(cell.greaterThanEqual(int(0))).and(u.element(at.add(int(S.UDEST))).lessThan(int(0)))
        .and(proposal.element(p.add(int(P_ROTATED))).equal(int(0))).and(u.element(at.add(int(S.UWAIT))).equal(int(0)))
        .and(infantry.equal(int(0)).or(proposal.element(p.add(int(P_WAS_DRIVING))).equal(int(0)))), () => {
        const from = point(u.element(at.add(int(S.UCELL))));
        const dir = direction8(from, point(cell)).toVar();
        track.assign(dir.mul(int(9)));
        If(infantry.equal(int(0)).and(u.element(at.add(int(S.UFACE))).notEqual(dir.mul(int(32)))), () => {
          u.element(at.add(int(S.UDESIRED))).assign(dir.mul(int(32)));
          u.element(at.add(int(S.UACCUM))).assign(0);
          ok.assign(0);
        });
        If(ok.notEqual(int(0)), () => {
          slot.assign(free(cell, id));
          If(slot.lessThan(int(0)), () => {
            recordObstruction(id,at,cell);
            const moving = int(0).toVar();
            const headOn = int(0).toVar();
            Loop(5, ({ i: s }) => {
              const blocker = int(atomicLoad(occupancy.element(cell.mul(int(5)).add(s)))).sub(int(1));
              If(blocker.greaterThanEqual(int(0)).and(blocker.notEqual(id)), () => {
                If(u.element(blocker.mul(int(S.WORDS)).add(int(S.UDEST))).greaterThanEqual(int(0))
                  .or(proposal.element(blocker.mul(int(PROPOSAL_WORDS)).add(int(P_GOAL))).greaterThanEqual(int(0))), () => {
                  moving.assign(1);
                });
                const other = blocker.mul(int(S.WORDS));
                const face = u.element(at.add(int(S.UFACE))).add(int(16)).bitAnd(int(255)).shiftRight(int(5));
                const otherFace = u.element(other.add(int(S.UFACE))).add(int(16)).bitAnd(int(255)).shiftRight(int(5)).bitXor(int(4));
                If(u.element(other.add(int(S.UOWNER))).equal(u.element(at.add(int(S.UOWNER))))
                  .and(proposal.element(blocker.mul(int(PROPOSAL_WORDS)).add(int(P_GOAL))).greaterThanEqual(int(0)))
                  .and(face.equal(otherFace)).and(unitDistance(position(at), position(other)).lessThanEqual(int(0x1ff))), () => {
                  headOn.assign(1);
                });
              });
            });
            If(moving.notEqual(int(0)).and(headOn.equal(int(0)))
              .and(unitDistance(position(at), point(goal)).greaterThanEqual(int(512))), () => {
              // Do not let a cycle of waiting allies pin the shared flow route forever.
              const stalled = u.element(at.add(int(S.USTALLED)));
              stalled.assign(intMin(int(PATH_DELAY), stalled.add(int(1))));
            });
            If(unitDistance(position(at), point(goal)).lessThan(int(512)), () => {
              goals.element(id).assign(-1);
              ok.assign(0);
            })
              .ElseIf(moving.notEqual(int(0)).and(headOn.equal(int(0)))
                .and(u.element(at.add(int(S.USTALLED))).lessThan(int(PATH_DELAY))), () => {
              ok.assign(0);
            }).ElseIf(moving.equal(int(0)).and(headOn.equal(int(0))), () => {
              // DRIVE.CPP, Start_Of_Move: MOVE_TEMP scatters stationary allies.
              Loop(5, ({ i: s }) => {
                const blocker = int(atomicLoad(occupancy.element(cell.mul(int(5)).add(s)))).sub(int(1));
                If(blocker.greaterThanEqual(int(0)).and(blocker.notEqual(id)), () => {
                  If(u.element(blocker.mul(int(S.WORDS)).add(int(S.UOWNER))).equal(u.element(at.add(int(S.UOWNER)))), () => {
                    atomicOr(nudges.element(blocker), uint(1));
                  });
                });
              });
              u.element(at.add(int(S.UROUTE))).assign(-1);
              failedPath(id, at);
              ok.assign(0);
            }).Else(() => {
              const alternative = int(-1).toVar();
              const best = int(0x7fffffff).toVar();
              const current = u.element(at.add(int(S.UCELL)));
              for (let d = 0; d < 8; d++)
                If(data.element(current.add(int(edgeBase))).bitAnd(int(1 << d)).notEqual(int(0)), () => {
                  const other = current.add(int(DIRECTIONS[d][1] * setup.grid.width + DIRECTIONS[d][0]));
                  const cost = proposal.element(p.add(int(P_COST + d)));
                  If(free(other, id).greaterThanEqual(int(0)).and(cost.lessThan(best)), () => {
                    best.assign(cost);
                    alternative.assign(other);
                  });
                });
              If(alternative.lessThan(int(0)), () => {
                ok.assign(0);
                u.element(at.add(int(S.UROUTE))).assign(-1);
                If(headOn.notEqual(int(0)), () => { failedPath(id, at); })
                  .Else(() => { u.element(at.add(int(S.UWAIT))).assign(PATH_DELAY); });
              }).Else(() => {
                cell.assign(alternative);
                slot.assign(free(cell, id));
                dir.assign(direction8(from, point(cell)));
                track.assign(dir.mul(int(9)));
                u.element(at.add(int(S.UROUTE))).assign(cell);
                If(infantry.equal(int(0)).and(u.element(at.add(int(S.UFACE))).notEqual(dir.mul(int(32)))), () => {
                  u.element(at.add(int(S.UDESIRED))).assign(dir.mul(int(32)));
                  ok.assign(0);
                });
              });
            });
          }).ElseIf(infantry.equal(int(0)), () => {
            const following = proposal.element(p.add(int(P_FOLLOWING)));
            If(following.greaterThanEqual(int(0)), () => {
              const candidate = dir.mul(int(8)).add(direction8(point(cell), point(following)));
              const tc = candidate.mul(int(TRACK_WORDS)).add(int(trackBase));
              If(data.element(tc.add(int(TRACK_RAW))).greaterThanEqual(int(0))
                .and(data.element(tc.add(int(TRACK_FLAGS))).bitAnd(int(8)).notEqual(int(0))), () => {
                If(free(following, id).greaterThanEqual(int(0)), () => {
                  middle.assign(cell);
                  cell.assign(following);
                  track.assign(candidate);
                });
              });
            });
          });
        });
        If(ok.notEqual(int(0)), () => {
          proposal.element(p.add(int(P_CELL))).assign(cell);
          proposal.element(p.add(int(P_MIDDLE))).assign(middle);
          proposal.element(p.add(int(P_SLOT))).assign(slot);
          proposal.element(p.add(int(P_TRACK))).assign(track);
          If(infantry.equal(int(0)), () => {
            for (const c of [cell, middle])
              If(c.greaterThanEqual(int(0)), () => {
                Loop(5, ({ i: s }) => {
                  atomicMin(claims.element(c.mul(int(5)).add(s)), uint(id));
                });
              });
          });
        });
      });
    });
    const prepareInfantry = kernel(count, () => {
      const id = int(instanceIndex), at = id.mul(int(S.WORDS)), p = id.mul(int(PROPOSAL_WORDS));
      const cell = proposal.element(p.add(int(P_CELL))).toVar();
      If(cell.greaterThanEqual(int(0)).and(u.element(at.add(int(S.UKIND))).notEqual(int(0))), () => {
        const backed = entryPoint(cell, at).toVar();
        proposal.element(p.add(int(P_APPROACH))).assign(cell);
        proposal.element(p.add(int(P_CELL))).assign(backed.y.div(int(256)).mul(int(setup.grid.width)).add(backed.x.div(int(256))));
        proposal.element(p.add(int(P_SLOT))).assign(-1);
      });
    });
    const linkInfantry = (departures: boolean) => kernel(count, () => {
      const id = int(instanceIndex);
      const cell = proposal.element(id.mul(int(PROPOSAL_WORDS)));
      const include = departures ? cell.notEqual(u.element(id.mul(int(S.WORDS)).add(int(S.UCELL)))) : int(1).equal(int(1));
      If(cell.greaterThanEqual(int(0)).and(u.element(id.mul(int(S.WORDS)).add(int(S.UKIND))).notEqual(int(0))).and(include), () => {
        links.element(id).assign(exchangeHead({ head: heads.element(cell), value: uint(id) }) as Node<'uint'>);
      });
    });
    // Choose infantry in ascending ID order within each destination cell. The linked-list
    // insertion order may vary; the minimum search makes reservation results deterministic.
    const allocateInfantry = kernel(cells, () => {
      const cell = int(instanceIndex);
      const last = int(-1).toVar();
      Loop(5, () => {
        const chosen = int(0x7fffffff).toVar();
        const cursor = atomicLoad(heads.element(cell)).toVar();
        Loop(() => {
          If(cursor.equal(uint(0xffffffff)), () => {
            Break();
          });
          const id = int(cursor);
          If(id.greaterThan(last).and(id.lessThan(chosen)), () => {
            chosen.assign(id);
          });
          cursor.assign(links.element(cursor));
        });
        If(chosen.equal(int(0x7fffffff)), () => {
          Break();
        });
        last.assign(chosen);
        const slot = free(proposal.element(chosen.mul(int(PROPOSAL_WORDS)).add(int(P_APPROACH))), chosen, true, cell);
        proposal.element(chosen.mul(int(PROPOSAL_WORDS)).add(int(P_SLOT))).assign(slot);
        If(slot.greaterThanEqual(int(0)), () => {
          atomicStore(claims.element(cell.mul(int(5)).add(slot)), uint(chosen));
        });
      });
    });
    // Ported from DRIVE.CPP, Start_Of_Move/While_Moving, and INFANTRY.CPP, Start_Driver.
    const accept = kernel(count, () => {
      const id = int(instanceIndex);
      const at = id.mul(int(S.WORDS)).toVar();
      const p = id.mul(int(PROPOSAL_WORDS)).toVar();
      const cell = proposal.element(p.add(int(P_CELL)));
      const middle = proposal.element(p.add(int(P_MIDDLE)));
      const slot = proposal.element(p.add(int(P_SLOT)));
      If(cell.greaterThanEqual(int(0)).and(slot.greaterThanEqual(int(0))), () => {
        const won = int(1).toVar();
        const infantry = u.element(at.add(int(S.UKIND)));
        for (const c of [cell, middle])
          If(c.greaterThanEqual(int(0)), () => {
            Loop(5, ({ i: s }) => {
              If(infantry.equal(int(0)).or(slot.equal(int(s))), () => {
                If(atomicLoad(claims.element(c.mul(int(5)).add(s))).notEqual(uint(id)), () => {
                  won.assign(0);
                });
              });
            });
          });
        If(won.notEqual(int(0)), () => {
          invalidateOccupancy();
          If(u.element(at.add(int(S.UJUMP))).greaterThanEqual(int(0)), () => {
            u.element(at.add(int(S.UMIDDLE))).assign(u.element(at.add(int(S.UDEST))));
            u.element(at.add(int(S.UDEST))).assign(cell);
            const track = proposal.element(p.add(int(P_TRACK)));
            u.element(at.add(int(S.UTRACK))).assign(track);
            u.element(at.add(int(S.UCELL))).assign(u.element(at.add(int(1))).div(int(256)).mul(int(setup.grid.width)).add(u.element(at).div(int(256))));
            u.element(at.add(int(S.UTRACK_STEP))).assign(data.element(track.mul(int(TRACK_WORDS)).add(int(trackBase + TRACK_ENTRY))));
            const target = point(cell);
            u.element(at.add(int(S.UHEAD_X))).assign(target.x);
            u.element(at.add(int(S.UHEAD_Y))).assign(target.y);
          }).Else(() => {
            const approach = proposal.element(p.add(int(P_APPROACH)));
            u.element(at.add(int(S.UROUTE))).assign(select(infantry.notEqual(int(0)).and(cell.notEqual(approach)), approach, int(-1)));
            u.element(at.add(int(S.URETRIES))).assign(10);
            u.element(at.add(int(S.USTALLED))).assign(0);
            u.element(at.add(int(S.UDEST))).assign(cell);
            u.element(at.add(int(S.UMIDDLE))).assign(middle);
            u.element(at.add(int(S.UDSLOT))).assign(slot);
            u.element(at.add(int(S.UTRACK))).assign(proposal.element(p.add(int(P_TRACK))));
            u.element(at.add(int(S.UTRACK_STEP))).assign(0);
            const head = point(cell, slot);
            u.element(at.add(int(S.UHEAD_X))).assign(head.x);
            u.element(at.add(int(S.UHEAD_Y))).assign(head.y);
            If(u.element(at.add(int(S.USTARTED))).equal(int(0)), () => {
              u.element(at.add(int(S.USTARTED))).assign(control.element(0));
            });
            If(infantry.notEqual(int(0)), () => {
              const facing = direction8(position(at), head).mul(int(32));
              u.element(at.add(int(S.UFACE))).assign(facing);
              u.element(at.add(int(S.UDESIRED))).assign(facing);
              u.element(at.add(int(S.UWALK))).assign(0);
            }).Else(() => {
              const land = data.element(select(middle.lessThan(int(0)), cell, middle).add(int(landBase)));
              const speed = data.element(land.mul(int(7)).add(type(at, TYPE_LOCOMOTION)).add(int(groundBase))).toVar();
              If(u.element(at.add(int(S.UHEALTH))).lessThan(type(at, TYPE_STRENGTH).shiftRight(int(1))), () => {
                speed.subAssign(speed.shiftRight(int(2)));
              });
              u.element(at.add(int(S.USPEED))).assign(speed);
              advance(id);
            });
          });
          proposal.element(p.add(int(P_CELL))).assign(-1);
        });
      });
    });
    const resumeJump = kernel(count, () => {
      const id = int(instanceIndex);
      const at = id.mul(int(S.WORDS));
      If(u.element(at.add(int(S.UJUMP))).greaterThanEqual(int(0)), () => {
        invalidateOccupancy();
        // The current tick's speed was already accumulated before the reservation pass.
        u.element(at.add(int(S.UJUMP))).assign(-1);
        advance(id, false);
        u.element(at.add(int(S.UJUMP_TRACK))).assign(-1);
      });
    });
    const blockedInfantry = kernel(count, () => {
      const id = int(instanceIndex), at = id.mul(int(S.WORDS)), p = id.mul(int(PROPOSAL_WORDS));
      const cell = proposal.element(p.add(int(P_CELL))), approach = proposal.element(p.add(int(P_APPROACH)));
      If(cell.greaterThanEqual(int(0)).and(u.element(at.add(int(S.UKIND))).notEqual(int(0))), () => {
        const moving = int(0).toVar();
        for (const target of [cell, approach]) Loop(5, ({ i: slot }) => {
          const owner = int(atomicLoad(occupancy.element(target.mul(int(5)).add(slot)))).sub(int(1));
          If(owner.greaterThanEqual(int(0)).and(owner.notEqual(id)), () => {
            If(proposal.element(owner.mul(int(PROPOSAL_WORDS)).add(int(P_GOAL))).greaterThanEqual(int(0)), () => {
              moving.assign(1);
            }).ElseIf(u.element(owner.mul(int(S.WORDS)).add(int(S.UOWNER))).equal(u.element(at.add(int(S.UOWNER)))), () => {
              atomicOr(nudges.element(owner), uint(1));
            });
          });
        });
        If(moving.notEqual(int(0)).and(unitDistance(position(at), point(goals.element(id))).greaterThanEqual(int(0x280))), () => {
          u.element(at.add(int(S.UWAIT))).assign(PATH_DELAY);
        }).Else(() => { failedPath(id, at); });
      });
    });
    const yieldSpace = kernel(count, () => {
      const id = int(instanceIndex);
      const flags=atomicLoad(nudges.element(id)),at=id.mul(S.WORDS);
      If(flags.bitAnd(uint(2)).notEqual(uint(0)).and(u.element(at.add(S.UHEALTH)).greaterThan(int(0))).and(u.element(at.add(S.UCLOAK)).equal(int(2))),()=>{
        u.element(at.add(S.UCLOAK)).assign(1);u.element(at.add(S.UCLOAK_STAGE)).assign(19);
      });
      If(flags.bitAnd(uint(1)).notEqual(uint(0)).and(goals.element(id).lessThan(int(0))), () => {
        scatter(id);
      });
    });
    this.command = kernel(count, () => {
      const id = int(instanceIndex);
      const at = id.mul(int(S.WORDS)).toVar();
      If(ids.element(id).notEqual(int(0)), () => {
        u.element(at.add(S.UOBSTRUCTION)).assign(0);
        If(this.commandKind.equal(int(2)), () => {
          scatter(id);
        }).Else(() => {
          u.element(at.add(S.USCATTER_GOAL)).assign(0);
          goals.element(id).assign(select(this.commandKind.equal(int(1)), int(-1), this.target));
          pathGoals.element(id).assign(-1);
          u.element(at.add(int(S.USTALLED))).assign(0);
          u.element(at.add(int(S.UWAIT))).assign(0);
          u.element(at.add(int(S.URETRIES))).assign(10);
          u.element(at.add(int(S.UROUTE))).assign(-1);
          u.element(at.add(int(S.USTARTED))).assign(0);
          u.element(at.add(int(S.UROTATED))).assign(0);
        });
      });
    });
    this.applyPending = kernel(count, () => {
      const id = int(instanceIndex);
      const at = id.mul(int(S.WORDS)).toVar();
      const p = id.mul(int(2));
      const kind = pending.element(p);
      If(kind.greaterThanEqual(int(0)).and(kind.lessThan(3)).and(u.element(at.add(S.UHEALTH)).greaterThan(0)), () => {
        u.element(at.add(S.UOBSTRUCTION)).assign(0);
        If(kind.equal(int(2)), () => {
          scatter(id);
        }).Else(() => {
          u.element(at.add(S.USCATTER_GOAL)).assign(0);
          goals.element(id).assign(select(kind.equal(int(1)), int(-1), pending.element(p.add(int(1)))));
          pathGoals.element(id).assign(-1);
          u.element(at.add(int(S.USTALLED))).assign(0);
          u.element(at.add(int(S.UWAIT))).assign(0);
          u.element(at.add(int(S.URETRIES))).assign(10);
          u.element(at.add(int(S.UROUTE))).assign(-1);
          u.element(at.add(int(S.USTARTED))).assign(0);
          u.element(at.add(int(S.UROTATED))).assign(0);
        });
        pending.element(p).assign(-1);
      });
    });
    // Start inter-cell moves first, then reserve short infantry steps in the
    // vacated source slots. This preserves same-tick starts without overlapping reservations.
    this.prepare = this.flow.prepareKernels.length ? [this.resolvePaths,...this.flow.prepareKernels] : [];
    this.tick = [...(this.prepare.length ? [] : [this.resolvePaths]), ...this.flow.kernels, begin, query, motion, clear, ...occupy, finishOccupancy,
      snapshotGoals, proposalQuery, propose, prepareInfantry,
      clearHeads, linkInfantry(true), allocateInfantry, accept, clear, ...occupy, finishOccupancy,
      clearHeads, linkInfantry(false), allocateInfantry, accept, blockedInfantry, resumeJump, clearOccupancy, ...occupy, finishOccupancy, yieldSpace, this.applyPending];
    this.occupancyPasses = [clearOccupancy, ...occupy, finishOccupancy];
    this.batch = Array.from({length:32},()=>this.tick).flat();
    if (this.prepare.length) renderer.compute(this.prepare);
    renderer.compute([...this.tick, this.command, kernel(1, () => control.element(0).assign(0))]);
    this.digest = new GpuChecksum(renderer, this.buffers());
  }
  /** Compile every movement/command path without changing the simulation clock. */
  async prepareForPlay() {
    await this.relations?.prepareForPlay();
    await this.edits?.prepareForPlay();
    await this.renderer.compileComputeAsync(this.kernels);
  }
  step(commands: readonly S.UnitCommand[] = []) {
    if (this.unitsVersion !== this.units.version) this.refreshOccupancy();
    if (this.prepare.length) this.renderer.compute(this.prepare);
    this.renderer.compute(this.tick);
    this.frame++;
    this.applyCommands(commands);
  }
  applyCommands(commands: readonly S.UnitCommand[]) {
    for (const command of commands) {
      if (command.frame !== this.frame)
        throw new Error('Commands must be submitted on their recorded tick');
      {
        const ids = this.ids.array as Int32Array;
        ids.fill(0);
        for (const id of command.ids)
          ids[id] = 1;
        this.ids.needsUpdate = true;
      }
      this.commandKind.value = command.kind === 'stop' ? 1 : command.kind === 'scatter' ? 2 : 0;
      this.target.value = command.target ?? -1;
      this.renderer.compute(this.command);
    }
  }
  /** Advance command-free ticks in bounded submissions, preserving every compute pass. */
  stepMany(ticks: number, extension?: UnitTickExtension) {
    if (this.unitsVersion !== this.units.version) this.refreshOccupancy();
    // Indirect dispatch arguments must be written in a separate compute pass.
    if (this.prepare.length) {
      for (let tick = 0; tick < ticks; tick++) {
        if (extension) this.renderer.compute(extension.before);
        this.step();
        if (extension) {
          this.renderer.compute(extension.after);
          if (extension.refreshOccupancy) this.refreshOccupancy();
        }
      }
      return;
    }
    let step = this.tick, batch = this.batch;
    if (extension) {
      let cached = this.extendedBatches.get(extension);
      if (!cached) {
        const step = [...extension.before, ...this.tick, ...extension.after,
          ...(extension.refreshOccupancy ? this.occupancyPasses : [])];
        cached = {step, batch:Array.from({length:32}, () => step).flat()};
        this.extendedBatches.set(extension, cached);
      }
      ({step, batch} = cached);
    }
    while (ticks > 0) {
      const count = Math.min(ticks, 32);
      this.renderer.compute(count === 32 ? batch : count === 1 ? step : batch.slice(0, count * step.length));
      this.frame += count;
      ticks -= count;
    }
  }
  /** Explicit external state edits invalidate the cache; tick passes mark their own changes. */
  refreshOccupancy() {
    if(this.editingOccupancy){this.edits!.refresh();this.unitsVersion=this.units.version;return;}
    this.renderer.compute([this.invalidateOccupancy, ...this.occupancyPasses]);
    this.unitsVersion = this.units.version;
  }
  useTiberium(amount:StorageBufferAttribute,terrain:Uint8Array){
    const base=new StorageBufferAttribute(Int32Array.from(terrain),1);this.attributes.push(base);
    const ore=storage(amount,'int',amount.count).toReadOnly(),land=storage(base,'int',base.count).toReadOnly(),map=storage(this.mapData,'int',this.mapData.count);
    const kernel=Fn(()=>{const cell=int(instanceIndex);map.element(cell.add(this.mapOffsets.land)).assign(select(ore.element(cell).greaterThanEqual(0),int(5),land.element(cell)));})().compute(terrain.length);
    this.kernels.push(kernel);this.prepare.unshift(kernel);
  }
  updateMap(edges:Uint32Array,passable:Uint8Array,land:Uint8Array=this.setup.land) {
    this.setup.grid.edges.set(edges);this.setup.passable?.set(passable);this.setup.land.set(land);
    const data=this.mapData.array as Int32Array;
    data.set(edges,this.mapOffsets.edges);data.set(passable,this.mapOffsets.open);data.set(land,this.mapOffsets.land);
    this.mapData.needsUpdate=true;
    this.flow.updateEdges(edges);
    for(const changed of this.mapObservers)changed(edges,passable,land);
    (this.pathGoals.array as Int32Array).fill(-1);this.pathGoals.needsUpdate=true;
    this.refreshOccupancy();
  }
  buffers() {
    return [this.control, this.units, this.goals, this.occupancy, ...this.flow.buffers(), this.pathGoals];
  }
  checksum() {
    return this.digest.read();
  }
  async snapshot() {
    return Promise.all(this.buffers().map(async (b) => new Int32Array(await this.renderer.getArrayBufferAsync(b))));
  }
  dispose() {
    this.relations?.dispose();this.edits?.dispose();
    this.digest.dispose();
    this.flow.dispose();
    for (const k of this.kernels)
      k.dispose();
    releaseStorage(this.renderer, this.attributes);
  }
}
