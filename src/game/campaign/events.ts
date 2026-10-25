import { ReadbackBuffer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, int, instanceIndex, select, storage } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import type { CpuCombat } from '../simulation/combat-cpu.ts';
import type { GpuCombat } from '../simulation/combat-gpu.ts';
import * as U from '../simulation/units-state.ts';
import * as C from '../simulation/combat-state.ts';

export const ATTACKED = 1, DISCOVERED = 2, DESTROYED = 4, CAPTURED = 8, ENTERED = 16, EVACUATED = 32, REMOVED = 64, SABOTAGED = 128;
export const CLOAKED=1<<16;
export const BASE_PANIC=1<<17;
export const EVENT_WORDS=3;
const FIELDS = [U.UHEALTH, U.UOWNER, U.UCELL, U.UATTACHED, U.UGENERATION] as const;
const STRIDE = 8;
const civilianTypes = MOVEMENT.flatMap((type, index) => type.infantry && /^(C\d+|CHAN|DELPHI|MOEBIUS)$/.test(type.name) ? [index] : []);

function initial(setup: C.CombatSetup) {
  const units = U.initialUnits(setup), previous = new Int32Array(setup.units.length * STRIDE);
  for (let id = 0; id < setup.units.length; id++) {
    FIELDS.forEach((field, offset) => previous[id * STRIDE + offset] = units[id * U.WORDS + field]);
    previous[id * STRIDE + 5] = (setup.units[id].owner ?? 0) === 0 ? 1 : 0;
    previous[id * STRIDE + 7] = units[id * U.WORDS + U.UDEST];
  }
  return previous;
}

/** OBJECT.CPP Take_Damage, TECHNO.CPP Revealed/Record_The_Kill/Captured, FOOT.CPP Per_Cell_Process. */
export function campaignEvents(battle: CpuCombat, previous: Int32Array, result = new Int32Array(battle.setup.units.length * EVENT_WORDS)) {
  const u = battle.units, c = battle.state, bounds = battle.setup.bounds;
  for (let id = 0; id < battle.setup.units.length; id++) {
    const at = id * U.WORDS, p = id * STRIDE, s = id * C.CWORDS;
    const same = previous[p + 4] === u[at + U.UGENERATION], alive = u[at + U.UHEALTH] > 0;
    let flags = 0, owner = u[at + U.UOWNER];
    if (same && previous[p] > 0) {
      if (!alive) flags |= c[s + C.CDEATH] >= 0 ? DESTROYED : REMOVED;
      if (previous[p + 1] !== owner && u[at + U.UCAPTURE_TICK] === battle.frame) { flags |= CAPTURED; owner = previous[p + 1]; }
    }
    if (c[s + C.CHIT_FRAME] === battle.frame && c[s + C.CHIT_SOURCE] > 0) flags |= ATTACKED;
    if (alive && c[s + C.CSEEN] && (!same || !previous[p + 5])) flags |= DISCOVERED;
    if (alive && u[at+U.UDOMAIN]===0 && !u[at + U.UATTACHED] && (!same || previous[p + 2] !== u[at + U.UCELL])) flags |= ENTERED;
    if(u[at+U.UCLOAK]===2)flags|=CLOAKED;
    if(c[s+C.CPANIC_FRAME]>0&&c[s+C.CPANIC_FRAME]===battle.frame)flags|=BASE_PANIC;
    const parent = previous[p + 3] - 1;
    if (same && previous[p] > 0 && !alive && parent >= 0 && !(u[at+U.UFLAGS]&U.TECHNICIAN) && civilianTypes.includes(u[at + U.UTYPE])) {
      const a = parent * U.WORDS, x = Math.trunc(u[a] / 256), y = Math.trunc(u[a + 1] / 256);
      if (u[a + U.UTYPE] === movementType('TRAN') && u[a + U.UHEALTH] <= 0 && c[parent * C.CWORDS + C.CDEATH] < 0
        && bounds && (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height)) flags |= EVACUATED;
    }
    if(same&&previous[p+6]===battle.frame&&previous[p+6]>0)flags|=SABOTAGED;
    result[id * EVENT_WORDS] = flags | owner << 8 | u[at+U.UOWNER]<<12; result[id * EVENT_WORDS + 1] = u[at + U.UCELL] | (c[s+C.CWARHEAD]+2)<<16;
    // FOOT.CPP Start_Driver / DRIVE.CPP Start_Of_Move check goodies before arrival.
    result[id*EVENT_WORDS+2]=alive&&u[at+U.UDOMAIN]===0&&!u[at+U.UATTACHED]&&u[at+U.UDEST]>=0&&(!same||previous[p+7]!==u[at+U.UDEST])?u[at+U.UDEST]:-1;
    FIELDS.forEach((field, offset) => previous[p + offset] = u[at + field]); previous[p + 5] = c[s + C.CSEEN];
    previous[p+6]=u[at+U.UBOMB_TICK];previous[p+7]=u[at+U.UDEST];
  }
  return result;
}

/** Only event flags and cells cross to the CPU; actor simulation remains in its existing buffers. */
export class GpuCampaignEvents {
  readonly previous: StorageBufferAttribute;
  readonly result: StorageBufferAttribute;
  private readonly readback: ReadbackBuffer;
  private readonly pass;
  static initial = initial;
  constructor(private readonly battle: GpuCombat) {
    const count = battle.setup.units.length, bounds = battle.setup.bounds;
    this.previous = new StorageBufferAttribute(initial(battle.setup), 1);
    this.result = new StorageBufferAttribute(new Int32Array(count * EVENT_WORDS), 1);
    this.readback = new ReadbackBuffer(this.result.array.byteLength);
    const u = storage(battle.units, 'int', battle.units.count).toReadOnly(), c = storage(battle.state, 'int', battle.state.count).toReadOnly();
    const previous = storage(this.previous, 'int', this.previous.count), result = storage(this.result, 'int', this.result.count);
    const clock = storage(battle.movement.control, 'int', 2).toReadOnly();
    this.pass = Fn(() => {
      const id = int(instanceIndex), at = id.mul(U.WORDS), p = id.mul(STRIDE), s = id.mul(C.CWORDS);
      const same = previous.element(p.add(4)).equal(u.element(at.add(U.UGENERATION))), alive = u.element(at.add(U.UHEALTH)).greaterThan(0);
      const flags = int(0).toVar(), owner = u.element(at.add(U.UOWNER)).toVar();
      If(same.and(previous.element(p).greaterThan(0)), () => {
        If(alive.not(), () => { flags.bitOrAssign(select(c.element(s.add(C.CDEATH)).greaterThanEqual(0), int(DESTROYED), int(REMOVED))); });
        If(previous.element(p.add(1)).notEqual(owner).and(u.element(at.add(U.UCAPTURE_TICK)).equal(clock.element(0))), () => { flags.bitOrAssign(CAPTURED); owner.assign(previous.element(p.add(1))); });
      });
      If(c.element(s.add(C.CHIT_FRAME)).equal(clock.element(0)).and(c.element(s.add(C.CHIT_SOURCE)).greaterThan(0)), () => { flags.bitOrAssign(ATTACKED); });
      If(alive.and(c.element(s.add(C.CSEEN)).notEqual(0)).and(same.not().or(previous.element(p.add(5)).equal(0))), () => { flags.bitOrAssign(DISCOVERED); });
      If(alive.and(u.element(at.add(U.UDOMAIN)).equal(0)).and(u.element(at.add(U.UATTACHED)).equal(0))
        .and(same.not().or(previous.element(p.add(2)).notEqual(u.element(at.add(U.UCELL))))), () => { flags.bitOrAssign(ENTERED); });
      If(u.element(at.add(U.UCLOAK)).equal(2),()=>{flags.bitOrAssign(CLOAKED);});
      If(c.element(s.add(C.CPANIC_FRAME)).greaterThan(0).and(c.element(s.add(C.CPANIC_FRAME)).equal(clock.element(0))),()=>{flags.bitOrAssign(BASE_PANIC);});
      const parent = previous.element(p.add(3)).sub(1).toVar();
      let civilian = u.element(at.add(U.UTYPE)).equal(-1);
      for (const type of civilianTypes) civilian = civilian.or(u.element(at.add(U.UTYPE)).equal(type));
      if (bounds) If(same.and(previous.element(p).greaterThan(0)).and(alive.not()).and(parent.greaterThanEqual(0)).and(civilian).and(u.element(at.add(U.UFLAGS)).bitAnd(U.TECHNICIAN).equal(0)), () => {
        const a = parent.mul(U.WORDS), x = u.element(a).div(256), y = u.element(a.add(1)).div(256);
        If(u.element(a.add(U.UTYPE)).equal(movementType('TRAN')).and(u.element(a.add(U.UHEALTH)).lessThanEqual(0)).and(c.element(parent.mul(C.CWORDS).add(C.CDEATH)).lessThan(0))
          .and(x.lessThan(bounds.x).or(y.lessThan(bounds.y)).or(x.greaterThanEqual(bounds.x + bounds.width)).or(y.greaterThanEqual(bounds.y + bounds.height))), () => { flags.bitOrAssign(EVACUATED); });
      });
      If(same.and(previous.element(p.add(6)).equal(clock.element(0))).and(previous.element(p.add(6)).greaterThan(0)),()=>{flags.bitOrAssign(SABOTAGED);});
      result.element(id.mul(EVENT_WORDS)).assign(flags.bitOr(owner.shiftLeft(8)).bitOr(u.element(at.add(U.UOWNER)).shiftLeft(12)));
      result.element(id.mul(EVENT_WORDS).add(1)).assign(u.element(at.add(U.UCELL)).bitOr(c.element(s.add(C.CWARHEAD)).add(2).shiftLeft(16)));
      result.element(id.mul(EVENT_WORDS).add(2)).assign(select(alive.and(u.element(at.add(U.UDOMAIN)).equal(0)).and(u.element(at.add(U.UATTACHED)).equal(0))
        .and(u.element(at.add(U.UDEST)).greaterThanEqual(0)).and(same.not().or(previous.element(p.add(7)).notEqual(u.element(at.add(U.UDEST))))),u.element(at.add(U.UDEST)),int(-1)));
      FIELDS.forEach((field, offset) => previous.element(p.add(offset)).assign(u.element(at.add(field)))); previous.element(p.add(5)).assign(c.element(s.add(C.CSEEN)));
      previous.element(p.add(6)).assign(u.element(at.add(U.UBOMB_TICK)));
      previous.element(p.add(7)).assign(u.element(at.add(U.UDEST)));
    })().compute(count);
  }
  prepare() { return this.battle.renderer.compileComputeAsync(this.pass); }
  async read() {
    this.battle.renderer.compute(this.pass);
    await this.battle.renderer.getArrayBufferAsync(this.result, this.readback);
    const result = new Int32Array(this.readback.buffer!).slice(); this.readback.release(); return result;
  }
  dispose() { this.pass.dispose(); this.readback.dispose(); releaseStorage(this.battle.renderer, [this.previous, this.result]); }
}
