import { loop as Loop } from '../../engine/simulation/loop.ts';
// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type WebGPURenderer, type Node } from 'three/webgpu';
import { Fn, If, int, ivec2, storage, uniform, select } from 'three/tsl';
import { intMin, intMax } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { movementType } from '../data/movement.ts';
import { unitDistance } from './units-nodes.ts';
import { WORDS, UOWNER, UTYPE, UHEALTH } from './units-state.ts';
import type { GpuUnits } from './units-gpu.ts';
import type { GpuSight } from './sight.ts';
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
  readonly result: StorageBufferAttribute;
  readonly state: StorageBufferAttribute;
  readonly flashOffset: number;
  private readonly pass;
  private readonly args = uniform(0, 'int');
  private readonly x = uniform(0, 'int');
  private readonly y = uniform(0, 'int');
  private readonly x2 = uniform(0, 'int');
  private readonly y2 = uniform(0, 'int');
  private readonly modifier = uniform(0, 'int');
  private readonly group = uniform(0, 'int');
  private readonly attributes: StorageBufferAttribute[] = [];
  constructor(private readonly renderer: WebGPURenderer, simulation: GpuUnits, sight: GpuSight, combat = false) {
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
    const u = storage(simulation.units, 'int', simulation.units.count).toReadOnly();
    const pending = storage(simulation.pending, 'int', count * 2);
    const shadow = storage(sight.shadow, 'int', width * height).toReadOnly();
    const canEnter = cellEntryNode(simulation, attribute => this.attributes.push(attribute), u);
    this.pass = Fn(() => {
      const chosen = int(-1).toVar();
      const first = int(-1).toVar();
      const kind = this.args;
      const voice = int(0).toVar();
      const center = int(0).toVar();
      Loop(count, ({ i }) => {
        If(u.element(int(i).mul(WORDS).add(UHEALTH)).lessThanEqual(0), () => { selected.element(int(i)).assign(0); });
        If(first.lessThan(int(0)).and(selected.element(int(i)).notEqual(int(0))), () => {
          first.assign(int(i));
        });
      });
      result.element(0).assign(-1);
      result.element(1).assign(0);
      result.element(2).assign(0);
      const cell = this.y.div(int(256)).mul(int(width)).add(this.x.div(int(256)));
      const inside = this.x.greaterThanEqual(int(0))
        .and(this.y.greaterThanEqual(int(0)))
        .and(this.x.lessThan(int(width * 256)))
        .and(this.y.lessThan(int(height * 256)));
      // Ported from MAP.CPP, Close_Object: nearest center within 0xB5 leptons.
      If(kind.equal(int(0)).and(inside), () => {
        const best = int(182).toVar();
        If(shadow.element(cell).notEqual(int(-2)), () => {
          Loop(count, ({ i }) => {
            const at = int(i).mul(int(WORDS));
            const d = unitDistance(ivec2(this.x, this.y), ivec2(u.element(at), u.element(at.add(int(1)))));
            If(d.lessThan(best).and(u.element(at.add(UHEALTH)).greaterThan(0)), () => {
              best.assign(d);
              chosen.assign(int(i));
            });
          });
        });
        If(chosen.greaterThanEqual(int(0)), () => {
          If(int(combat ? 1 : 0).notEqual(0).and(first.greaterThanEqual(0))
            .and(u.element(chosen.mul(WORDS).add(UOWNER)).notEqual(0).or(this.modifier.equal(2))), () => {
            Loop(count, ({i}) => {
              If(selected.element(int(i)).notEqual(0), () => { pending.element(int(i).mul(2)).assign(3); pending.element(int(i).mul(2).add(1)).assign(chosen); });
            });
            voice.assign(3);
          }).Else(() => {
          // Ported from TECHNO.CPP, What_Action(ObjectClass*), and DISPLAY.CPP, Mouse_Left_Release.
          If(this.modifier.notEqual(int(0)).and(first.greaterThanEqual(int(0))), () => {
            const value = selected.element(chosen);
            value.assign(int(value.equal(int(0))));
            voice.assign(int(value.notEqual(int(0))));
          }).ElseIf(selected.element(chosen).equal(int(0)), () => {
            Loop(count, ({ i }) => {
              selected.element(i).assign(int(i.equal(chosen)));
            });
            voice.assign(1);
          });
          });
        }).Else(() => {
          // Ported from FOOT.CPP, Active_Click_With: MOVE and NOMOVE both assign a mission.
          If(first.greaterThanEqual(int(0)), () => {
            Loop(count, ({ i }) => {
              const at = int(i).mul(int(WORDS));
              If(selected.element(at.div(int(WORDS))).notEqual(int(0)).and(u.element(at.add(int(UOWNER))).equal(int(0))), () => {
                pending.element(int(i).mul(int(2))).assign(select(int(combat ? 1 : 0).notEqual(0).and(this.modifier.equal(2)), int(4), int(0)));
                pending.element(int(i).mul(int(2)).add(int(1))).assign(cell);
              });
            });
            voice.assign(select(int(combat ? 1 : 0).notEqual(int(0)).and(this.modifier.equal(int(2))), int(3), int(2)));
            // Only ACTION_MOVE creates ANIM_MOVE_FLASH. A NOMOVE cursor may be hidden by shroud.
            If(this.modifier.notEqual(int(0)).or(canEnter(first, cell)), () => {
              flash.element(0).assign(this.x);
              flash.element(1).assign(this.y);
              flash.element(2).assign(clock.element(0));
              flash.element(3).addAssign(int(1));
            });
          });
        });
      });
      // Ported from DISPLAY.CPP, Select_These: replace the selection, including while Shift is held.
      If(kind.equal(int(1)), () => {
        Loop(count, ({ i }) => {
          const at = int(i).mul(int(WORDS));
          const xx = u.element(at);
          const yy = u.element(at.add(int(1)));
          selected.element(at.div(int(WORDS))).assign(int(u.element(at.add(UHEALTH)).greaterThan(0).and(u.element(at.add(int(UOWNER))).equal(int(0)))
            .and(xx.greaterThanEqual(intMin(this.x, this.x2)))

              .and(xx.lessThanEqual(intMax(this.x, this.x2)))
              .and(yy.greaterThanEqual(intMin(this.y, this.y2)))
              .and(yy.lessThanEqual(intMax(this.y, this.y2)))));
        });
        voice.assign(1);
      });
      If(kind.equal(int(2)), () => {
        Loop(count, ({ i }) => {
          selected.element(int(i)).assign(0);
        });
      });
      // Ported from CONQUER.CPP, Handle_Team: Ctrl creates, Shift adds, Alt selects and centers.
      If(kind.equal(int(3)), () => {
        If(this.modifier.equal(int(2)), () => {
          Loop(count, ({ i }) => {
            const at = int(i).mul(int(WORDS));
            If(u.element(at.add(int(UOWNER))).equal(int(0)), () => {
              If(groups.element(at.div(int(WORDS))).equal(this.group), () => {
                groups.element(at.div(int(WORDS))).assign(-1);
              });
              If(selected.element(at.div(int(WORDS))).notEqual(int(0)), () => {
                groups.element(at.div(int(WORDS))).assign(this.group);
              });
            });
          });
        }).Else(() => {
          const replace = this.modifier.notEqual(int(1)).and(first.greaterThanEqual(int(0))).and(groups.element(first).notEqual(this.group));
          Loop(count, ({ i }) => {
            const at = int(i).mul(int(WORDS));
            If(replace, () => {
              selected.element(at.div(int(WORDS))).assign(0);
            });
            If(groups.element(at.div(int(WORDS))).equal(this.group).and(u.element(at.add(int(UOWNER))).equal(int(0))), () => {
              selected.element(at.div(int(WORDS))).assign(1);
            });
          });
          voice.assign(1);
          center.assign(int(this.modifier.equal(int(3))));
        });
      });
      If(kind.equal(int(4)).or(kind.equal(int(5))), () => {
        Loop(count, ({ i }) => {
          const previous = first.sub(int(i)).sub(int(1)).add(int(count * 2)).mod(int(count));
          const following = first.add(int(i)).add(int(1)).mod(int(count));
          const id = select(kind.equal(int(5)), int(i), select(this.modifier.notEqual(int(0)), previous, following));
          const at = id.mul(int(WORDS)).toVar();
          If(chosen.lessThan(int(0)).and(u.element(at.add(int(UOWNER))).equal(int(0))), () => {
            If(kind.equal(int(4)).or(u.element(at.add(int(UTYPE))).equal(int(movementType('MCV')))), () => {
              chosen.assign(id);
            });
          });
        });
        If(chosen.greaterThanEqual(int(0)), () => {
          Loop(count, ({ i }) => {
            selected.element(int(i)).assign(int(int(i).equal(chosen)));
          });
          voice.assign(1);
          center.assign(1);
        });
      });
      If(kind.equal(int(6)), () => {
        center.assign(1);
      });
      If(kind.equal(int(7)).or(kind.equal(int(8))), () => {
        Loop(count, ({ i }) => {
          const at = int(i).mul(int(WORDS));
          If(selected.element(at.div(int(WORDS))).notEqual(int(0)).and(u.element(at.add(int(UOWNER))).equal(int(0))), () => {
            pending.element(int(i).mul(int(2))).assign(kind.sub(int(6)));
          });
        });
      });
      result.element(3).assign(0x7fffffff);
      result.element(4).assign(0x7fffffff);
      result.element(5).assign(0);
      result.element(6).assign(0);
      Loop(count, ({ i }) => {
        const at = int(i).mul(int(WORDS));
        If(selected.element(at.div(int(WORDS))).notEqual(int(0)), () => {
          If(result.element(0).lessThan(int(0)), () => {
            result.element(0).assign(int(i));
          });
          result.element(1).addAssign(int(1));
          result.element(3).assign(intMin(result.element(3), u.element(at)));
          result.element(4).assign(intMin(result.element(4), u.element(at.add(int(1)))));
          result.element(5).assign(intMax(result.element(5), u.element(at)));
          result.element(6).assign(intMax(result.element(6), u.element(at.add(int(1)))));
        });
      });
      result.element(2).assign(voice);
      result.element(7).assign(center);
    })().compute(1);
  }
  apply(command: SelectionCommand) {
    this.args.value = ACTIONS.indexOf(command.action);
    this.x.value = command.x ?? 0;
    this.y.value = command.y ?? 0;
    this.x2.value = command.x2 ?? 0;
    this.y2.value = command.y2 ?? 0;
    this.modifier.value = command.modifier ?? 0;
    this.group.value = command.group ?? 0;
    this.renderer.compute(this.pass);
  }
  /** Compile and execute the selection pipeline before input becomes available. */
  async prepare() {
    this.apply({action:'clear'});
    await this.read();
  }
  async read() {
    return new Int32Array(await this.renderer.getArrayBufferAsync(this.result));
  }
  dispose() {
    this.pass.dispose();
    releaseStorage(this.renderer, this.attributes);
  }
}
