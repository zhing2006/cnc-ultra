import {
  CELL_LEPTONS, confineRect, desiredFacing256, dirFacing, distance, facingDir, movePoint, pixelToLepton,
} from './coord.ts';

// Facings, as FacingType in DEFINES.H.
const FACING_N = 0;
const FACING_NE = 1;
const FACING_E = 2;
const FACING_SE = 3;
const FACING_S = 4;
const FACING_SW = 5;
const FACING_W = 6;
const FACING_NW = 7;

const DIR_N = 0;
const DIR_E = 64;
const DIR_S = 128;
const DIR_W = 192;

/** Scroll distance in leptons for each rate, from fastest to slowest (SCROLL.CPP, ScrollClass::AI). */
const RATES = [0x01c0, 0x0180, 0x0140, 0x0100, 0x00c0, 0x0080, 0x0040, 0x0020, 0x0010];

/** The default scroll rate option, TIMER_SECOND / TICKS_PER_SECOND (OPTIONS.CPP). */
const SCROLL_RATE = 4;

/** The mouse shape a scroll step asks for: an arrow, or a crossed arrow when the map cannot move. */
export interface ScrollCursor {
  facing: number;
  blocked: boolean;
}

/** The input one scroll step reads. */
export interface ScrollInput {
  /** Mouse position in view pixels, or null while the game does not have the mouse. */
  mouse: { x: number; y: number } | null;
  rightButton: boolean;
  /** Direction the arrow keys ask for, 0..255, or null when none are held. */
  keys: number | null;
}

/**
 * The tactical view position and the scrolling that moves it. Ported from SCROLL.CPP,
 * ScrollClass::AI, and DISPLAY.CPP, DisplayClass::Scroll_Map and DisplayClass::Set_Tactical_Position.
 * Positions are leptons from the top-left of the 64 × 64 map, kept as separate x and y.
 */
export class Scroller {
  rate = SCROLL_RATE;
  /** Top-left of the view. */
  x = 0;
  y = 0;
  private inertia = 0;
  private direction = 0;
  // Whether the arrow keys started the current scroll, which leaves the mouse shape alone.
  private byKeys = false;
  private viewWidth = 0;
  private viewHeight = 0;
  private readonly area: { x: number; y: number; width: number; height: number };

  /** area is the playable area in cells (MapCellX, MapCellY, MapCellWidth and MapCellHeight). */
  constructor(area: { x: number; y: number; width: number; height: number }) {
    this.area = area;
  }

  /** Sets the view size in pixels and keeps the view inside the map. DisplayClass::Set_View_Dimensions. */
  setViewSize(width: number, height: number) {
    this.viewWidth = width;
    this.viewHeight = height;
    this.setPosition(this.x, this.y);
  }

  private get leptonWidth() {
    return pixelToLepton(this.viewWidth);
  }

  private get leptonHeight() {
    return pixelToLepton(this.viewHeight);
  }

  /**
   * Moves the view, kept inside the playable area. DisplayClass::Set_Tactical_Position. A view wider
   * or taller than the area, which the original's 640 × 400 screen never had, stays at its left or top
   * edge, as Scroll_Map keeps it.
   */
  setPosition(x: number, y: number) {
    const left = this.area.x * CELL_LEPTONS;
    const top = this.area.y * CELL_LEPTONS;
    const confined = confineRect(x - left, y - top, this.leptonWidth, this.leptonHeight,
      this.area.width * CELL_LEPTONS, this.area.height * CELL_LEPTONS);
    this.x = Math.max(confined.x, 0) + left;
    this.y = Math.max(confined.y, 0) + top;
  }

  /**
   * Scrolls the view by distance leptons in a 256-step direction, or only checks whether it could
   * when really is false. Returns the distance it moved or would move, 0 when it cannot.
   * DisplayClass::Scroll_Map.
   */
  scroll(dir: number, length: number, really: boolean): number {
    if (length === 0) return 0;
    const left = this.area.x * CELL_LEPTONS;
    const top = this.area.y * CELL_LEPTONS;
    const right = (this.area.x + this.area.width) * CELL_LEPTONS;
    const bottom = (this.area.y + this.area.height) * CELL_LEPTONS;

    // Against an edge, a diagonal turns into the direction along it.
    const crude = dirFacing(dir);
    if (this.x === left && crude !== FACING_W) {
      if (crude === FACING_SW) dir = DIR_S;
      if (crude === FACING_NW) dir = DIR_N;
    }
    if (this.y === top && crude !== FACING_N) {
      if (crude === FACING_NW) dir = DIR_W;
      if (crude === FACING_NE) dir = DIR_E;
    }
    if (this.x + this.leptonWidth === right && crude !== FACING_E) {
      if (crude === FACING_NE) dir = DIR_N;
      if (crude === FACING_SE) dir = DIR_S;
    }
    if (this.y + this.leptonHeight === bottom && crude !== FACING_S) {
      if (crude === FACING_SE) dir = DIR_E;
      if (crude === FACING_SW) dir = DIR_W;
    }

    const [movedX, movedY] = movePoint(this.x, this.y, dir, length);
    let { x: xx, y: yy, shifted } = confineRect(movedX - left, movedY - top, this.leptonWidth, this.leptonHeight,
      this.area.width * CELL_LEPTONS, this.area.height * CELL_LEPTONS);
    if (xx < 0) {
      xx = 0;
      shifted = true;
    }
    if (yy < 0) {
      yy = 0;
      shifted = true;
    }
    const x = xx + left;
    const y = yy + top;
    if (shifted) length = distance(this.x, this.y, x, y);
    if (!length || (x === this.x && y === this.y)) return 0;
    if (really) this.setPosition(x, y);
    return length;
  }

  /**
   * One scroll step. ScrollClass::AI, which the original calls from its wait loop as often as the
   * machine allows. Its inertia counter ticks at 60 Hz, so the caller runs this once per 1/60 second.
   * Returns the mouse shape to show, or null when this step leaves the shape alone.
   */
  step(input: ScrollInput): ScrollCursor | null {
    let cursor: ScrollCursor | null = null;
    let playerScrolled = false;
    const { mouse } = input;
    const width = this.viewWidth;
    const height = this.viewHeight;
    const atEdge = mouse !== null
      && (mouse.y === 0 || mouse.x === 0 || mouse.x === width - 1 || mouse.y === height - 1);

    if (this.inertia || atEdge || input.keys !== null) {
      if (atEdge) {
        playerScrolled = true;
        // Emphasise the cardinal directions over the diagonals.
        let altx = mouse.x;
        if (altx < 50) altx -= (50 - altx) * 2;
        altx = Math.max(altx, 0);
        if (altx > width - 50) altx += (altx - (width - 50)) * 2;
        altx = Math.min(altx, width);
        if (altx > 50 && altx < width - 50) altx += Math.trunc((Math.trunc(width / 2) - altx) / 2);

        let alty = mouse.y;
        if (alty < 50) alty -= 50 - alty;
        alty = Math.max(alty, 0);
        if (alty > height - 50) alty += alty - (height - 50);
        alty = Math.min(alty, height);

        this.direction = desiredFacing256(Math.trunc(width / 2), Math.trunc(height / 2), altx, alty);
        this.byKeys = false;
      } else if (input.keys !== null) {
        // Arrow keys scroll like the mouse at the edge they point to (design constitution, article 3).
        playerScrolled = true;
        this.direction = input.keys;
        this.byKeys = true;
      }
      const control = dirFacing(this.direction);

      let rate = 8 - this.inertia;
      if (rate < this.rate + 1) {
        rate = this.rate + 1;
        this.inertia = 8 - rate;
      }
      // Holding the right mouse button slows scrolling down.
      if (input.rightButton) rate = Math.min(Math.max(rate + 1, 4), RATES.length - 1);

      // Without the free scrolling option the direction snaps to one of 8.
      this.direction = facingDir(dirFacing(this.direction));

      const blocked = !this.scroll(this.direction, RATES[rate] >> 1, false);
      if (!this.byKeys) cursor = { facing: control, blocked };
      if (!blocked) {
        // Auto scrolling is on by default, so no mouse button has to be held.
        this.scroll(this.direction, RATES[rate], true);
        if (playerScrolled) this.inertia++;
      }
    }
    if (!playerScrolled) {
      this.inertia--;
      if (this.inertia < 0) this.inertia++;
    }
    return cursor;
  }
}
