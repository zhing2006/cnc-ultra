import { loop as Loop } from '../../engine/simulation/loop.ts';
import { DataTexture, NearestFilter, RedFormat, RGBAFormat, UnsignedByteType, StorageBufferAttribute,
  Vector2, Vector4, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, int, ivec2, float, floor, storage, uniform, uniformArray, textureLoad, vec2, vec4, abs, mix, select } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { MOVEMENT } from '../data/movement.ts';
import type { MixSet } from '../formats/mix.ts';
import type { GameScene } from '../scene.ts';
import { unitDistance } from './units-nodes.ts';
import { WORDS, UKIND, UTYPE, UHEALTH, UOWNER } from './units-state.ts';
import { cellEntryNode } from './cell-entry.ts';
import type { GpuUnits } from './units-gpu.ts';
import type { GpuSight } from './sight.ts';
import type { GpuSelection } from './selection.ts';
/** Original indexed shroud and selection marks, followed by diagnostic layers and the cursor. */
export class UnitsView {
  readonly pointer = uniform(new Vector2(-1, -1));
  readonly band = uniform(new Vector4(-1, -1, -1, -1));
  readonly flow = uniform(0, 'int');
  readonly vision = uniform(0, 'int');
  readonly cursor = uniform(-1, 'int');
  readonly time = uniform(0, 'int');
  readonly shift = uniform(0, 'int');
  readonly hovered: StorageBufferAttribute;
  readonly indexEffect: (pixel: Node<'ivec2'>, index: Node<'int'>) => Node<'int'>;
  readonly draw: (pixel: Node<'vec2'>, color: Node<'vec4'>) => Node<'vec4'>;
  private readonly textures: DataTexture[] = [];
  private readonly buffers: StorageBufferAttribute[] = [];
  private readonly hover;
  constructor(private readonly renderer: WebGPURenderer, simulation: GpuUnits, sight: GpuSight, selection: GpuSelection, scene: GameScene, mixFiles: MixSet) {
    const { width, height } = simulation.setup.grid;
    const cells = width * height;
    const texture = (data: Uint8Array, w: number, h: number, rgba = false) => {
      const t = new DataTexture(data, w, h, rgba ? RGBAFormat : RedFormat, UnsignedByteType);
      t.minFilter = t.magFilter = NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this.textures.push(t);
      return t;
    };
    const atlas = texture(scene.setup.spriteAtlas.pixels, scene.setup.spriteAtlas.width, scene.setup.spriteAtlas.height);
    const palette = texture(scene.setup.palette, 256, 1, true);
    const suffix = scene.scenario.theater === 'TEMPERATE' ? 'T' : 'D';
    const shroudData = mixFiles.require(`${suffix}SHADOW.MRF`);
    const translucent = texture(shroudData, 256, shroudData.length / 256);
    const allRegions = [...scene.animation!.mouse, ...scene.animation!.shroud];
    const mouseCount = scene.animation!.mouse.length;
    const regions = uniformArray<'ivec4'>(allRegions.map(r => new Vector4(r.x, r.y, r.width, r.height)), 'ivec4');
    const statsAttribute = new StorageBufferAttribute(Int32Array.from(MOVEMENT.flatMap(t => {
      const r = scene.animation!.frames.get(t.name)?.[0];
      const size = t.name === 'MLRS' || t.name === 'MSAM' ? 26 : r ? Math.max(r.width, r.height) : 24;
      return [t.infantry ? 12 : size - Math.floor(size / 4), t.infantry ? 16 : size - Math.floor(size / 4), t.strength];
    })), 1);
    this.buffers.push(statsAttribute);
    const stats = storage(statsAttribute, 'int', statsAttribute.count).toReadOnly();
    const hoveredAttribute = this.hovered = new StorageBufferAttribute(new Int32Array([-1, 0, -1, 0]), 1);
    this.buffers.push(hoveredAttribute);
    const hovered = storage(hoveredAttribute, 'int', 4);
    const result = storage(selection.result, 'int', 8).toReadOnly();
    const selected = storage(selection.state, 'int', selection.state.count).toReadOnly();
    const u = storage(simulation.units, 'int', simulation.units.count).toReadOnly();
    const occupancy = storage(simulation.occupancy, 'uint', cells * 5).toReadOnly();
    const canEnter = cellEntryNode(simulation, attribute => this.buffers.push(attribute), u, occupancy);
    const shadow = storage(sight.shadow, 'int', cells).toReadOnly();
    const current = storage(sight.current, 'uint', cells).toReadOnly();
    const goals = storage(simulation.pathGoals, 'int', simulation.pathGoals.count).toReadOnly();
    const lookup = storage(simulation.flow.lookup, 'int', cells).toReadOnly();
    const next = storage(simulation.flow.next, 'int', simulation.flow.next.count).toReadOnly();
    const valid = (p: Node<'ivec2'>) => p.x.greaterThanEqual(0).and(p.y.greaterThanEqual(0)).and(p.x.lessThan(width)).and(p.y.lessThan(height));
    const sample = (pos: Node<'ivec2'>) => int(textureLoad(atlas, pos).r.mul(255).round());
    this.hover = Fn(() => {
      hovered.element(0).assign(-1);
      hovered.element(1).assign(result.element(1));
      hovered.element(2).assign(-1);
      hovered.element(3).assign(0);
      const cell = ivec2(floor(this.pointer.div(24)));
      const best = int(182).toVar();
      If(valid(cell), () => {
        If(result.element(0).greaterThanEqual(int(0)), () => {
          const id = cell.y.mul(int(width)).add(cell.x);
          // Ported from DISPLAY.CPP, Mouse_Left_Up: shroud conceals forbidden ground.
          hovered.element(3).assign(select(shadow.element(id).equal(int(-2)).or(this.shift.notEqual(int(0)))
            .or(canEnter(result.element(0), id)), int(10), int(11)));
        });
        If(shadow.element(cell.y.mul(width).add(cell.x)).notEqual(-2), () => {
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const p = cell.add(ivec2(dx, dy));
              If(valid(p), () => {
                Loop(5, ({ i }) => {
                  const id = int(occupancy.element(p.y.mul(width).add(p.x).mul(5).add(i))).sub(1);
                  If(id.greaterThanEqual(0), () => {
                    const at = id.mul(WORDS);
                    const d = unitDistance(ivec2(this.pointer.mul(256).add(12).div(24)), ivec2(u.element(at), u.element(at.add(1))));
                    If(d.lessThan(best), () => {
                      best.assign(d);
                      hovered.element(0).assign(id);
                    });
                  });
                });
              });
            }
        });
      });
      If(result.element(0).greaterThanEqual(0), () => {
        const goal = goals.element(result.element(0));
        If(goal.greaterThanEqual(0), () => {
          const field = lookup.element(goal);
          If(field.greaterThanEqual(0), () => {
            hovered.element(2).assign(field);
          });
        });
      });
    })().compute(1);
    this.indexEffect = (pixel, index) => Fn(() => {
      const cell = pixel.div(24);
      const out = index.toVar();
      If(valid(cell), () => {
        const shape = shadow.element(cell.y.mul(width).add(cell.x));
        If(shape.equal(-2), () => {
          out.assign(0);
        }).ElseIf(shape.greaterThanEqual(0), () => {
          const r = regions.element(shape.add(mouseCount));
          const ink = sample(r.xy.add(pixel.mod(24)));
          If(ink.notEqual(0), () => {
            const map = int(textureLoad(translucent, ivec2(ink, 0)).r.mul(255).round());
            If(map.equal(255), () => {
              out.assign(ink);
            }).Else(() => {
              out.assign(int(textureLoad(translucent, ivec2(out, map.add(1))).r.mul(255).round()));
            });
          });
        });
      }).Else(() => {
        out.assign(0);
      });
      return out;
    })();
    this.draw = (pixel, color) => Fn(() => {
      const out = color.toVar();
      const cell = ivec2(floor(pixel.div(24)));
      const p = ivec2(pixel);
      If(valid(cell), () => {
        const id = cell.y.mul(width).add(cell.x);
        If(this.vision.notEqual(0).and(current.element(id).notEqual(0)), () => {
          out.assign(mix(out, vec4(0.7, 0.25, 1, 1), 0.2));
        });
        If(this.flow.notEqual(0).and(hovered.element(2).greaterThanEqual(0)), () => {
          const target = next.element(hovered.element(2).mul(cells).add(id));
          const local = pixel.sub(vec2(cell).mul(24)).sub(12);
          If(target.greaterThanEqual(0), () => {
            const dir = vec2(target.mod(width).sub(cell.x), target.div(width).sub(cell.y)).normalize();
            const along = local.dot(dir);
            const across = abs(local.x.mul(dir.y).sub(local.y.mul(dir.x)));
            If(abs(along).lessThanEqual(6)
              .and(across.lessThan(0.8))
              .or(along.greaterThanEqual(2)
              .and(along.lessThanEqual(7))
              .and(abs(across.sub(float(7).sub(along))).lessThan(0.8))), () => {
              out.assign(vec4(0.1, 1, 0.95, 1));
            });
          });
        });
        // Ported from TECHNO.CPP, Draw_It: corner brackets and the four-pixel health bar.
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const c = cell.add(ivec2(dx, dy));
            If(valid(c), () => {
              Loop(5, ({ i }) => {
                const unit = int(occupancy.element(c.y.mul(width).add(c.x).mul(5).add(i))).sub(1);
                If(unit.greaterThanEqual(0), () => {
                  const at = unit.mul(WORDS);
                  const type = u.element(at.add(UTYPE)).mul(3);
                  If(selected.element(unit).notEqual(0), () => {
                    const cx = u.element(at).mul(24).add(128).div(256);
                    const cy = u.element(at.add(1)).mul(24).add(128).div(256).sub(select(u.element(at.add(UKIND)).notEqual(0), int(6), int(0)));
                    const w = stats.element(type);
                    const h = stats.element(type.add(1));
                    const lx = cx.sub(w.div(2));
                    const rx = cx.add(w.div(2));
                    const ty = cy.sub(h.div(2));
                    const by = cy.add(h.div(2));
                    const xx = p.x;
                    const yy = p.y;
                    const upper = ty.add(4);
                    const horizontal = yy.equal(upper)
                      .or(yy.equal(by))
                      .and(xx.greaterThanEqual(lx))
                      .and(xx.lessThanEqual(rx))
                      .and(xx.lessThanEqual(lx.add(w.div(5)))
                      .or(xx.greaterThanEqual(rx.sub(w.div(5)))));
                    const vertical = xx.equal(lx)
                      .or(xx.equal(rx))
                      .and(yy.greaterThanEqual(upper))
                      .and(yy.lessThanEqual(by))
                      .and(yy.lessThanEqual(upper.add(h.div(5)))
                      .or(yy.greaterThanEqual(by.sub(h.div(5)))));
                    If(horizontal.or(vertical), () => {
                      out.assign(vec4(textureLoad(palette, ivec2(15, 0)).rgb, 1));
                    });
                    If(u.element(at.add(UOWNER)).equal(0)
                      .and(xx.greaterThanEqual(lx))
                      .and(xx.lessThan(lx.add(w)))
                      .and(yy.greaterThanEqual(ty))
                      .and(yy.lessThanEqual(ty.add(3))), () => {
                      const fill = u.element(at.add(UHEALTH)).mul(w.sub(2)).div(stats.element(type.add(2)));
                      out.assign(vec4(textureLoad(palette, ivec2(12, 0)).rgb, 1));
                      If(xx.greaterThan(lx).and(xx.lessThanEqual(lx.add(fill))).and(yy.greaterThan(ty)).and(yy.lessThan(ty.add(3))), () => {
                        const ratio = u.element(at.add(UHEALTH)).mul(256).div(stats.element(type.add(2)));
                        const color = select(ratio.lessThan(63), int(8), select(ratio.lessThan(127), int(5), int(4)));
                        out.assign(vec4(textureLoad(palette, ivec2(color, 0)).rgb, 1));
                      });
                    });
                  });
                });
              });
            });
          }
      });
      If(this.band.x.greaterThanEqual(0), () => {
        const lo = this.band.xy.min(this.band.zw);
        const hi = this.band.xy.max(this.band.zw);
        If(pixel.x.greaterThanEqual(lo.x).and(pixel.x.lessThanEqual(hi.x)).and(pixel.y.greaterThanEqual(lo.y)).and(pixel.y.lessThanEqual(hi.y))
          .and(pixel.x.equal(lo.x).or(pixel.x.equal(hi.x)).or(pixel.y.equal(lo.y)).or(pixel.y.equal(hi.y))), () => {
          out.assign(vec4(1, 1, 1, 1));
        });
      });
      If(this.pointer.x.greaterThanEqual(0), () => {
        const frame = int(0).toVar();
        const hot = ivec2(0, 0).toVar();
        If(this.cursor.greaterThanEqual(0), () => {
          frame.assign(this.cursor);
          hot.assign(ivec2(15, 12));
        }).Else(() => {
          If(hovered.element(0).greaterThanEqual(0), () => {
            frame.assign(int(12).add(this.time.div(67).mod(6)));
            hot.assign(ivec2(15, 12));
          })
            .ElseIf(hovered.element(1).greaterThan(0), () => {
            frame.assign(hovered.element(3));
            hot.assign(ivec2(15, 12));
          });
        });
        const r = regions.element(frame);
        const local = p.sub(ivec2(this.pointer)).add(hot);
        If(local.x.greaterThanEqual(0).and(local.y.greaterThanEqual(0)).and(local.x.lessThan(r.z)).and(local.y.lessThan(r.w)), () => {
          const ink = sample(r.xy.add(local));
          If(ink.notEqual(0), () => {
            out.assign(vec4(textureLoad(palette, ivec2(ink, 0)).rgb, 1));
          });
        });
      });
      return out;
    })();
  }
  update() {
    this.renderer.compute(this.hover);
  }
  dispose() {
    this.hover.dispose();
    for (const t of this.textures)
      t.dispose();
    releaseStorage(this.renderer, this.buffers);
  }
}
