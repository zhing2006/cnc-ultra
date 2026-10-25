// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { StorageBufferAttribute, type WebGPURenderer, type ComputeNode, type Node, type IndirectStorageBufferAttribute } from 'three/webgpu';
import { Fn, If, Break, Continue, int, uint, storage, select,uniform,instanceIndex,atomicStore,atomicAdd } from 'three/tsl';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { randomNode } from '../../engine/simulation/integer-nodes.ts';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { initialTiberiumState, TIBERIUM_DIRECTIONS, TGROWTH, TSPREAD, type TiberiumSetup } from './tiberium-cpu.ts';
import type { GpuCombat } from './combat-gpu.ts';
import * as C from './combat-state.ts';
import * as U from './units-state.ts';
type I = Node<'int'>;

/** MAP.CPP, MapClass::Logic. The bounded 30-cell scan stays entirely on the GPU. */
export class GpuTiberium {
  get saveBuffers() { return this.attributes; }
  readonly amount: StorageBufferAttribute;
  readonly variants: StorageBufferAttribute;
  readonly state: StorageBufferAttribute;
  readonly clear: StorageBufferAttribute;
  readonly kernel: ComputeNode;
  private readonly attributes: StorageBufferAttribute[] = [];
  private impact:ComputeNode[]=[];
  private readonly impactFrame=uniform(0,'int');
  constructor(readonly renderer:WebGPURenderer, readonly setup:TiberiumSetup, occupied?:StorageBufferAttribute) {
    const keep = (array:Int32Array) => {
      const attribute = new StorageBufferAttribute(array, 1);
      this.attributes.push(attribute);
      return attribute;
    };
    this.amount = keep(setup.amount.slice());
    this.variants = keep(setup.variants.slice());
    this.state = keep(initialTiberiumState());
    this.clear = keep(setup.clear.slice());
    const read = (attribute:StorageBufferAttribute) => storage(attribute, 'int', attribute.count);
    const amount = read(this.amount), variants = read(this.variants), s = read(this.state), clear = read(this.clear);
    const blossom = read(keep(setup.blossom)).toReadOnly(), playable = read(keep(setup.playable)).toReadOnly();
    const occupancy = occupied ? storage(occupied, 'uint', occupied.count).toReadOnly() : undefined;
    const directions = read(keep(Int32Array.from(TIBERIUM_DIRECTIONS.flat()))).toReadOnly();
    const pick = (object:I, stream:number, count:I) => int(randomNode(uint(setup.seed), uint(s.element(0).add(int(0))), uint(object.add(int(0))), uint(stream)).mod(uint(count)));
    const add = (base:number, counter:number, cell:I, stream:number) => {
      If(s.element(counter).lessThan(50), () => {
        s.element(s.element(counter).add(base)).assign(cell);
        s.element(counter).addAssign(1);
      }).Else(() => { s.element(pick(cell, stream, int(50)).add(base)).assign(cell); });
    };
    this.kernel = Fn(() => {
      s.element(0).addAssign(1);
      if (setup.grow === false && setup.spread === false) return;
      const index = s.element(1).toVar();
      Loop(30, ({i}) => {
        If(index.greaterThanEqual(setup.amount.length), () => { Break(); });
        const cell = select(s.element(2).notEqual(0), index, int(setup.amount.length - 1).sub(index)).toVar();
        if (setup.grow !== false) If(amount.element(cell).greaterThanEqual(0).and(amount.element(cell).lessThan(11)), () => { add(TGROWTH, 3, cell, 0); });
        const spreading = blossom.element(cell).notEqual(0).or(setup.spread !== false ? amount.element(cell).greaterThan(6) : int(0).notEqual(0));
        If(spreading, () => {
          add(TSPREAD, 4, cell, 1);
          If(blossom.element(cell).notEqual(0), () => { add(TSPREAD, 4, cell, 2); add(TSPREAD, 4, cell, 3); });
        });
        // The 30th cell is scanned again on the next tick in the original loop.
        If(int(i).lessThan(29), () => { index.addAssign(1); });
      });
      s.element(1).assign(index);
      If(index.greaterThanEqual(setup.amount.length), () => {
        s.element(1).assign(0);
        s.element(2).assign(s.element(2).bitXor(1));
        const tries = setup.fast === false ? 1 : 2;
        If(s.element(3).greaterThan(0), () => {
          Loop(tries, ({i}) => {
            const cell = s.element(pick(int(i), 4, s.element(3)).add(TGROWTH)).toVar();
            If(amount.element(cell).greaterThanEqual(0).and(amount.element(cell).lessThan(11)), () => { amount.element(cell).addAssign(1); });
          });
        });
        s.element(3).assign(0);
        If(s.element(4).greaterThan(0), () => {
          Loop(tries, ({i}) => {
            const cell = s.element(pick(int(i), 5, s.element(4)).add(TSPREAD)).toVar();
            If(playable.element(cell).notEqual(0), () => {
              const offset = pick(int(i), 6, int(8)).toVar();
              Loop(8, ({i:j}) => {
                const direction = int(j).add(offset).bitAnd(7).mul(2).toVar();
                const x = cell.mod(setup.width).add(directions.element(direction)).toVar();
                const y = cell.div(setup.width).add(directions.element(direction.add(1))).toVar();
                If(x.greaterThanEqual(0).and(y.greaterThanEqual(0)).and(x.lessThan(setup.width)).and(y.lessThan(setup.height)), () => {
                  const target = y.mul(setup.width).add(x).toVar();
                  const unoccupied = int(1).toVar();
                  if(occupancy) Loop(5,({i:slot})=>{If(occupancy.element(target.mul(5).add(slot)).notEqual(uint(0)),()=>{unoccupied.assign(0);});});
                  If(clear.element(target).notEqual(0).and(amount.element(target).lessThan(0)).and(unoccupied.notEqual(0)), () => {
                    amount.element(target).assign(1);
                    variants.element(target).assign(pick(int(i), 7, int(12)));
                    Break();
                  });
                });
              });
            });
          });
        });
        s.element(4).assign(0);
      });
    })().compute(1);
  }
  step() { this.renderer.compute(this.kernel); }
  connect(battle:GpuCombat,terrain=battle.setup.land,bibs?:()=>ArrayLike<number>){
    battle.useTiberium(this.amount,terrain);
    const update=(_edges:Int32Array|Uint32Array|Uint8Array,passable:Uint8Array)=>{
      const owned=bibs?.();
      (this.clear.array as Int32Array).set(this.setup.clear.map((value,cell)=>value&&passable[cell]&&!owned?.[cell]?1:0));this.clear.needsUpdate=true;
    };
    battle.movement.mapObservers.add(update);update(battle.setup.grid.edges,battle.setup.passable!);
    const p=storage(battle.projectiles,'int',battle.projectiles.count).toReadOnly(),u=storage(battle.units,'int',battle.units.count).toReadOnly(),amount=storage(this.amount,'int',this.amount.count);
    const totals=new StorageBufferAttribute(new Uint32Array(this.amount.count),1);this.attributes.push(totals);
    const damage=storage(totals,'uint',totals.count).toAtomic(),total=storage(totals,'uint',totals.count).toReadOnly();
    const jobs=storage(battle.projectileJobs.buffer,'uint',battle.projectileJobs.buffer.count).toReadOnly();
    const clear=Fn(()=>{atomicStore(damage.element(instanceIndex),uint(0));})().compute(this.amount.count);
    const gather=Fn(()=>{
      If(instanceIndex.lessThan(jobs.element(battle.projectileJobs.count)),()=>{
        const id=int(jobs.element(instanceIndex.add(battle.projectileJobs.ids))),at=id.mul(C.BWORDS),valid=int(1).toVar();
        If(p.element(at.add(C.BEXPLODED)).equal(this.impactFrame),()=>{
          const target=p.element(at.add(C.BTARGET)).toVar();
          If(target.greaterThanEqual(0),()=>{If(u.element(target.mul(U.WORDS).add(U.UDOMAIN)).equal(1).and(u.element(target.mul(U.WORDS).add(U.UALTITUDE)).greaterThanEqual(16)),()=>{valid.assign(0);});});
          const cell=p.element(at.add(C.BY)).div(256).mul(this.setup.width).add(p.element(at.add(C.BX)).div(256)),levels=p.element(at.add(C.BDAMAGE)).div(10);
          If(valid.notEqual(0).and(cell.greaterThanEqual(0)).and(cell.lessThan(this.amount.count)).and(levels.greaterThan(0)),()=>{atomicAdd(damage.element(cell),uint(levels));});
        });
      });
    })().computeKernel([64]);
    (gather as unknown as {dispatchSize:IndirectStorageBufferAttribute}).dispatchSize=battle.projectileDispatch;
    const external=storage(battle.externalExplosions,'int',battle.externalExplosions.count).toReadOnly();
    const gatherExternal=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(C.SPECIAL_BLAST_WORDS).add(2);
      If(id.lessThan(external.element(0)).and(external.element(1).equal(this.impactFrame)),()=>{
        const cell=external.element(at.add(1)).div(256).mul(this.setup.width).add(external.element(at).div(256));
        const levels=external.element(at.add(2)).div(10).add(external.element(at.add(6)).mul(6));
        If(cell.greaterThanEqual(0).and(cell.lessThan(this.amount.count)).and(levels.greaterThan(0)),()=>{atomicAdd(damage.element(cell),uint(levels));});
      });
    })().compute(C.MAX_SPECIAL_BLASTS);
    const apply=Fn(()=>{
      const cell=int(instanceIndex),levels=int(total.element(cell));
      If(levels.greaterThan(0).and(amount.element(cell).greaterThanEqual(0)),()=>{amount.element(cell).assign(select(amount.element(cell).greaterThan(levels),amount.element(cell).sub(levels),int(-1)));});
    })().compute(this.amount.count);
    this.impact=[clear,gather,gatherExternal,apply];
  }
  damage(frame:number){if(this.impact.length){this.impactFrame.value=frame;this.renderer.compute(this.impact);}}
  prepareForPlay(){return this.renderer.compileComputeAsync([this.kernel,...this.impact]);}
  buffers() { return [this.amount, this.variants, this.state]; }
  dispose() { this.kernel.dispose();for(const pass of this.impact)pass.dispose(); releaseStorage(this.renderer, this.attributes); }
}
