/** Wall time schedules ticks, but never enters simulation state. A stalled frame cannot skip a tick. */
export class SimulationClock {
  private previous: number | undefined;
  private accumulated = 0;
  private speed = 1;
  constructor(readonly hz: number, readonly maxCatchUp = 4) {}
  pause() { this.previous = undefined; this.accumulated = 0; }
  setSpeed(speed: number) { this.speed = speed; this.pause(); }
  get due() { return this.accumulated + 1e-8 >= 1000 / this.hz; }
  accumulate(now: number) {
    if (this.previous === undefined) { this.previous = now; return; }
    this.accumulated = this.speed === Infinity ? Infinity : this.accumulated + Math.max(0, now - this.previous) * this.speed;
    this.previous = now;
    // Bound wall-time debt, not the number of ticks per rendering frame. Every executed
    // tick still advances the simulation by exactly one fixed step at every speed.
    this.accumulated = Math.min(this.accumulated, 1000 / this.hz * this.maxCatchUp * this.speed);
  }
  drain(tick: () => unknown) {
    while (this.due) {
      if (tick() === false) break;
      this.accumulated -= 1000 / this.hz;
    }
  }
  advance(now: number, tick: () => unknown) {
    this.accumulate(now);
    this.drain(tick);
  }
}

/** A completed readback becomes observable only on a later simulation tick. One request in flight. */
export class DelayedReadback<T> {
  private pending = false;
  private completed: { frame: number; value: T } | undefined;
  private failure: unknown;
  request(frame: number, read: () => Promise<T>) {
    if (this.pending || this.completed) return;
    this.pending = true;
    read().then(value => { this.completed = { frame, value }; }, error => { this.failure = error; })
      .finally(() => { this.pending = false; });
  }
  take(frame: number): { frame: number; value: T } | undefined {
    if (this.failure) { const error = this.failure; this.failure = undefined; throw error; }
    if (!this.completed || frame <= this.completed.frame) return;
    const result = this.completed;
    this.completed = undefined;
    return result;
  }
}
