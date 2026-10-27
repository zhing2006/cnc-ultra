// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, Vector4, type WebGPURenderer, type Node, type ComputeNode } from 'three/webgpu';
import { Fn, If, int, uint, ivec2, storage, uniform, uniformArray, select, instanceIndex, atomicMin, atomicMax, atomicAdd, atomicStore, atomicLoad } from 'three/tsl';
import { intMin, intMax } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { movementType,MOVEMENT } from '../data/movement.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { EXTRA_ACTORS } from '../data/extra-actors.ts';
import { unitDistance } from './units-nodes.ts';
import { WORDS, UOWNER, UTYPE, UHEALTH, UALTITUDE, UATTACHED,UDOMAIN,UKIND,UORIGIN,UCLOAK,UFLAGS,PLAYER_ORDER } from './units-state.ts';
import type { GpuUnits } from './units-gpu.ts';
import type { GpuSight } from './sight.ts';
import { SightView } from './sight-view.ts';
import { cellEntryNode } from './cell-entry.ts';
export type SelectionAction = 'point' | 'box' | 'clear' | 'group' | 'next' | 'home' | 'center' | 'stop' | 'scatter';
const ACTIONS: SelectionAction[] = ['point', 'box', 'clear', 'group', 'next', 'home', 'center', 'stop', 'scatter'];
export interface SelectionCommand {
  action: SelectionAction;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  modifier?: number;
  group?: number;
}
/** Selection stays on the GPU. The small result describes its spokesperson and camera bounds. */
export class GpuSelection {
  get saveBuffers() { return this.attributes; }
  readonly result: StorageBufferAttribute;
  readonly state: StorageBufferAttribute;
  readonly flashOffset: number;
  readonly owner = uniform(0, 'int');
  private readonly parallel: ComputeNode[];
  private readonly args = uniform(0, 'int');
  private readonly x = uniform(0, 'int');
  private readonly y = uniform(0, 'int');
  private readonly x2 = uniform(0, 'int');
  private readonly y2 = uniform(0, 'int');
  private readonly modifier = uniform(0, 'int');
  private readonly group = uniform(0, 'int');
  private readonly attributes: StorageBufferAttribute[] = [];
  constructor(private readonly renderer: WebGPURenderer, private readonly simulation: GpuUnits, private readonly sight: GpuSight | SightView, combat = false) {
    const count = simulation.setup.units.length;
    const { width, height } = simulation.setup.grid;
    this.result = new StorageBufferAttribute(new Int32Array(8), 1);
    this.attributes.push(this.result);
    const initial = new Int32Array(count * 2 + 4);
    initial.fill(-1, count, count * 2);
    initial[count * 2 + 2] = -1;
    this.state = new StorageBufferAttribute(initial, 1);
    this.flashOffset = count * 2;
    this.attributes.push(this.state);
    const local = storage(this.state, 'int', initial.length);
    const selected = { element: (i: import('three/webgpu').Node<'int'> | number) => local.element(i) };
    const groups = { element: (i: Node<'int'>) => local.element(i.add(int(count))) };
    const flash = { element: (i: number) => local.element(count * 2 + i) };
    const clock = storage(simulation.control, 'int', 2).toReadOnly();
    const result = storage(this.result, 'int', 8);
    const u = storage(simulation.units, 'int', simulation.units.count);
    const pending = storage(simulation.pending, 'int', count * 2);
    // EVENT.CPP MEGAMISSION: mark while writing orders, without another actor scan.
    const playerOrder=(id:Node<'int'>)=>{const at=id.mul(WORDS);If(u.element(at.add(UDOMAIN)).equal(int(0)),()=>{u.element(at.add(UFLAGS)).bitOrAssign(PLAYER_ORDER);});};
    const shadow = sight instanceof SightView ? { element: sight.shadowAt } : storage(sight.shadow, 'int', width * height).toReadOnly();
    const canEnter = cellEntryNode(simulation, attribute => this.attributes.push(attribute), u);
    const footprints=uniformArray<'ivec4'>(MOVEMENT.map(t=>{const b=BUILDINGS.get(t.name);return new Vector4(b?.width??0,b?.height??0,b?.occupy.reduce((mask,[x,y])=>mask|(1<<(y*4+x)),0)??0,Number(EXTRA_ACTORS.find(e=>e.name===t.name)?.selectable??true));}), 'ivec4');
    // MAP.CPP Close_Object, DISPLAY.CPP Select_These and CONQUER.CPP Handle_Team.
    // Reduce dependent choices first; every selection/order write then owns one actor.
    const workAttribute = new StorageBufferAttribute(new Uint32Array(4), 1);
    const decisionAttribute = new StorageBufferAttribute(new Int32Array(5), 1);
    this.attributes.push(workAttribute, decisionAttribute);
    const work = storage(workAttribute, 'uint', 4).toAtomic(), readWork = { element:(i:number)=>atomicLoad(work.element(i)) };
    // chosen, selection operation (replace/toggle), order kind, order target, group replace
    const decision = storage(decisionAttribute, 'int', 5), totals = storage(this.result, 'int', 8).toAtomic();
    const cell = this.y.div(256).mul(width).add(this.x.div(256));
    const inside = this.x.greaterThanEqual(int(0)).and(this.y.greaterThanEqual(int(0))).and(this.x.lessThan(width*256)).and(this.y.lessThan(height*256));
    const reset = Fn(() => {
      for (const [i,value] of [count,0,0,0x7fffffff,0x7fffffff,0,0,0].entries()) result.element(i).assign(value);
      for (const [i,value] of [count,0xffffffff,count,0].entries()) atomicStore(work.element(i),uint(value));
      for (const [i,value] of [-1,0,-1,-1,0].entries()) decision.element(i).assign(value);
    })().compute(1);
    const collect = Fn(() => {
      const id=int(instanceIndex).toVar(),at=id.mul(WORDS).toVar(),owner=u.element(at.add(UOWNER));
      const alive=u.element(at.add(UHEALTH)).greaterThan(int(0)).and(u.element(at.add(UATTACHED)).equal(int(0)));
      const visible=u.element(at.add(UCLOAK)).notEqual(int(2)).or(owner.equal(this.owner));
      If(alive.not().or(visible.not()),()=>{selected.element(id).assign(0);});
      If(selected.element(id).notEqual(int(0)).and(owner.equal(this.owner)),()=>{atomicMin(work.element(0),uint(id));});
      If(this.args.equal(int(0)).and(inside).and(alive).and(visible).and(footprints.element(u.element(at.add(UTYPE))).w.notEqual(int(0))),()=>{
        If(shadow.element(cell).notEqual(int(-2)),()=>{
          const d=unitDistance(ivec2(this.x,this.y),ivec2(u.element(at),u.element(at.add(1)).sub(u.element(at.add(UALTITUDE)).mul(256).add(12).div(24)))).toVar();
          If(u.element(at.add(UDOMAIN)).equal(int(2)),()=>{
            const shape=footprints.element(u.element(at.add(UTYPE))),origin=u.element(at.add(UORIGIN));
            const dx=cell.mod(width).sub(origin.mod(width)),dy=cell.div(width).sub(origin.div(width));
            If(dx.greaterThanEqual(int(0)).and(dy.greaterThanEqual(int(0))).and(dx.lessThan(shape.x)).and(dy.lessThan(shape.y))
              .and(shape.z.bitAnd(int(1).shiftLeft(dy.mul(4).add(dx))).notEqual(int(0))),()=>{d.assign(0);});
          });
          If(d.lessThan(int(182)),()=>{atomicMin(work.element(1),uint(d).shiftLeft(uint(24)).bitOr(uint(id)));});
        });
      });
    })().compute(count);
    const auxiliary = Fn(() => {
      const id=int(instanceIndex).toVar(),at=id.mul(WORDS).toVar(),first=select(readWork.element(0).equal(uint(count)),int(-1),int(readWork.element(0)));
      If(this.args.equal(int(0)).and(readWork.element(1).notEqual(uint(0xffffffff))),()=>{
        const chosen=int(readWork.element(1).bitAnd(uint(0xffffff)));
        If(u.element(at.add(UHEALTH)).greaterThan(int(0)).and(u.element(at.add(UATTACHED)).equal(chosen.add(1))),()=>{atomicAdd(work.element(3),uint(1));});
      });
      If(this.args.equal(int(4)).or(this.args.equal(int(5))),()=>{
        If(u.element(at.add(UOWNER)).equal(this.owner).and(u.element(at.add(UHEALTH)).greaterThan(int(0))).and(u.element(at.add(UATTACHED)).equal(int(0)))
          .and(footprints.element(u.element(at.add(UTYPE))).w.notEqual(int(0))),()=>{
          If(this.args.equal(int(4)).or(u.element(at.add(UTYPE)).equal(int(movementType('MCV')))),()=>{
            const rank=select(this.args.equal(int(5)),id,select(this.modifier.notEqual(int(0)),first.sub(id).sub(1).add(count*2).mod(count),id.sub(first).sub(1).add(count*2).mod(count)));
            atomicMin(work.element(2),uint(rank));
          });
        });
      });
    })().compute(count);
    const decide = Fn(() => {
      const first=select(readWork.element(0).equal(uint(count)),int(-1),int(readWork.element(0))).toVar();
      const chosen=int(-1).toVar(),voice=int(0).toVar(),center=int(0).toVar();
      If(this.args.equal(int(0)).and(inside),()=>{
        If(readWork.element(1).notEqual(uint(0xffffffff)),()=>{chosen.assign(int(readWork.element(1).bitAnd(uint(0xffffff))));});
        If(chosen.greaterThanEqual(int(0)),()=>{
          const owner=u.element(chosen.mul(WORDS).add(UOWNER)),kind=u.element(chosen.mul(WORDS).add(UTYPE)),at=first.mul(WORDS);
          If(int(Number(combat)).notEqual(int(0)).and(first.greaterThanEqual(int(0))).and(owner.notEqual(this.owner).or(this.modifier.equal(int(2)))),()=>{
            decision.element(2).assign(3);decision.element(3).assign(chosen);voice.assign(3);
          }).ElseIf(first.greaterThanEqual(int(0)).and(this.modifier.equal(int(0))).and(owner.equal(this.owner)),()=>{
            const passengers=int(readWork.element(3));
            const boarding=kind.equal(int(movementType('TRAN'))).or(kind.equal(int(movementType('APC')))).and(passengers.lessThan(int(5))).and(u.element(at.add(UKIND)).notEqual(int(0)));
            const docking=kind.equal(int(movementType('HPAD'))).and(u.element(at.add(UDOMAIN)).equal(int(1)))
              .or(kind.equal(int(movementType('FIX'))).and(u.element(at.add(UKIND)).equal(int(0))).and(u.element(at.add(UDOMAIN)).notEqual(int(2))))
              .or(kind.equal(int(movementType('PROC'))).and(u.element(at.add(UTYPE)).equal(int(movementType('HARV')))));
            If(boarding.or(docking),()=>{decision.element(2).assign(5);decision.element(3).assign(chosen);voice.assign(2);})
              .ElseIf(chosen.equal(first).and(kind.equal(int(movementType('TRAN'))).or(kind.equal(int(movementType('APC'))))).and(passengers.greaterThan(int(0))),()=>{decision.element(2).assign(6);voice.assign(2);})
              .ElseIf(chosen.equal(first).and(kind.equal(int(movementType('MCV')))),()=>{voice.assign(4);})
              .ElseIf(chosen.equal(first).and(u.element(at.add(UDOMAIN)).equal(int(2))),()=>{voice.assign(5);})
              .ElseIf(selected.element(chosen).equal(int(0)),()=>{decision.element(1).assign(1);voice.assign(1);});
          }).Else(()=>{
            If(this.modifier.notEqual(int(0)).and(first.greaterThanEqual(int(0))),()=>{decision.element(1).assign(2);voice.assign(int(selected.element(chosen).equal(int(0))));})
              .ElseIf(selected.element(chosen).equal(int(0)),()=>{decision.element(1).assign(1);voice.assign(1);});
          });
        }).ElseIf(first.greaterThanEqual(int(0)),()=>{
          decision.element(2).assign(select(int(Number(combat)).notEqual(int(0)).and(this.modifier.equal(int(2))),int(4),int(0)));
          decision.element(3).assign(cell);voice.assign(select(int(Number(combat)).notEqual(int(0)).and(this.modifier.equal(int(2))),int(3),int(2)));
          If(this.modifier.notEqual(int(0)).or(canEnter(first,cell)),()=>{flash.element(0).assign(this.x);flash.element(1).assign(this.y);flash.element(2).assign(clock.element(0));flash.element(3).addAssign(1);});
        });
      });
      If(this.args.equal(int(1)),()=>{voice.assign(1);});
      If(this.args.equal(int(3)).and(this.modifier.notEqual(int(2))),()=>{
        If(first.greaterThanEqual(int(0)),()=>{decision.element(4).assign(int(this.modifier.notEqual(int(1)).and(groups.element(first).notEqual(this.group))));});
        voice.assign(1);center.assign(int(this.modifier.equal(int(3))));
      });
      If(this.args.equal(int(4)).or(this.args.equal(int(5))),()=>{
        const rank=int(readWork.element(2));
        If(rank.lessThan(int(count)),()=>{
          chosen.assign(select(this.args.equal(int(5)),rank,select(this.modifier.notEqual(int(0)),first.sub(rank).sub(1).add(count*2).mod(count),first.add(rank).add(1).mod(count))));
          decision.element(1).assign(1);voice.assign(1);center.assign(1);
        });
      });
      If(this.args.equal(int(6)),()=>{center.assign(1);});
      If(this.args.equal(int(7)).or(this.args.equal(int(8))),()=>{decision.element(2).assign(this.args.sub(6));});
      decision.element(0).assign(chosen);result.element(2).assign(voice);result.element(7).assign(center);
    })().compute(1);
    // Keep the actor offset outside command branches; TSL caches shared expressions.
    const apply = Fn(() => {
      const id=int(instanceIndex).toVar(),at=id.mul(WORDS).toVar(),owner=u.element(at.add(UOWNER)),chosen=decision.element(0),operation=decision.element(1),order=decision.element(2);
      If(operation.equal(int(1)),()=>{selected.element(id).assign(int(id.equal(chosen)));})
        .ElseIf(operation.equal(int(2)).and(id.equal(chosen)),()=>{selected.element(id).assign(int(selected.element(id).equal(int(0))));});
      If(this.args.equal(int(1)),()=>{
        selected.element(id).assign(int(u.element(at.add(UHEALTH)).greaterThan(int(0)).and(u.element(at.add(UATTACHED)).equal(int(0)))
          .and(u.element(at.add(UDOMAIN)).notEqual(int(2))).and(footprints.element(u.element(at.add(UTYPE))).w.notEqual(int(0))).and(owner.equal(this.owner))
          .and(u.element(at).greaterThanEqual(intMin(this.x,this.x2))).and(u.element(at).lessThanEqual(intMax(this.x,this.x2)))
          .and(u.element(at.add(1)).greaterThanEqual(intMin(this.y,this.y2))).and(u.element(at.add(1)).lessThanEqual(intMax(this.y,this.y2)))));
      }).ElseIf(this.args.equal(int(2)),()=>{selected.element(id).assign(0);});
      If(this.args.equal(int(3)),()=>{
        If(this.modifier.equal(int(2)),()=>{
          If(owner.equal(this.owner),()=>{If(groups.element(id).equal(this.group),()=>{groups.element(id).assign(-1);});If(selected.element(id).notEqual(int(0)),()=>{groups.element(id).assign(this.group);});});
        }).Else(()=>{
          If(decision.element(4).notEqual(int(0)),()=>{selected.element(id).assign(0);});
          If(groups.element(id).equal(this.group).and(owner.equal(this.owner)),()=>{selected.element(id).assign(1);});
        });
      });
      If(order.greaterThanEqual(int(0)).and(selected.element(id).notEqual(int(0))).and(owner.equal(this.owner)),()=>{
        const type=u.element(at.add(UTYPE)),allowed=int(1).toVar();
        If(order.equal(int(3)).or(order.equal(int(4))).or(order.equal(int(0)).and(this.modifier.equal(int(2)))),()=>{allowed.assign(int(type.notEqual(int(movementType('SAM'))).and(type.notEqual(int(movementType('TRAN'))))));});
        if(simulation.setup.campaignLevel!==undefined)If(order.equal(int(0)).and(this.modifier.notEqual(int(2))).and(u.element(at.add(UDOMAIN)).equal(int(1))),()=>{allowed.assign(int(shadow.element(cell).notEqual(int(-2))));});
        If(order.equal(int(6)).and(id.notEqual(int(readWork.element(0)))),()=>{allowed.assign(0);});
        If(allowed.notEqual(int(0)),()=>{pending.element(id.mul(2)).assign(order);If(order.notEqual(int(6)).and(order.notEqual(int(1))).and(order.notEqual(int(2))),()=>{pending.element(id.mul(2).add(1)).assign(decision.element(3));});playerOrder(id);});
      });
      If(selected.element(id).notEqual(int(0)),()=>{
        atomicMin(totals.element(0),id);atomicAdd(totals.element(1),int(1));atomicMin(totals.element(3),u.element(at));atomicMin(totals.element(4),u.element(at.add(1)));
        atomicMax(totals.element(5),u.element(at));atomicMax(totals.element(6),u.element(at.add(1)));
      });
    })().compute(count);
    const finish=Fn(()=>{If(result.element(0).equal(int(count)),()=>{result.element(0).assign(-1);});})().compute(1);
    this.parallel=[reset,collect,auxiliary,decide,apply,finish];

  }
  setOwner(owner: number) {
    this.owner.value = owner;
    if (this.sight instanceof SightView) this.sight.setPerspective(owner === 1 ? 1 : 0);
    this.apply({ action: 'clear' });
  }
  apply(command: SelectionCommand) {
    if (this.sight instanceof SightView) this.sight.update(this.simulation.frame);
    this.args.value = ACTIONS.indexOf(command.action);
    this.x.value = command.x ?? 0;
    this.y.value = command.y ?? 0;
    this.x2.value = command.x2 ?? 0;
    this.y2.value = command.y2 ?? 0;
    this.modifier.value = command.modifier ?? 0;
    this.group.value = command.group ?? 0;
    this.renderer.compute(this.parallel);
  }
  /** Compile and execute the selection pipeline before input becomes available. */
  async prepare() {
    await this.renderer.compileComputeAsync(this.parallel);
    this.apply({action:'clear'});
    await this.read();
  }
  async read() {
    return new Int32Array(await this.renderer.getArrayBufferAsync(this.result));
  }
  dispose() {
    for (const pass of this.parallel) pass.dispose();
    releaseStorage(this.renderer, this.attributes);
  }
}
