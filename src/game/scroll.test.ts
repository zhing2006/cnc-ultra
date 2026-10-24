import { describe, expect, test } from 'vitest';
import { Scroller, type ScrollInput } from './scroll.ts';

// The playable area of scg08eb, in cells, and a 640 × 400 view.
const AREA = { x: 2, y: 4, width: 56, height: 59 };
const WIDTH = 640;
const HEIGHT = 400;
const LEFT = AREA.x * 256;
const TOP = AREA.y * 256;
const RIGHT = (AREA.x + AREA.width) * 256;
// Pixel_To_Lepton(640) in FUNCTION.H: (640 * 256 + 12) / 24.
const VIEW_LEPTONS = 6827;

function scroller() {
  const view = new Scroller(AREA);
  view.setViewSize(WIDTH, HEIGHT);
  view.setPosition(LEFT, TOP + 1024);
  return view;
}

const atRightEdge: ScrollInput = { mouse: { x: WIDTH - 1, y: HEIGHT / 2 }, rightButton: false, keys: null };
const inMiddle: ScrollInput = { mouse: { x: WIDTH / 2, y: HEIGHT / 2 }, rightButton: false, keys: null };

/** How far x moves on each of the given steps. */
function moves(view: Scroller, inputs: ScrollInput[]) {
  return inputs.map((input) => {
    const before = view.x;
    view.step(input);
    return view.x - before;
  });
}

describe('scrolling as ScrollClass::AI does', () => {
  // Rates 8, 7, 6 and 5 of the rate table move 0x10, 0x20, 0x40 and 0x80 leptons, and the default
  // scroll rate of 4 holds the speed at rate 5. Moving east scales each distance by the cosine table's
  // 0x7F and shifts right by 7 (COORD.CPP, Move_Point), which drops a lepton or so.
  test('the mouse at the edge speeds up to the default rate', () => {
    const view = scroller();
    expect(moves(view, Array(7).fill(atRightEdge))).toEqual([15, 31, 63, 127, 127, 127, 127]);
    expect(view.y).toBe(TOP + 1024);
  });

  test('scrolling carries on and slows down after the mouse leaves the edge', () => {
    const view = scroller();
    moves(view, Array(6).fill(atRightEdge));
    expect(moves(view, Array(5).fill(inMiddle))).toEqual([127, 63, 31, 0, 0]);
  });

  test('holding the right mouse button keeps the speed one rate lower', () => {
    const view = scroller();
    const slow = { ...atRightEdge, rightButton: true };
    expect(moves(view, Array(6).fill(slow))).toEqual([15, 15, 31, 63, 63, 63]);
  });

  test('the arrow keys scroll like the mouse at the edge they point to', () => {
    const view = scroller();
    const east: ScrollInput = { mouse: null, rightButton: false, keys: 64 };
    expect(moves(view, Array(5).fill(east))).toEqual([15, 31, 63, 127, 127]);
  });

  test('the view stops at the edge of the playable area and the pointer shows it cannot move on', () => {
    const view = scroller();
    let cursor = view.step(atRightEdge);
    expect(cursor).toEqual({ facing: 2, blocked: false });
    for (let step = 0; step < 100; step++) cursor = view.step(atRightEdge);
    expect(view.x + VIEW_LEPTONS).toBe(RIGHT);
    expect(cursor).toEqual({ facing: 2, blocked: true });
  });

  // A 1366 × 768 window at scale 1 is 22 pixels wider than the 1344 of scg08eb's playable area.
  test('a view wider than the playable area stays at its left edge', () => {
    const view = new Scroller(AREA);
    view.setViewSize(1366, 768);
    view.setPosition(LEFT + 2048, TOP + 1024);
    expect(view.x).toBe(LEFT);
    const atLeftEdge: ScrollInput = { mouse: { x: 0, y: 384 }, rightButton: false, keys: null };
    const atRightEdge: ScrollInput = { mouse: { x: 1365, y: 384 }, rightButton: false, keys: null };
    expect(view.step(atLeftEdge)).toEqual({ facing: 6, blocked: true });
    expect(view.step(atRightEdge)).toEqual({ facing: 2, blocked: true });
    expect(view.x).toBe(LEFT);
  });
});
