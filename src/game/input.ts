/** The size of the view in image pixels and how many device pixels each image pixel covers. */
export interface ViewSize {
  width: number;
  height: number;
  scale: number;
}

/** Arrow key to x and y step. */
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Held arrow keys, summed as "x,y", to a direction: 0 is north and each step of 32 turns clockwise. */
const DIRECTIONS: Record<string, number> = {
  '0,-1': 0, '1,-1': 32, '1,0': 64, '1,1': 96, '0,1': 128, '-1,1': 160, '-1,0': 192, '-1,-1': 224,
};

/** The bookmark keys: F7 to F10 (CONQUER.CPP, Keyboard_Process). */
const BOOKMARK_KEYS = ['F7', 'F8', 'F9', 'F10'];

// Chrome on Windows now and then reports hundreds of pixels of movement the mouse never made, most
// often just after the lock starts (Chromium issue 40547981). Movement events larger than this, in CSS
// pixels, and those in the first moment of the lock are dropped.
const MAX_MOVEMENT = 200;
const LOCK_SETTLE_MS = 150;

/** About two conventional 120-pixel wheel detents per zoom level; trackpad deltas accumulate. */
const ZOOM_WHEEL_DISTANCE = 240;

/**
 * Mouse and keyboard input for the tactical view. The original runs full screen, so the mouse cannot
 * leave the screen and can be pushed against its edge. Here the page locks the pointer once the player
 * clicks the view, and the game tracks its own pointer, kept inside the view (design constitution,
 * article 3). Esc releases the lock, as the browser decides.
 */
export class GameInput {
  /** The pointer position in image pixels while the pointer is locked, otherwise null. */
  mouse: { x: number; y: number } | null = null;
  rightButton = false;
  private exactX = 0;
  private exactY = 0;
  private lockedAt = 0;
  private readonly held = new Set<string>();
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly view: () => ViewSize;

  /**
   * view tells the current view size. onBookmark is called for a bookmark key with the bookmark and
   * whether to record the view instead of jumping to it.
   */
  constructor(canvas: HTMLCanvasElement, view: () => ViewSize, onBookmark: (index: number, record: boolean) => void,
    onZoom: (step: number, anchor: { x: number; y: number }) => void,
    onMove?: (position: { x: number; y: number }) => void) {
    this.canvas = canvas;
    this.view = view;
    const listen = <E extends Event>(target: EventTarget, type: string, listener: (event: E) => void) => {
      target.addEventListener(type, listener as EventListener, { passive: false });
      this.listeners.push([target, type, listener as EventListener]);
    };

    listen<MouseEvent>(canvas, 'mousedown', (event) => {
      if (document.pointerLockElement !== canvas) {
        this.place(event.offsetX, event.offsetY);
        // A rejected request, for example while the browser still holds a recent release, changes nothing.
        canvas.requestPointerLock().catch(() => {});
        return;
      }
      if (event.button === 2) this.rightButton = true;
      if (event.button === 0 && this.mouse) onMove?.(this.mouse);
    });
    listen<MouseEvent>(window, 'mouseup', (event) => {
      if (event.button === 2) this.rightButton = false;
    });
    listen<MouseEvent>(canvas, 'contextmenu', (event) => event.preventDefault());
    let wheel = 0;
    listen<WheelEvent>(canvas, 'wheel', (event) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const { scale, width, height } = this.view();
      const delta = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? height : 1);
      if (wheel * delta < 0) wheel = 0;
      wheel += delta;
      if (Math.abs(wheel) < ZOOM_WHEEL_DISTANCE) return;
      const step = -Math.sign(wheel);
      wheel %= ZOOM_WHEEL_DISTANCE;
      const ratio = window.devicePixelRatio / scale;
      const anchor = this.mouse ?? { x: Math.min(width - 1, event.offsetX * ratio), y: Math.min(height - 1, event.offsetY * ratio) };
      onZoom(step, anchor);
    });
    listen<MouseEvent>(document, 'mousemove', (event) => {
      if (document.pointerLockElement !== canvas) return;
      if (event.timeStamp - this.lockedAt < LOCK_SETTLE_MS) return;
      if (Math.abs(event.movementX) > MAX_MOVEMENT || Math.abs(event.movementY) > MAX_MOVEMENT) return;
      const { width, height, scale } = this.view();
      const ratio = window.devicePixelRatio / scale;
      this.exactX = Math.min(Math.max(this.exactX + event.movementX * ratio, 0), width - 1);
      this.exactY = Math.min(Math.max(this.exactY + event.movementY * ratio, 0), height - 1);
      this.mouse = { x: Math.floor(this.exactX), y: Math.floor(this.exactY) };
    });
    listen(document, 'pointerlockchange', (event) => {
      if (document.pointerLockElement === canvas) {
        this.lockedAt = event.timeStamp;
        this.mouse = { x: Math.floor(this.exactX), y: Math.floor(this.exactY) };
      } else {
        this.mouse = null;
        this.rightButton = false;
      }
    });
    listen<KeyboardEvent>(window, 'keydown', (event) => {
      if ((event.target as HTMLElement)?.closest('input, select, textarea, button')) return;
      if (!event.ctrlKey && !event.metaKey && !event.altKey && ['+', '=', '-'].includes(event.key)) {
        const { width, height } = this.view();
        onZoom(event.key === '-' ? -1 : 1, { x: width / 2, y: height / 2 });
        event.preventDefault();
      }
      if (event.key in ARROWS) {
        this.held.add(event.key);
        event.preventDefault();
      }
      const bookmark = BOOKMARK_KEYS.indexOf(event.key);
      if (bookmark >= 0) {
        // Shift, Ctrl or Alt records the view; the plain key jumps to it (CONQUER.CPP, Handle_View).
        onBookmark(bookmark, event.shiftKey || event.ctrlKey || event.altKey);
        event.preventDefault();
      }
    });
    listen<KeyboardEvent>(window, 'keyup', (event) => this.held.delete(event.key));
    listen(window, 'blur', () => this.held.clear());
  }

  /** A zoom changes image coordinates, while the pointer keeps its position on the screen. */
  resize(previous: ViewSize) {
    const next = this.view();
    this.exactX = Math.max(0, Math.min(next.width - 1, this.exactX * previous.scale / next.scale));
    this.exactY = Math.max(0, Math.min(next.height - 1, this.exactY * previous.scale / next.scale));
    if (this.mouse) this.mouse = { x: Math.floor(this.exactX), y: Math.floor(this.exactY) };
  }

  /** Puts the pointer where the system pointer is, given in CSS pixels from the canvas corner. */
  private place(offsetX: number, offsetY: number) {
    const { width, height, scale } = this.view();
    const ratio = window.devicePixelRatio / scale;
    this.exactX = Math.min(Math.max(offsetX * ratio, 0), width - 1);
    this.exactY = Math.min(Math.max(offsetY * ratio, 0), height - 1);
  }

  /** The direction the held arrow keys point, 0..255 with 0 north, or null when they cancel out or none is held. */
  keyDirection(): number | null {
    let x = 0;
    let y = 0;
    for (const key of this.held) {
      const step = ARROWS[key];
      if (step) {
        x += step[0];
        y += step[1];
      }
    }
    return DIRECTIONS[`${x},${y}`] ?? null;
  }

  dispose() {
    for (const [target, type, listener] of this.listeners) target.removeEventListener(type, listener);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
}
