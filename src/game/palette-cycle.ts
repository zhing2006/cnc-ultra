/**
 * Ported from CONQUER.CPP, Color_Cycle, and DEFINES.H, CYCLE_COLOR_START/COUNT.
 * The seven water colors rotate once per 15 ticks of the 60 Hz system timer.
 */
export class PaletteCycle {
  readonly colors: Uint8Array;
  private readonly original: Uint8Array;
  private phase = -1;

  constructor(colors: Uint8Array) {
    this.original = colors.slice();
    this.colors = colors.slice();
  }

  /** User palette controls apply before cycling the water colors. */
  setColors(colors: Uint8Array) { this.original.set(colors); this.colors.set(colors); this.phase = -1; }

  /** elapsed is presentation time, independent of simulation and display refresh rate. */
  update(elapsed: number): boolean {
    // Color_Cycle's timer starts expired, so the first presentation already rotates once.
    const phase = (Math.floor(elapsed / 250) + 1) % 7;
    if (phase === this.phase) return false;
    this.phase = phase;
    for (let i = 0; i < 7; i++) {
      const source = (32 + (i - phase + 7) % 7) * 4;
      this.colors.set(this.original.subarray(source, source + 4), (32 + i) * 4);
    }
    return true;
  }
}
