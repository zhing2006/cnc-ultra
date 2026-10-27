import { loop as Loop } from '../../engine/simulation/loop.ts';
import { DataTexture, NearestFilter, RedFormat, RGBAFormat, UnsignedByteType, StorageBufferAttribute,
  Vector2, Vector4, type Node, type ComputeNode, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, Break, int, uint, ivec2, float, floor, storage, uniform, uniformArray, textureLoad, vec2, vec4, abs, mix, select, instanceIndex, atomicStore, atomicMin } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { intMax } from '../../engine/simulation/integer-nodes.ts';
import { MOVEMENT,movementType } from '../data/movement.ts';
import { combatTypes } from '../data/combat.ts';
import { PRODUCTION } from '../data/production.ts';
import { decodeShp } from '../formats/shp.ts';
import { HBASE,HWORDS,HLOAD } from './harvest-cpu.ts';
import { TBASE,TWORDS,TORDER } from './transport-cpu.ts';
import { CWORDS,CAMMO } from './combat-state.ts';
import { BUILDING_WORDS } from './economy-runtime.ts';
import { canCaptureBuilding } from '../data/abilities.ts';
import type { MixSet } from '../formats/mix.ts';
import type { GameScene } from '../scene.ts';
import { unitDistance } from './units-nodes.ts';
import { WORDS, UKIND, UTYPE, UHEALTH, UOWNER, UDOMAIN, UALTITUDE,UATTACHED,UCLOAK } from './units-state.ts';
import { cellEntryNode } from './cell-entry.ts';
import type { GpuUnits } from './units-gpu.ts';
import type { GpuSight } from './sight.ts';
import { SightView } from './sight-view.ts';
import type { GpuSelection } from './selection.ts';
/** Original indexed shroud and selection marks, followed by diagnostic layers and the cursor. */
export class UnitsView {
  readonly pointer = uniform(new Vector2(-1, -1));
  readonly sampleStep = uniform(1, 'int');
  readonly special = uniform(0,'int');
  readonly band = uniform(new Vector4(-1, -1, -1, -1));
  readonly flow = uniform(0, 'int');
  readonly vision = uniform(0, 'int');
  readonly cursor = uniform(-1, 'int');
  readonly time = uniform(0, 'int');
  readonly shift = uniform(0, 'int');
  readonly ctrl = uniform(0, 'int');
  readonly hovered: StorageBufferAttribute;
  readonly indexEffect: (pixel: Node<'ivec2'>, index: Node<'int'>) => Node<'int'>;
  readonly draw: (pixel: Node<'vec2'>, color: Node<'vec4'>) => Node<'vec4'>;
  private readonly textures: DataTexture[] = [];
  private readonly buffers: StorageBufferAttribute[] = [];
  private readonly hover;
  private readonly projected:ComputeNode[]=[];
  private readonly relations?:GpuUnits['actorIndex'];
  private relationFrame=-1;
  private readonly sightView: SightView;
  private readonly ownsSightView: boolean;
  constructor(private readonly renderer: WebGPURenderer, private readonly simulation: GpuUnits, sight: GpuSight, selection: GpuSelection, scene: GameScene, mixFiles: MixSet, combat = false,
    status?:{combat:StorageBufferAttribute;transport?:StorageBufferAttribute;mining?:StorageBufferAttribute;buildings?:StorageBufferAttribute},
    perspective?: SightView) {
    this.sightView = perspective ?? new SightView(sight);
    this.ownsSightView = !perspective;
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
    const pips=status?decodeShp(mixFiles.require('HPIPS.SHP')):undefined;
    const pipTexture=pips?texture(Uint8Array.from(pips.frames.flatMap(frame=>Array.from(frame))),pips.width,pips.height*pips.frames.length):undefined;
    const suffix = scene.scenario.theater[0].toUpperCase();
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
    const hasAircraft=simulation.setup.units.some(unit=>MOVEMENT[unit.type].domain===1);
    const statusBase=5+(hasAircraft?cells:0),count=simulation.setup.units.length;
    const hoverValues=new Int32Array(statusBase+(status?count*2:0));hoverValues.set([-1,0,-1,0]);hoverValues.fill(0x7fffffff,5,statusBase);
    const hoveredAttribute = this.hovered = new StorageBufferAttribute(hoverValues, 1);
    this.buffers.push(hoveredAttribute);
    const hovered = storage(hoveredAttribute, 'int', hoverValues.length);
    const result = storage(selection.result, 'int', 8).toReadOnly();
    const selected = storage(selection.state, 'int', selection.state.count).toReadOnly();
    const u = storage(simulation.units, 'int', simulation.units.count).toReadOnly();
    if(status){
      const combatState=storage(status.combat,'int',status.combat.count).toReadOnly();
      const mining=status.mining&&storage(status.mining,'int',status.mining.count).toReadOnly();
      const buildings=status.buildings&&storage(status.buildings,'int',status.buildings.count).toReadOnly();
      const cargo=status.transport&&storage(status.transport,'int',status.transport.count).toReadOnly();
      const relation=cargo?simulation.actorIndex:undefined;
      this.relations=relation;
      const cargoIndex=relation&&storage(relation.buffer,'uint',relation.buffer.count).toReadOnly();
      const pipTypes=uniformArray<'ivec2'>(MOVEMENT.map((type,id)=>new Vector2(type.name==='HARV'?7:type.name==='TRAN'||type.name==='APC'?5:
        type.domain===1&&combatTypes[id].primary>=0?5:Math.min(10,Math.trunc((PRODUCTION.get(type.name)?.capacity??0)/100)),Math.max(1,combatTypes[id].ammo))),'ivec2');
      const actorCount=uniform(count,'int');
      this.projected.push(Fn(()=>{
        const id=int(instanceIndex),at=id.mul(WORDS),type=u.element(at.add(UTYPE)),meta=pipTypes.element(type),filled=int(0).toVar(),packed=int(0).toVar(),flags=int(0).toVar();
        If(u.element(at.add(UDOMAIN)).equal(1),()=>{
          const ammo=combatState.element(id.mul(CWORDS).add(CAMMO));
          If(ammo.greaterThan(0),()=>{filled.assign(intMax(int(1),ammo.mul(256).div(meta.y).mul(meta.x).add(128).shiftRight(8)));});
        });
        if(mining)If(type.equal(movementType('HARV')),()=>{filled.assign(mining.element(id.mul(HWORDS).add(HBASE+HLOAD)).mul(256).div(28).mul(7).add(128).shiftRight(8));});
        if(buildings)If(u.element(at.add(UDOMAIN)).equal(2),()=>{filled.assign(buildings.element(id.mul(BUILDING_WORDS).add(5)));flags.assign(buildings.element(id.mul(BUILDING_WORDS).add(4)).bitAnd(1).mul(16));});
        Loop(10,({i})=>{If(i.lessThan(filled),()=>{packed.bitOrAssign(int(1).shiftLeft(i.mul(3)));});});
        if(cargo&&cargoIndex&&relation)If(type.equal(movementType('TRAN')).or(type.equal(movementType('APC'))),()=>{
          packed.assign(0);
          const priorOrder=int(0x7fffffff).toVar(),priorId=actorCount.toVar();
          Loop(5,({i:pip})=>{
            const best=int(-1).toVar(),bestOrder=int(-1).toVar();
            const passenger=int(cargoIndex.element(id.add(relation.cargoHead))).toVar();
            Loop(()=>{
              If(passenger.lessThan(0),()=>{Break();});
              const p=passenger.mul(WORDS),order=cargo.element(passenger.mul(TWORDS).add(TBASE+TORDER));
              If(u.element(p.add(UHEALTH)).greaterThan(0).and(u.element(p.add(UATTACHED)).equal(id.add(1)))
                .and(order.lessThan(priorOrder).or(order.equal(priorOrder).and(passenger.lessThan(priorId))))
                .and(order.greaterThan(bestOrder).or(order.equal(bestOrder).and(passenger.greaterThan(best)))),()=>{best.assign(passenger);bestOrder.assign(order);});
              passenger.assign(int(cargoIndex.element(passenger.add(relation.cargoNext))));
            });
            If(best.greaterThanEqual(0),()=>{
              const kind=u.element(best.mul(WORDS).add(UTYPE)),ink=int(1).toVar();
              If(kind.equal(movementType('RMBO')),()=>{ink.assign(7);}).ElseIf(kind.equal(movementType('E6')),()=>{ink.assign(5);})
                .ElseIf(kind.greaterThanEqual(movementType('C1')).and(kind.lessThanEqual(movementType('C10'))),()=>{ink.assign(6);});
              packed.bitOrAssign(ink.shiftLeft(pip.mul(3)));priorOrder.assign(bestOrder);priorId.assign(best);
            });
          });
        });
        hovered.element(id.mul(2).add(statusBase)).assign(packed);
        hovered.element(id.mul(2).add(statusBase+1)).assign(meta.x.bitOr(flags));
      })().compute(count));
    }
    const occupancy = storage(simulation.occupancy, 'uint', cells * 5).toReadOnly();
    const airCells=hasAircraft?{element:(cell:Node<'int'>)=>hovered.element(cell.add(5))}:undefined;
    if(hasAircraft){
      const target=storage(hoveredAttribute,'int',hoverValues.length).toAtomic();
      this.projected.push(Fn(()=>{atomicStore(target.element(instanceIndex.add(5)),int(0x7fffffff));})().compute(cells));
      this.projected.push(Fn(()=>{
        const id=int(instanceIndex),at=id.mul(WORDS);
        If(u.element(at.add(UDOMAIN)).equal(1).and(u.element(at.add(UHEALTH)).greaterThan(0)),()=>{
          const x=u.element(at).div(256),y=u.element(at.add(1)).sub(u.element(at.add(UALTITUDE)).mul(256).add(12).div(24)).div(256);
          If(x.greaterThanEqual(0).and(y.greaterThanEqual(0)).and(x.lessThan(width)).and(y.lessThan(height)),()=>{atomicMin(target.element(y.mul(width).add(x).add(5)),id.add(1));});
        });
      })().compute(simulation.setup.units.length));
    }
    const occupant=(cell:Node<'int'>,slot:Node<'int'>)=>{
      if(!airCells)return int(occupancy.element(cell.mul(5).add(slot))).sub(1);
      const id=int(-1).toVar();
      If(slot.lessThan(5),()=>{id.assign(int(occupancy.element(cell.mul(5).add(slot))).sub(1));})
        .Else(()=>{If(airCells.element(cell).notEqual(int(0x7fffffff)),()=>{id.assign(airCells.element(cell).sub(1));});});
      return id;
    };
    const canEnter = cellEntryNode(simulation, attribute => this.buffers.push(attribute), u, occupancy);
    const shadow = { element: this.sightView.shadowAt };
    const current = { element: this.sightView.currentAt };
    const goals = storage(simulation.pathGoals, 'int', simulation.pathGoals.count).toReadOnly();
    const lookup = storage(simulation.flow.lookup, 'int', cells).toReadOnly();
    const next = storage(simulation.flow.next, 'int', simulation.flow.next.count).toReadOnly();
    const valid = (p: Node<'ivec2'>) => p.x.greaterThanEqual(0).and(p.y.greaterThanEqual(0)).and(p.x.lessThan(width)).and(p.y.lessThan(height));
    const sample = (pos: Node<'ivec2'>) => int(textureLoad(atlas, pos).r.mul(255).round());
    const capturable=uniformArray<'int'>(MOVEMENT.map(t=>Number(canCaptureBuilding(t.name,simulation.setup.campaignLevel))),'int');
    this.hover = Fn(() => {
      hovered.element(0).assign(-1);
      hovered.element(1).assign(result.element(1));
      hovered.element(2).assign(-1);
      hovered.element(3).assign(0);
      hovered.element(4).assign(-1);
      const cell = ivec2(floor(this.pointer.div(24)));
      const best = int(182).toVar();
      If(valid(cell), () => {
        If(result.element(0).greaterThanEqual(int(0)), () => {
          const id = cell.y.mul(int(width)).add(cell.x);
          // Ported from DISPLAY.CPP, Mouse_Left_Up: shroud conceals forbidden ground.
          hovered.element(3).assign(select(shadow.element(id).equal(int(-2)).or(this.shift.notEqual(int(0)))
            .or(canEnter(result.element(0), id)), int(10), int(11)));
          if(simulation.setup.campaignLevel!==undefined)If(shadow.element(id).equal(-2).and(u.element(result.element(0).mul(WORDS).add(UDOMAIN)).equal(1)).and(this.ctrl.equal(0)),()=>{hovered.element(3).assign(11);});
        });
        If(shadow.element(cell.y.mul(width).add(cell.x)).notEqual(-2), () => {
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const p = cell.add(ivec2(dx, dy));
              If(valid(p), () => {
                Loop(hasAircraft?6:5, ({ i }) => {
                  const id = occupant(p.y.mul(width).add(p.x),int(i));
                  If(id.greaterThanEqual(0), () => {
                    const at = id.mul(WORDS);
                    const d = unitDistance(ivec2(this.pointer.mul(256).add(12).div(24)), ivec2(u.element(at), u.element(at.add(1)).sub(u.element(at.add(UALTITUDE)).mul(256).add(12).div(24))));
                    If(d.lessThan(best).and(u.element(at.add(UCLOAK)).notEqual(2).or(u.element(at.add(UOWNER)).equal(selection.owner))), () => {
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
        const chosen=hovered.element(0).toVar(),first=result.element(0).toVar();
        If(chosen.greaterThanEqual(0).and(this.shift.equal(0)).and(this.ctrl.equal(0)),()=>{
          const source=first.mul(WORDS),target=chosen.mul(WORDS),type=u.element(target.add(UTYPE));
          If(u.element(target.add(UOWNER)).equal(selection.owner),()=>{
            If(first.equal(chosen).and(type.equal(movementType('TRAN')).or(type.equal(movementType('APC')))),()=>{
              if(status)If(hovered.element(first.mul(2).add(statusBase)).notEqual(0),()=>{hovered.element(4).assign(53);});
            }).ElseIf(type.equal(movementType('TRAN')).or(type.equal(movementType('APC'))).and(u.element(source.add(UKIND)).notEqual(0)),()=>{
              if(status)If(hovered.element(chosen.mul(2).add(statusBase)).shiftRight(12).bitAnd(7).equal(0),()=>{hovered.element(4).assign(119);});
            })
              .ElseIf(type.equal(movementType('HPAD')).and(u.element(source.add(UDOMAIN)).equal(1))
                .or(type.equal(movementType('FIX')).and(u.element(source.add(UKIND)).equal(0)).and(u.element(source.add(UDOMAIN)).notEqual(2)))
                .or(type.equal(movementType('PROC')).and(u.element(source.add(UTYPE)).equal(movementType('HARV')))),()=>{hovered.element(4).assign(119);})
              .ElseIf(first.equal(chosen).and(type.equal(movementType('MCV'))),()=>{hovered.element(4).assign(53);});
          }).ElseIf(u.element(target.add(UDOMAIN)).equal(2),()=>{
            If(u.element(source.add(UTYPE)).equal(movementType('E6')).and(capturable.element(type).notEqual(0)),()=>{hovered.element(4).assign(119);});
            If(u.element(source.add(UTYPE)).equal(movementType('RMBO')),()=>{hovered.element(4).assign(122);});
          }).ElseIf(type.equal(movementType('TRAN')).and(u.element(source.add(UTYPE)).equal(movementType('E6'))).and(u.element(target.add(UALTITUDE)).equal(0)),()=>{
            if(status)If(hovered.element(chosen.mul(2).add(statusBase)).equal(0),()=>{hovered.element(4).assign(119);});
          });
        });
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
          const rawTarget=next.element(hovered.element(2).mul(cells).add(id));
          const target=select(rawTarget.greaterThanEqual(cells),rawTarget.sub(cells),rawTarget);
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
              Loop(hasAircraft?6:5, ({ i }) => {
                const unit = occupant(c.y.mul(width).add(c.x),int(i));
                If(unit.greaterThanEqual(0), () => {
                  const at = unit.mul(WORDS);
                  const type = u.element(at.add(UTYPE)).mul(3);
                  If(selected.element(unit).notEqual(0).and(u.element(at.add(UCLOAK)).notEqual(2).or(u.element(at.add(UOWNER)).equal(selection.owner))), () => {
                    const cx = u.element(at).mul(24).add(128).div(256);
                    const cy = u.element(at.add(1)).mul(24).add(128).div(256).sub(u.element(at.add(UALTITUDE))).sub(select(u.element(at.add(UKIND)).notEqual(0), int(6), int(0)));
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
                    If(u.element(at.add(UOWNER)).equal(selection.owner)
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
                    if(status&&pips&&pipTexture)If(u.element(at.add(UOWNER)).equal(selection.owner),()=>{
                      const packed=hovered.element(unit.mul(2).add(statusBase)),meta=hovered.element(unit.mul(2).add(statusBase+1));
                      const drawPip=(frame:Node<'int'>,x:Node<'int'>,y:Node<'int'>)=>{
                        const local=p.sub(ivec2(x,y));
                        If(local.x.greaterThanEqual(0).and(local.x.lessThan(pips.width)).and(local.y.greaterThanEqual(0)).and(local.y.lessThan(pips.height)),()=>{
                          const ink=int(textureLoad(pipTexture,ivec2(local.x,local.y.add(frame.mul(pips.height)))).r.mul(255).round());
                          If(ink.notEqual(0),()=>{out.assign(textureLoad(palette,ivec2(ink,0)));});
                        });
                      };
                      // TECHNO.CPP Draw_Pips: three-pixel spacing, centered on the lower bracket.
                      Loop(10,({i})=>{If(i.lessThan(meta.bitAnd(15)),()=>{drawPip(packed.shiftRight(i.mul(3)).bitAnd(7),lx.add(5).add(i.mul(3)).sub(Math.trunc(pips.width/2)),by.sub(3+Math.trunc(pips.height/2)));});});
                      If(meta.bitAnd(16).notEqual(0),()=>{drawPip(int(2),lx.add(3),by.sub(6));});
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
          .and(pixel.x.sub(lo.x).lessThan(float(this.sampleStep)).or(hi.x.sub(pixel.x).lessThan(float(this.sampleStep))).or(pixel.y.sub(lo.y).lessThan(float(this.sampleStep))).or(hi.y.sub(pixel.y).lessThan(float(this.sampleStep)))), () => {
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
          If(this.special.notEqual(0),()=>{
            frame.assign(select(this.special.equal(1),int(103).add(this.time.div(133).mod(16)),int(96).add(this.time.div(267).mod(7))));hot.assign(ivec2(15,12));
          }).ElseIf(hovered.element(4).greaterThanEqual(0),()=>{
            const start=hovered.element(4),frames=select(start.equal(119).or(start.equal(122)),int(3),int(9));
            frame.assign(start.add(this.time.div(267).mod(frames)));hot.assign(ivec2(15,12));
          }).ElseIf(int(combat ? 1 : 0).notEqual(0).and(hovered.element(1).greaterThan(0)).and(this.ctrl.notEqual(0)
            .or(hovered.element(0).greaterThanEqual(0).and(u.element(hovered.element(0).mul(WORDS).add(UOWNER)).notEqual(selection.owner)))), () => {
            frame.assign(int(18).add(this.time.div(67).mod(8))); hot.assign(ivec2(15,12));
          }).ElseIf(hovered.element(0).greaterThanEqual(0), () => {
            frame.assign(int(12).add(this.time.div(67).mod(6)));
            hot.assign(ivec2(15, 12));
          })
            .ElseIf(hovered.element(1).greaterThan(0), () => {
            frame.assign(hovered.element(3));
            hot.assign(ivec2(15, 12));
          });
        });
        const r = regions.element(frame);
        const local = ivec2(floor(pixel.sub(this.pointer).div(float(this.sampleStep)))).add(hot);
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
    this.sightView.update(this.simulation.frame);
    if(this.relations&&this.relationFrame!==this.simulation.frame){this.relations.refresh();this.relationFrame=this.simulation.frame;}
    if(this.projected.length)this.renderer.compute(this.projected);
    this.renderer.compute(this.hover);
  }
  dispose() {
    if (this.ownsSightView) this.sightView.dispose();
    this.hover.dispose();
    for(const kernel of this.projected)kernel.dispose();
    for (const t of this.textures)
      t.dispose();
    releaseStorage(this.renderer, this.buffers);
  }
}
