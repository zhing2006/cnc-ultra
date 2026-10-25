/** Wall-clock presentation policy only; no simulation tick or game rule is skipped. */
export class PlaybackPresentation {
  private speed = 1;
  private paused = false;
  private level = 0;
  private slowSamples = 0;
  private fastSamples = 0;
  private next: number | undefined;
  private readonly rates = [60, 30, 15];
  get limit() { return this.speed === 1 || this.paused ? 0 : this.rates[this.level]; }
  configure(speed: number, paused: boolean) {
    this.speed = speed; this.paused = paused;
    this.level = this.slowSamples = this.fastSamples = 0;
    this.next = undefined;
  }
  sample(actual: number) {
    if (this.speed === 1 || this.paused) return;
    const target = Math.min(10, this.speed);
    this.slowSamples = actual < target ? this.slowSamples + 1 : 0;
    this.fastSamples = actual > target * 1.2 ? this.fastSamples + 1 : 0;
    if (this.slowSamples >= 2 && this.level < this.rates.length - 1) {
      this.level++; this.slowSamples = this.fastSamples = 0; this.next = undefined;
    } else if (this.fastSamples >= 4 && this.level > 0) {
      this.level--; this.slowSamples = this.fastSamples = 0; this.next = undefined;
    }
  }
  draw(now: number) {
    const rate = this.limit;
    if (!rate) return true;
    const interval = 1000 / rate;
    if (this.next === undefined) { this.next = now + interval; return true; }
    if (now + 1e-6 < this.next) return false;
    // Preserve the cadence on a faster monitor, but never catch up discarded render frames.
    this.next += (Math.floor(Math.max(0, now - this.next + 1e-6) / interval) + 1) * interval;
    return true;
  }
}
