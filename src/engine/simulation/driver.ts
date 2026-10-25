import { SimulationClock } from './clock.ts';

export interface SimulationScheduler {
  now(): number;
  enqueue(task: () => void): void;
  dispose(): void;
}

/** One reusable task channel yields to input and rendering without nested timer clamping. */
function browserScheduler(): SimulationScheduler {
  const channel = new MessageChannel();
  let task: (() => void) | undefined;
  channel.port1.onmessage = () => { const next = task; task = undefined; next?.(); };
  return {
    now: () => performance.now(),
    enqueue(next) { task = next; channel.port2.postMessage(0); },
    dispose() { task = undefined; channel.port1.close(); channel.port2.close(); },
  };
}

/**
 * Wall time authorizes fixed steps; short tasks submit them outside the draw callback.
 * An asynchronous step must settle before the next step starts. In particular, a late
 * economic report stalls simulation, not rendering, and never changes the report's tick.
 */
export class SimulationDriver {
  private readonly clock: SimulationClock;
  private queued = false;
  private waiting = false;
  private paused = false;
  private disposed = false;
  private failure: { error: unknown } | undefined;
  constructor(hz: number, private readonly tick: () => void | false | Promise<void>,
    private readonly scheduler = browserScheduler(), private readonly sliceMilliseconds = 4) {
    this.clock = new SimulationClock(hz);
  }
  advance(now: number) {
    if (this.failure) throw this.failure.error;
    if (this.paused || this.disposed) return;
    this.clock.accumulate(now);
    this.schedule();
  }
  setPaused(paused: boolean) {
    this.paused = paused;
    this.clock.pause();
  }
  setSpeed(speed: number) { this.clock.setSpeed(speed); }
  private schedule() {
    if (this.paused || this.disposed || this.waiting || this.queued || this.failure || !this.clock.due) return;
    this.queued = true;
    this.scheduler.enqueue(() => this.run());
  }
  private run() {
    this.queued = false;
    if (this.paused || this.disposed || this.failure) return;
    const started = this.scheduler.now();
    let blocked = false;
    try {
      this.clock.drain(() => {
        if (this.waiting || this.scheduler.now() - started >= this.sliceMilliseconds) return false;
        const completion = this.tick();
        if (completion === false) { blocked = true; return false; }
        if (completion) {
          this.waiting = true;
          completion.then(() => {
            this.waiting = false;
            this.schedule();
          }, error => { this.waiting = false; this.failure = { error }; });
        }
      });
    } catch (error) { this.failure = { error }; }
    // A synchronously blocked step needs new input, so retry only on the next advance.
    if (!blocked) this.schedule();
  }
  dispose() {
    this.disposed = true;
    this.clock.pause();
    this.scheduler.dispose();
  }
}
