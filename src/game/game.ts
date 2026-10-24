import { PalettePipeline } from '../engine/indexed/pipeline.ts';
import type { Renderer } from '../engine/renderer.ts';
import { CELL_LEPTONS, leptonToPixel } from './coord.ts';
import { loadData } from './data-files.ts';
import { ORIGINAL_MAP_SIZE } from './formats/scenario.ts';
import { GameInput, type ViewSize } from './input.ts';
import { buildScene, type CursorImage } from './scene.ts';
import { Scroller } from './scroll.ts';

/** The scenario M0 shows: GDI mission 8, map B. */
const SCENARIO = 'SCG08EB';

/** The original runs at 640 × 400. Each image pixel covers as many device pixels as fit that height. */
const ORIGINAL_HEIGHT = 400;

/** Scroll steps run once per tick of the original's 60 Hz timer (TIMER_SECOND in DEFINES.H). */
const TICK = 1000 / 60;

/** At most this many scroll steps catch up after a stalled frame, such as one in a background tab. */
const MAX_STEPS = 6;

export interface Game {
  dispose(): void;
}

/** Loads the original data and shows scg08eb on the renderer's canvas. */
export async function startGame(renderer: Renderer, canvas: HTMLCanvasElement): Promise<Game> {
  const scene = buildScene(await loadData(), SCENARIO);
  const pipeline = new PalettePipeline(renderer.three, { ...scene.setup, spriteCapacity: scene.sprites.length + 1 });
  const { scenario } = scene;
  const scroller = new Scroller(scenario);

  // Ported from CONQUER.CPP, Handle_View: a bookmark keeps the cell under the view's top-left corner,
  // and jumping to it puts the view's corner at that cell's corner. All four start at the home cell
  // (DisplayClass::Read_INI).
  const bookmarks = [scene.home, scene.home, scene.home, scene.home];
  const jumpTo = (cell: number) => scroller.setPosition((cell % ORIGINAL_MAP_SIZE) * CELL_LEPTONS,
    Math.floor(cell / ORIGINAL_MAP_SIZE) * CELL_LEPTONS);

  let view: ViewSize = { width: 1, height: 1, scale: 1 };
  const input = new GameInput(canvas, () => view, (index, record) => {
    if (record) {
      const cellX = Math.floor(scroller.x / CELL_LEPTONS);
      bookmarks[index] = Math.floor(scroller.y / CELL_LEPTONS) * ORIGINAL_MAP_SIZE + cellX;
    } else {
      jumpTo(bookmarks[index]);
    }
  });

  let started = false;
  let lastTick = 0;
  let cursor: CursorImage = scene.cursors.normal;
  // Nothing on the map moves yet, so its sprites go up once and each frame rewrites only the mouse.
  pipeline.setSprites(scene.sprites);

  renderer.setFrame((width, height, time) => {
    const scale = Math.max(1, Math.floor(height / ORIGINAL_HEIGHT));
    const viewWidth = Math.ceil(width / scale);
    const viewHeight = Math.ceil(height / scale);
    if (viewWidth !== view.width || viewHeight !== view.height || scale !== view.scale) {
      view = { width: viewWidth, height: viewHeight, scale };
      scroller.setViewSize(viewWidth, viewHeight);
    }
    if (!started) {
      started = true;
      lastTick = time;
      jumpTo(scene.home);
    }

    for (let steps = 0; time - lastTick >= TICK; steps++) {
      if (steps === MAX_STEPS) {
        lastTick = time;
        break;
      }
      lastTick += TICK;
      const shape = scroller.step({ mouse: input.mouse, rightButton: input.rightButton, keys: input.keyDirection() });
      const arrows = shape?.blocked ? scene.cursors.blocked : scene.cursors.scroll;
      cursor = shape ? arrows[shape.facing] : scene.cursors.normal;
    }

    const x = leptonToPixel(scroller.x);
    const y = leptonToPixel(scroller.y);
    // The original draws the mouse last, over everything else.
    const mouse = input.mouse && {
      x: x + input.mouse.x - cursor.hotX, y: y + input.mouse.y - cursor.hotY,
      region: cursor.region, remap: scene.plainRemap, shadow: false,
    };
    pipeline.setSprites(mouse ? [mouse] : [], scene.sprites.length);
    pipeline.render({ x, y, width: viewWidth, height: viewHeight }, scale);
  });

  return {
    dispose() {
      renderer.setFrame(null);
      input.dispose();
      pipeline.dispose();
    },
  };
}
