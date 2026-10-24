import { PalettePipeline } from '../engine/indexed/pipeline.ts';
import type { Renderer } from '../engine/renderer.ts';
import { CELL_LEPTONS, CELL_PIXELS, leptonToPixel, pixelToLepton } from './coord.ts';
import { loadData } from './data-files.ts';
import { ORIGINAL_MAP_SIZE } from './formats/scenario.ts';
import { GameInput, type ViewSize, type UnitInput } from './input.ts';
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
import { unitsScene } from './simulation/units-scene.ts';
import { GpuUnits } from './simulation/units-gpu.ts';
import { initialUnits, WORDS } from './simulation/units-state.ts';
import { GpuSight } from './simulation/sight.ts';
import { GpuSelection, type SelectionCommand } from './simulation/selection.ts';
import { UnitsView } from './simulation/units-view.ts';
import { UnitVoices } from './voices.ts';
import { MOVEMENT } from './data/movement.ts';

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
  setVision(enabled: boolean): void;
}

export interface GameOptions {
  simulation?: boolean;
  units?: boolean;
  onStats?: (frame: number, checksum: string) => void;
}

/** Loads the original data and shows scg08eb on the renderer's canvas. */
export async function startGame(renderer: Renderer, canvas: HTMLCanvasElement, options: GameOptions = {}): Promise<Game> {
  const data = await loadData(false, options.units);
  const unitDemo = options.units ? unitsScene(data) : undefined;
  const demo = options.simulation ? simulationScene(data) : undefined;
  const scene = unitDemo?.scene ?? demo?.scene ?? buildScene(data, SCENARIO);
  const simulation = demo && new GpuSimulation(renderer.three, demo.setup);
  const units = unitDemo && new GpuUnits(renderer.three, unitDemo.setup);
  const active = units ?? simulation;
  const sight = units && new GpuSight(renderer.three, units.setup.grid.width, units.setup.grid.height, units.units);
  const selection = units && sight && new GpuSelection(renderer.three, units, sight);
  const unitView = units && sight && selection && new UnitsView(renderer.three,units,sight,selection,scene,data);
  const voices = units && new UnitVoices(data);
  const layout = unitDemo ? groundLayout(scene, initialUnits(unitDemo.setup), WORDS, true) : demo && groundLayout(scene, unitState(demo.setup));
  const flow = simulation && flowOverlay(simulation);
  const spriteSize = scene.sprites.reduce((size, sprite) => ({
    maxWidth: Math.max(size.maxWidth, sprite.region.width), maxHeight: Math.max(size.maxHeight, sprite.region.height),
  }), {maxWidth:1,maxHeight:1});
  const pipeline = new PalettePipeline(renderer.three, { ...scene.setup, spriteCapacity: (layout?.count ?? scene.sprites.length) + 1,
    ...(layout && { dynamicSprites: spriteSize, overlay: unitView?.draw ?? flow!.draw }),
    ...(unitView && { indexEffect: unitView.indexEffect }) });
  const ground = active && layout && new GpuGround(renderer.three, active, pipeline, layout, unitDemo ? scene : undefined,
    selection && units ? {state:selection.state,offset:selection.flashOffset,clock:units.control}:undefined);
  const checksum = active && ground && new GpuChecksum(renderer.three,
    [...active.buffers(), ...(units ? [] : [ground.order.order]), ...(sight ? [sight.mapped] : [])]);
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
  let released = false, renderFrame = 0;
  let bandStart: {x:number;y:number} | null = null;
  const responses: {frame:number;value:Int32Array}[] = [];
  const act = (command: SelectionCommand) => {
    if (!selection) return;
    selection.apply(command);
    const frame = renderFrame;
    void selection.read().then(value => { if (!released) responses.push({frame,value}); });
  };
  let scale = 0;
  let bufferWidth = 1, bufferHeight = 1;
  // Center axes on which the entire map fits. Keep the scroll position in map coordinates and
  // the padding in whole image pixels so presentation, pointer placement and zoom share an origin.
  const padding = () => ({
    x: Math.max(0, Math.floor((view.width - scenario.width * CELL_PIXELS) / 2)),
    y: Math.max(0, Math.floor((view.height - scenario.height * CELL_PIXELS) / 2)),
  });
  const unitActions: UnitInput | undefined = unitView && selection ? {
    gesture() { voices?.unlock(); },
    down(position,button) {
      if (button === 2) { bandStart = null; act({action:'clear'}); }
      if (button === 0) { const origin=viewOrigin();bandStart={x:position.x+origin.x,y:position.y+origin.y}; }
    },
    up(position,button,shift) {
      if (button !== 0 || !bandStart) return;
      const origin=viewOrigin(),x=position.x+origin.x,y=position.y+origin.y;
      if(Math.abs(x-bandStart.x)>4 || Math.abs(y-bandStart.y)>4) act({action:'box',x:pixelToLepton(bandStart.x),y:pixelToLepton(bandStart.y),x2:pixelToLepton(x),y2:pixelToLepton(y)});
      else act({action:'point',x:pixelToLepton(x),y:pixelToLepton(y),modifier:shift?1:0});
      bandStart=null;
    },
    key(event) {
      voices?.unlock();
      const modifier=event.ctrlKey?2:event.altKey?3:event.shiftKey?1:0;
      if(/^Digit[0-9]$/.test(event.code)){act({action:'group',group:Number(event.code.slice(-1))-1,modifier});return true;}
      const key=event.key.toLowerCase();
      const action=key==='n'?'next':key==='s'?'stop':key==='x'?'scatter':key==='h'?'home':key==='home'?'center':null;
      if(action){act({action,modifier});return true;}return false;
    },
    release(){bandStart=null;},
  } : undefined;
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
  }, unitActions);

  let started = false;
  let lastTick = 0;
  let startTime = 0;
  let cursor: CursorImage = scene.cursors.normal;
  // The original-map viewer uploads static sprites once; the demo writes them on the GPU.
  if (!active) pipeline.setSprites(scene.sprites);

  renderer.setFrame((width, height, time) => {
    renderFrame++;
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

    if (active && ground && !paused && !document.hidden) clock.advance(time, () => {
      // Ported from CONQUER.CPP, Main_Loop: Sort precedes Logic.AI, so the new positions are
      // rendered with the order computed from the previous tick's positions.
      ground.sort();
      if (units) { units.step(); sight!.step(); }
      else simulation!.step(target === undefined ? [] : [{ frame: simulation!.frame + 1, target }]);
      target = undefined;
      ground.updateSprites();
      if (active.frame % 15 === 0 && checksum) readback.request(active.frame, () => checksum.read());
      const completed = readback.take(active.frame);
      if (completed) digest = Array.from(completed.value, word => word.toString(16).padStart(8, '0')).join('');
      options.onStats?.(active.frame, digest);
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
    while(responses.length && responses[0].frame < renderFrame){
      const {value}=responses.shift()!;
      if(value[0]>=0 && unitDemo){
        const placed=unitDemo.setup.units[value[0]],type=MOVEMENT[placed.type];
        if(value[2]) voices?.play(type.name,!!type.infantry,type.infantry?value[0]-scene.scenario.units.length:value[0],value[2]===2,active!.frame);
        if(value[7]) scroller.setPosition(Math.floor((value[3]+value[5])/2)-pixelToLepton(view.width/2),Math.floor((value[4]+value[6])/2)-pixelToLepton(view.height/2));
      }
    }
    // The original draws the mouse last, over everything else.
    const mouse = input.mouse && {
      x: x + input.mouse.x - cursor.hotX, y: y + input.mouse.y - cursor.hotY,
      region: cursor.region, remap: scene.plainRemap, shadow: false,
    };
    if(unitView){
      unitView.pointer.value.set(input.mouse?x+input.mouse.x:-1,input.mouse?y+input.mouse.y:-1);
      unitView.time.value=Math.floor(time-startTime);
      unitView.shift.value=input.shift?1:0;
      const pointerIndex=scene.cursors.scroll.indexOf(cursor),blockedIndex=scene.cursors.blocked.indexOf(cursor);
      unitView.cursor.value=pointerIndex>=0?pointerIndex+1:blockedIndex>=0?blockedIndex+130:-1;
      if(bandStart && input.mouse && (Math.abs(x+input.mouse.x-bandStart.x)>4 || Math.abs(y+input.mouse.y-bandStart.y)>4))
        unitView.band.value.set(bandStart.x,bandStart.y,x+input.mouse.x,y+input.mouse.y);
      else unitView.band.value.set(-1,-1,-1,-1);
      unitView.update();pipeline.setOverlay(null);
    }else pipeline.setOverlay(mouse || null);
    pipeline.setTime(time - startTime);
    pipeline.render({ x, y, width: viewWidth, height: viewHeight }, scale);
  });

  return {
    setFlow(enabled) { if (flow) flow.enabled.value = enabled ? 1 : 0; if(unitView) unitView.flow.value=enabled?1:0; },
    setVision(enabled) { if(unitView) unitView.vision.value=enabled?1:0; },
    setPaused(value) { paused = value; clock.pause(); },
    dispose() {
      released=true;
      renderer.setFrame(null);
      input.dispose();
      document.removeEventListener('visibilitychange', visibility);
      checksum?.dispose();
      ground?.dispose();
      simulation?.dispose();
      units?.dispose();sight?.dispose();selection?.dispose();unitView?.dispose();voices?.dispose();
      pipeline.dispose();
    },
  };
}
