import { checksum } from './fixed.ts';
import { CELL, DEST, DEST_SLOT, DIRECTIONS, FLOW_PASSES, FRAME, KIND, LENGTH, PROGRESS, READY, SLOT,
  SPEED, TARGET, UNIT_WORDS, UNREACHABLE, X, Y, unitState, type MoveCommand, type SimulationSetup } from './state.ts';

/** Independent scalar reference for the parallel simulation. Only integer values enter its state. */
export class CpuSimulation {
  readonly units: Int32Array;
  readonly control: Int32Array;
  readonly distance: Int32Array;
  readonly next: Int32Array;
  readonly occupancy: Uint32Array;
  private readonly scratch: Int32Array;
  private readonly claims: Uint32Array;
  private readonly proposals: Int32Array;
  constructor(readonly setup: SimulationSetup) {
    this.units = unitState(setup);
    this.control = new Int32Array([0, setup.seed, -1, 0]);
    const count = setup.grid.width * setup.grid.height;
    this.distance = new Int32Array(count).fill(UNREACHABLE);
    this.scratch = new Int32Array(count);
    this.next = new Int32Array(count).fill(-1);
    this.occupancy = new Uint32Array(count * setup.spots.length);
    this.claims = new Uint32Array(this.occupancy.length);
    this.proposals = new Int32Array(setup.units.length).fill(-1);
    this.rebuildOccupancy();
  }
  step(commands: readonly MoveCommand[] = []) {
    const frame = this.control[FRAME] + 1;
    for (const command of commands) {
      if (command.frame !== frame) throw new Error('Commands must be submitted on their recorded tick');
      if (command.target !== this.control[TARGET]) {
        this.control[TARGET] = command.target;
        this.control[READY] = 0;
        this.distance.fill(UNREACHABLE);
        this.next.fill(-1);
        if (command.target >= 0) this.distance[command.target] = 0;
      }
    }
    this.flow();
    this.advance();
    this.rebuildOccupancy();
    this.reserve();
    this.rebuildOccupancy();
    this.control[FRAME] = frame;
  }
  private flow() {
    if (this.control[TARGET] < 0 || this.control[READY]) return;
    const { width, edges } = this.setup.grid;
    for (let pass = 0; pass < FLOW_PASSES; pass++) {
      let changed = false;
      for (let cell = 0; cell < edges.length; cell++) {
        let best = this.distance[cell];
        for (let d = 0; d < 8; d++) if (edges[cell] & (1 << d)) {
          const [dx, dy] = DIRECTIONS[d];
          best = Math.min(best, this.distance[cell + dy * width + dx] + (d & 1 ? 362 : 256));
        }
        this.scratch[cell] = best;
        changed ||= best !== this.distance[cell];
      }
      this.distance.set(this.scratch);
      if (!changed) { this.control[READY] = 1; break; }
    }
    if (!this.control[READY]) return;
    for (let cell = 0; cell < edges.length; cell++) {
      this.next[cell] = -1;
      if (this.distance[cell] === UNREACHABLE || cell === this.control[TARGET]) continue;
      for (let d = 0; d < 8; d++) if (edges[cell] & (1 << d)) {
        const [dx, dy] = DIRECTIONS[d], neighbor = cell + dy * width + dx;
        if (this.distance[neighbor] + (d & 1 ? 362 : 256) === this.distance[cell]) { this.next[cell] = neighbor; break; }
      }
    }
  }
  private point(cell: number, slot: number): [number, number] {
    const [x, y] = this.setup.spots[slot];
    return [(cell % this.setup.grid.width) * 256 + x, Math.floor(cell / this.setup.grid.width) * 256 + y];
  }
  private advance() {
    const u = this.units;
    for (let i = 0; i < u.length; i += UNIT_WORDS) if (u[i + DEST] >= 0) {
      const [sx, sy] = this.point(u[i + CELL], u[i + SLOT]), [tx, ty] = this.point(u[i + DEST], u[i + DEST_SLOT]);
      const progress = Math.min(u[i + LENGTH], u[i + PROGRESS] + u[i + SPEED]);
      u[i + PROGRESS] = progress;
      u[i + X] = sx + Math.trunc((tx - sx) * progress / u[i + LENGTH]);
      u[i + Y] = sy + Math.trunc((ty - sy) * progress / u[i + LENGTH]);
      if (progress === u[i + LENGTH]) { u[i + CELL] = u[i + DEST]; u[i + SLOT] = u[i + DEST_SLOT]; u[i + DEST] = -1; }
    }
  }
  private rebuildOccupancy() {
    this.occupancy.fill(0);
    const u = this.units, slots = this.setup.spots.length;
    for (let i = 0; i < u.length; i += UNIT_WORDS) for (const field of [CELL, DEST]) if (u[i + field] >= 0) {
      const first = u[i + field] * slots, id = i / UNIT_WORDS + 1;
      if (u[i + KIND] === 0) this.occupancy.fill(id, first, first + slots);
      else this.occupancy[first + u[i + (field === CELL ? SLOT : DEST_SLOT)]] = id;
    }
  }
  private reserve() {
    this.claims.fill(0xffffffff); this.proposals.fill(-1);
    if (!this.control[READY]) return;
    const u = this.units, slots = this.setup.spots.length;
    for (let i = 0; i < u.length; i += UNIT_WORDS) {
      const id = i / UNIT_WORDS, cell = this.next[u[i + CELL]];
      if (u[i + DEST] >= 0 || u[i + SPEED] === 0 || cell < 0) continue;
      const first = cell * slots;
      let chosen = -1;
      if (u[i + KIND] === 0) {
        if (this.occupancy.subarray(first, first + slots).every(value => value === 0)) chosen = 0;
      } else for (let slot = 0; slot < slots; slot++) if (this.occupancy[first + slot] === 0) { chosen = slot; break; }
      if (chosen < 0) continue;
      this.proposals[id] = first + chosen;
      for (let slot = 0; slot < slots; slot++) if (u[i + KIND] === 0 || slot === chosen) {
        this.claims[first + slot] = Math.min(this.claims[first + slot], id);
      }
    }
    for (let i = 0; i < u.length; i += UNIT_WORDS) {
      const id = i / UNIT_WORDS, proposal = this.proposals[id];
      if (proposal < 0) continue;
      const cell = Math.floor(proposal / slots), chosen = proposal % slots, first = cell * slots;
      let won = true;
      for (let slot = 0; slot < slots; slot++) if ((u[i + KIND] === 0 || slot === chosen) && this.claims[first + slot] !== id) won = false;
      if (!won) continue;
      u[i + DEST] = cell; u[i + DEST_SLOT] = chosen; u[i + PROGRESS] = 0;
      const [sx, sy] = this.point(u[i + CELL], u[i + SLOT]), [tx, ty] = this.point(cell, chosen);
      const dx = Math.abs(tx - sx), dy = Math.abs(ty - sy);
      // Integer octile length, also valid between sub-cell slots.
      u[i + LENGTH] = Math.max(dx, dy) + Math.floor(Math.min(dx, dy) * 106 / 256);
    }
  }
  buffers() { return [this.control, this.units, this.distance, this.next, this.occupancy]; }
  checksum() { return checksum(this.buffers()); }
}
