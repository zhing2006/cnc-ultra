import { PalettePipeline } from '../engine/indexed/pipeline.ts';
import type { Renderer } from '../engine/renderer.ts';
import { CELL_LEPTONS, CELL_PIXELS, leptonToPixel, pixelToLepton } from './coord.ts';
import { loadData } from './data-files.ts';
import { ORIGINAL_MAP_SIZE } from './formats/scenario.ts';
import { GameInput, type ViewSize } from './input.ts';
import { buildScene, type CursorImage } from './scene.ts';
import { Scroller } from './scroll.ts';
import { PaletteCycle } from './palette-cycle.ts';
import { initialZoom, MAX_ZOOM, zoomOrigin } from './zoom.ts';
import { SimulationClock, DelayedReadback } from '../engine/simulation/clock.ts';
import { GpuSimulation } from '../engine/simulation/gpu.ts';
import { GpuChecksum } from '../engine/simulation/checksum.ts';
import { unitState } from '../engine/simulation/state.ts';
import { simulationScene } from './simulation/scene.ts';
import { GpuGround, groundLayout } from './simulation/ground.ts';
import { flowOverlay } from './simulation/overlay.ts';
import { LOGIC_HZ } from './simulation/map.ts';

/** The default scenario: GDI mission 8, map B. */
const SCENARIO = 'SCG08EB';

/** Scroll steps run once per tick of the original's 60 Hz timer (TIMER_SECOND in DEFINES.H). */
const TICK = 1000 / 60;

/** At most this many scroll steps catch up after a stalled frame, such as one in a background tab. */
const MAX_STEPS = 6;

export interface Game {
  dispose(): void;
  setFlow(enabled: boolean): void;
  setPaused(paused: boolean): void;
}

export interface GameOptions {
  simulation?: boolean;
  onStats?: (frame: number, checksum: string) => void;
}

/** Loads the original data and shows scg08eb on the renderer's canvas. */
export async function startGame(renderer: Renderer, canvas: HTMLCanvasElement, options: GameOptions = {}): Promise<Game> {
  const data = await loadData();
  const demo = options.simulation ? simulationScene(data) : undefined;
  const scene = demo?.scene ?? buildScene(data, SCENARIO);
  const simulation = demo && new GpuSimulation(renderer.three, demo.setup);
  const layout = demo && groundLayout(scene, unitState(demo.setup));
  const flow = simulation && flowOverlay(simulation);
  const spriteSize = scene.sprites.reduce((size, sprite) => ({
    maxWidth: Math.max(size.maxWidth, sprite.region.width), maxHeight: Math.max(size.maxHeight, sprite.region.height),
  }), {maxWidth:1,maxHeight:1});
  const pipeline = new PalettePipeline(renderer.three, { ...scene.setup, spriteCapacity: (layout?.count ?? scene.sprites.length) + 1,
    ...(layout && { dynamicSprites: spriteSize, overlay: flow!.draw }) });
  const ground = simulation && layout && new GpuGround(renderer.three, simulation, pipeline, layout);
  const checksum = simulation && ground && new GpuChecksum(renderer.three, [...simulation.buffers(), ground.order.order]);
  const clock = new SimulationClock(LOGIC_HZ);
  const readback = new DelayedReadback<Uint32Array>();
  let paused = false, target: number | undefined, digest = '';
  const visibility = () => { clock.pause(); };
  document.addEventListener('visibilitychange', visibility);
  const { scenario } = scene;
  const scroller = new Scroller(scenario);
  const palette = new PaletteCycle(scene.setup.palette);

  // Ported from CONQUER.CPP, Handle_View: a bookmark keeps the cell under the view's top-left corner,
  // and jumping to it puts the view's corner at that cell's corner. All four start at the home cell
  // (DisplayClass::Read_INI).
  const bookmarks = [scene.home, scene.home, scene.home, scene.home];
  const jumpTo = (cell: number) => scroller.setPosition((cell % ORIGINAL_MAP_SIZE) * CELL_LEPTONS,
    Math.floor(cell / ORIGINAL_MAP_SIZE) * CELL_LEPTONS);

  let view: ViewSize = { width: 1, height: 1, scale: 1 };
  let scale = 0;
  let bufferWidth = 1, bufferHeight = 1;
  // Center axes on which the entire map fits. Keep the scroll position in map coordinates and
  // the padding in whole image pixels so presentation, pointer placement and zoom share an origin.
  const padding = () => ({
    x: Math.max(0, Math.floor((view.width - scenario.width * CELL_PIXELS) / 2)),
    y: Math.max(0, Math.floor((view.height - scenario.height * CELL_PIXELS) / 2)),
  });
  const viewOrigin = () => {
    const inset = padding();
    return { x: leptonToPixel(scroller.x) - inset.x, y: leptonToPixel(scroller.y) - inset.y };
  };
  const resize = () => {
    const previous = view;
    view = { width: Math.ceil(bufferWidth / scale), height: Math.ceil(bufferHeight / scale), scale };
    scroller.setViewSize(view.width, view.height);
    input.resize(previous);
  };
  const input = new GameInput(canvas, () => view, (index, record) => {
    if (record) {
      const cellX = Math.floor(scroller.x / CELL_LEPTONS);
      bookmarks[index] = Math.floor(scroller.y / CELL_LEPTONS) * ORIGINAL_MAP_SIZE + cellX;
    } else {
      jumpTo(bookmarks[index]);
    }
  }, (step, anchor) => {
    const next = Math.max(1, Math.min(MAX_ZOOM, scale + step));
    if (scale === 0 || next === scale) return;
    const origin = viewOrigin();
    const x = zoomOrigin(origin.x, anchor.x, scale, next);
    const y = zoomOrigin(origin.y, anchor.y, scale, next);
    scale = next;
    resize();
    const inset = padding();
    scroller.setPosition(pixelToLepton(x + inset.x), pixelToLepton(y + inset.y));
  }, (position) => {
    if (!demo) return;
    const origin = viewOrigin(), x = Math.floor((position.x + origin.x) / CELL_PIXELS), y = Math.floor((position.y + origin.y) / CELL_PIXELS);
    if (x >= 0 && y >= 0 && x < demo.setup.grid.width && y < demo.setup.grid.height && demo.passable[y * demo.setup.grid.width + x]) {
      target = y * demo.setup.grid.width + x;
    }
  });

  let started = false;
  let lastTick = 0;
  let startTime = 0;
  let cursor: CursorImage = scene.cursors.normal;
  // The original-map viewer uploads static sprites once; the demo writes them on the GPU.
  if (!simulation) pipeline.setSprites(scene.sprites);

  renderer.setFrame((width, height, time) => {
    bufferWidth = width;
    bufferHeight = height;
    if (!scale) scale = initialZoom(height);
    const viewWidth = Math.ceil(width / scale);
    const viewHeight = Math.ceil(height / scale);
    if (viewWidth !== view.width || viewHeight !== view.height || scale !== view.scale) {
      resize();
    }
    if (!started) {
      started = true;
      lastTick = time;
      startTime = time;
      jumpTo(scene.home);
    }

    if (palette.update(time - startTime)) pipeline.setPalette(palette.colors);

    if (simulation && ground && !paused && !document.hidden) clock.advance(time, () => {
      // Ported from CONQUER.CPP, Main_Loop: Sort precedes Logic.AI, so the new positions are
      // rendered with the order computed from the previous tick's positions.
      ground.sort();
      simulation.step(target === undefined ? [] : [{ frame: simulation.frame + 1, target }]);
      target = undefined;
      ground.updateSprites();
      if (simulation.frame % 15 === 0 && checksum) readback.request(simulation.frame, () => checksum.read());
      const completed = readback.take(simulation.frame);
      if (completed) digest = Array.from(completed.value, word => word.toString(16).padStart(8, '0')).join('');
      options.onStats?.(simulation.frame, digest);
    });

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

    const { x, y } = viewOrigin();
    // The original draws the mouse last, over everything else.
    const mouse = input.mouse && {
      x: x + input.mouse.x - cursor.hotX, y: y + input.mouse.y - cursor.hotY,
      region: cursor.region, remap: scene.plainRemap, shadow: false,
    };
    pipeline.setOverlay(mouse || null);
    pipeline.setTime(time - startTime);
    pipeline.render({ x, y, width: viewWidth, height: viewHeight }, scale);
  });

  return {
    setFlow(enabled) { if (flow) flow.enabled.value = enabled ? 1 : 0; },
    setPaused(value) { paused = value; clock.pause(); },
    dispose() {
      renderer.setFrame(null);
      input.dispose();
      document.removeEventListener('visibilitychange', visibility);
      checksum?.dispose();
      ground?.dispose();
      simulation?.dispose();
      pipeline.dispose();
    },
  };
}
