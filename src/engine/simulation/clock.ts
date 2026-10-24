/** Wall time schedules ticks, but never enters simulation state. A stalled frame cannot skip a tick. */
export class SimulationClock {
  private previous: number | undefined;
  private accumulated = 0;
  constructor(readonly hz: number, readonly maxCatchUp = 4) {}
  pause() { this.previous = undefined; this.accumulated = 0; }
  advance(now: number, tick: () => void) {
    if (this.previous === undefined) { this.previous = now; return; }
    this.accumulated += Math.max(0, now - this.previous);
    this.previous = now;
    const duration = 1000 / this.hz;
    // Slow the simulation under sustained overload instead of accumulating unbounded debt.
    this.accumulated = Math.min(this.accumulated, duration * this.maxCatchUp);
    while (this.accumulated + 1e-8 >= duration) {
      this.accumulated -= duration;
      tick();
    }
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
