import { PalettePipeline } from '../engine/indexed/pipeline.ts';
import { finishGpuSetup, type Renderer, type FrameCallback } from '../engine/renderer.ts';
import { Vector2 } from 'three/webgpu';
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
import { GpuCombat } from './simulation/combat-gpu.ts';
import { combatScene } from './simulation/combat-scene.ts';
import { CombatView, combatExtraSprites } from './simulation/combat-view.ts';
import { CombatAudio } from './simulation/combat-audio.ts';
import { MOVEMENT } from './data/movement.ts';
import { GpuAircraft } from './simulation/aircraft-gpu.ts';
import { AircraftView } from './simulation/aircraft-view.ts';
import { economyScene } from './simulation/economy-scene.ts';
import { EconomyRuntime } from './simulation/economy-runtime.ts';
import { GpuTiberium } from './simulation/tiberium-gpu.ts';
import { BuildingView } from './simulation/building-view.ts';
import { Sidebar } from './sidebar.ts';
import { GpuHarvest } from './simulation/harvest-gpu.ts';
import { Eva } from './eva.ts';
import { GpuAirOperations } from './simulation/air-operations-gpu.ts';
import { GpuTransport } from './simulation/transport-gpu.ts';
import { Radar } from './radar.ts';
import { ConstructionPreview } from './construction-preview.ts';
import { GpuServices } from './simulation/services-gpu.ts';
import { LaserView } from './simulation/laser-view.ts';
import { GpuBuildingEffects } from './simulation/building-effects-gpu.ts';
import { buildingEffectCapacity } from './simulation/building-effects-state.ts';

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
  setWaves(enabled:boolean):void;
  setDensity(enabled:boolean):void;
  setProductionSpeed(speed:1|10|100):void;
}

export interface GameOptions {
  simulation?: boolean;
  units?: boolean;
  combat?: boolean;
  buildings?:boolean;
  economy?:boolean;
  faction?:number;
  onProgress?: (message: string) => void | Promise<void>;
  onStats?: (frame: number, checksum: string) => void;
}

/** Loads the original data and shows scg08eb on the renderer's canvas. */
export async function startGame(renderer: Renderer, canvas: HTMLCanvasElement, options: GameOptions = {}): Promise<Game> {
  await options.onProgress?.('Loading game files');
  const economic=options.buildings||options.economy;
  const data = await loadData(false, options.units || options.combat || economic, economic);
  await options.onProgress?.('Building the battlefield');
  const baseDemo=economic?economyScene(data,!!options.buildings):undefined;
  const battleDemo = baseDemo ?? (options.combat ? combatScene(data) : options.units ? unitsScene(data,true,true) : undefined);
  const unitDemo = battleDemo ?? (options.units ? unitsScene(data) : undefined);
  const demo = options.simulation ? simulationScene(data) : undefined;
  const scene = unitDemo?.scene ?? demo?.scene ?? buildScene(data, SCENARIO);
  await options.onProgress?.('Preparing units and controls');
  const battle = battleDemo && new GpuCombat(renderer.three, battleDemo.setup);
  const simulation = demo && new GpuSimulation(renderer.three, demo.setup);
  const units = battle?.movement ?? (unitDemo && new GpuUnits(renderer.three, unitDemo.setup));
  const aircraft=units&&unitDemo?.setup.units.some(unit=>MOVEMENT[unit.type].domain===1)?new GpuAircraft(units):undefined;
  const airOperations=battle&&aircraft?new GpuAirOperations(battle,aircraft,baseDemo?.playable??Int32Array.from({length:battle.setup.grid.edges.length},()=>1)):undefined;
  const active = battle ?? units ?? simulation;
  const sight = battle?.sight ?? (units && new GpuSight(renderer.three, units.setup.grid.width, units.setup.grid.height, units.units));
  const selection = units && sight && new GpuSelection(renderer.three, units, sight, !!battle);
  const economy=battle&&baseDemo?new EconomyRuntime(battle,baseDemo,options.faction):undefined;
  if(economy&&aircraft)economy.lifecycle.useAircraft(aircraft.state);
  const transport=battle&&(aircraft||battle.setup.units.some(unit=>MOVEMENT[unit.type].name==='APC'))?new GpuTransport(battle,aircraft,baseDemo?.playable??Int32Array.from({length:battle.setup.grid.edges.length},()=>1),economy?.transportState):undefined;
  const services=battle?new GpuServices(battle,economy?.serviceState):undefined;
  const ore=baseDemo?new GpuTiberium(renderer.three,baseDemo.tiberium,units?.occupancy):undefined;
  if(ore&&battle&&baseDemo)ore.connect(battle,baseDemo.baseLand,()=>economy!.placement.bibs);
  const harvest=economy&&ore?new GpuHarvest(economy,ore):undefined;
  if(economy&&ore)economy.lifecycle.validateTerrain(ore.amount);
  const construction=economy&&ore?new ConstructionPreview(economy,ore):undefined;
  const lasers=economy?new LaserView(economy.battle,scene.setup.palette):undefined;
  const radar=economy&&ore?new Radar(economy,ore,data):undefined;
  const sidebar=economy?new Sidebar(economy,data,radar):undefined;
  const eva=economy?new Eva(data):undefined;
  if(economy&&eva)economy.onEvent=name=>eva.speak(name);
  await selection?.prepare();
  if (battle) {battle.movement.enableOccupancyEdits();await battle.prepareForPlay();}
  else await units?.prepareForPlay();
  if(aircraft)await renderer.three.compileComputeAsync(aircraft.kernels);
  if(airOperations)await renderer.three.compileComputeAsync([...airOperations.beforePass,airOperations.afterPass]);
  if(transport)await renderer.three.compileComputeAsync(transport.kernels);
  if(services)await renderer.three.compileComputeAsync(services.kernels);
  if(harvest)await renderer.three.compileComputeAsync(harvest.kernels);
  await ore?.prepareForPlay();
  await economy?.lifecycle.prepareForPlay();
  await economy?.report.prepareForPlay();
  await options.onProgress?.('Preparing graphics and sound');
  const unitView = units && sight && selection && new UnitsView(renderer.three,units,sight,selection,scene,data,!!battle,
    battle?{combat:battle.state,transport:transport?.state,mining:economy?.miningState,buildings:economy?.visuals}:undefined);
  const combatAudio = battle && new CombatAudio(renderer.three, battle, data);
  const voices = units && new UnitVoices(data);
  await combatAudio?.prepareForPlay();
  const layout = unitDemo ? groundLayout(scene, initialUnits(unitDemo.setup), WORDS, true) : demo && groundLayout(scene, unitState(demo.setup));
  const flow = simulation && flowOverlay(simulation);
  const spriteSize = [...scene.sprites, ...[...(scene.animation?.frames.values() ?? [])].flat().map(region => ({region}))].reduce((size, sprite) => ({
    maxWidth: Math.max(size.maxWidth, sprite.region.width), maxHeight: Math.max(size.maxHeight, sprite.region.height),
  }), {maxWidth:1,maxHeight:1});
  const effectCapacity=economy?buildingEffectCapacity(economy.battle.setup.units.length):0;
  const pipeline = new PalettePipeline(renderer.three, { ...scene.setup, spriteCapacity: (layout?.count ?? scene.sprites.length) + 1 + (battle ? combatExtraSprites(battle.setup,scene) : 0)+effectCapacity,
    ...(layout && { dynamicSprites: spriteSize, overlay: sidebar&&unitView ? (pixel,color)=>{
      let out=lasers?lasers.draw(pixel,color):color;out=radar?radar.densityDraw(pixel,out):out;if(construction)out=construction.draw(pixel,out);return sidebar.draw(pixel,unitView.draw(pixel,out));
    } : unitView?.draw ?? flow!.draw }),
    ...(unitView && { indexEffect: unitView.indexEffect }) });
  const ground = active && layout && new GpuGround(renderer.three, active, pipeline, layout, unitDemo ? scene : undefined,
    selection && units ? {state:selection.state,offset:selection.flashOffset,clock:units.control}:undefined);
  const combatView = battle && ground && battleDemo && new CombatView(renderer.three, battle, ground, pipeline, scene, battleDemo.decalStart,!!economy);
  const buildingEffects=economy&&combatView?new GpuBuildingEffects(economy.battle,scene.animation!.frames,combatView.smudges):undefined;
  if(buildingEffects&&combatView){buildingEffects.setView(pipeline,scene,combatView.count);await buildingEffects.prepareForPlay();}
  const aircraftView=aircraft&&ground?new AircraftView(aircraft,ground,pipeline,scene):undefined;
  const buildingView=economy&&ground&&ore?new BuildingView(economy,ground,pipeline,ore):undefined;
  buildingView?.update();aircraftView?.update();buildingEffects?.update();
  if(ground)pipeline.updateGpuSprites((combatView?.count??ground.layout.count)+effectCapacity);
  const checksum = active && ground && new GpuChecksum(renderer.three,
    [...active.buffers(), ...(aircraft?[aircraft.state]:[]), ...(ore?ore.buffers():[]), ...(economy?[economy.miningState]:[]), ...(transport?[transport.state]:[]), ...(services?[services.state]:[]), ...(units ? [] : [ground.order.order]), ...(sight && !battle ? [sight.mapped] : [])]);
  // Compile the periodic diagnostic before play, alongside the first selection.
  await checksum?.read();
  const clock = new SimulationClock(LOGIC_HZ);
  const readback = new DelayedReadback<Uint32Array>();
  let paused = false, target: number | undefined, digest = '';
  let shakeUntil = 0;
  if (combatAudio) combatAudio.onShake = () => { shakeUntil=performance.now()+100; };
  const visibility = () => { clock.pause(); };
  document.addEventListener('visibilitychange', visibility);
  const { scenario } = scene;
  const mapWidth=units?.setup.grid.width??demo?.setup.grid.width??ORIGINAL_MAP_SIZE;
  const scroller = new Scroller(scenario);
  if(sidebar)sidebar.onRadarCell=cell=>scroller.setPosition((cell%mapWidth)*256-pixelToLepton(view.width-160)/2,Math.trunc(cell/mapWidth)*256-pixelToLepton(view.height)/2);
  const palette = new PaletteCycle(scene.setup.palette);

  // Ported from CONQUER.CPP, Handle_View: a bookmark keeps the cell under the view's top-left corner,
  // and jumping to it puts the view's corner at that cell's corner. All four start at the home cell
  // (DisplayClass::Read_INI).
  const bookmarks = [scene.home, scene.home, scene.home, scene.home];
  const jumpTo = (cell: number) => scroller.setPosition((cell % mapWidth) * CELL_LEPTONS,
    Math.floor(cell / mapWidth) * CELL_LEPTONS);

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
    gesture() { voices?.unlock(); combatAudio?.unlock(); eva?.unlock(); },
    down(position,button) {
      if(sidebar&&position.x>=view.width-160)return;
      if (button === 2) { bandStart = null; act({action:'clear'}); }
      if(button===2)economy?.cancelPlacement();
      if (button === 0) { const origin=viewOrigin();bandStart={x:position.x+origin.x,y:position.y+origin.y}; }
    },
    up(position,button,shift,ctrl) {
      if(sidebar?.hit(position.x,position.y,button)){bandStart=null;return;}
      if (button !== 0 || !bandStart) return;
      const origin=viewOrigin(),x=position.x+origin.x,y=position.y+origin.y;
      if(economy?.click(Math.floor(y/24)*mapWidth+Math.floor(x/24))){bandStart=null;return;}
      if(Math.abs(x-bandStart.x)>4 || Math.abs(y-bandStart.y)>4) act({action:'box',x:pixelToLepton(bandStart.x),y:pixelToLepton(bandStart.y),x2:pixelToLepton(x),y2:pixelToLepton(y)});
      else act({action:'point',x:pixelToLepton(x),y:pixelToLepton(y),modifier:ctrl?2:shift?1:0});
      bandStart=null;
    },
    key(event) {
      voices?.unlock();
      eva?.unlock();
      const modifier=event.ctrlKey?2:event.altKey?3:event.shiftKey?1:0;
      if(/^Digit[0-9]$/.test(event.code)){act({action:'group',group:Number(event.code.slice(-1))-1,modifier});return true;}
      const key=event.key.toLowerCase();
      if(key==='d'&&economy){economy.deploy();return true;}
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
    scroller.setViewSize(view.width-(sidebar?160:0), view.height);
    input.resize(previous);
  };
  const input = new GameInput(canvas, () => view, (index, record) => {
    if (record) {
      const cellX = Math.floor(scroller.x / CELL_LEPTONS);
      bookmarks[index] = Math.floor(scroller.y / CELL_LEPTONS) * mapWidth + cellX;
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

  const drawFrame: FrameCallback = (width, height, time) => {
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
      if(economy&&!economy.beginTick())return false;
      // Ported from CONQUER.CPP, Main_Loop: Sort precedes Logic.AI, so the new positions are
      // rendered with the order computed from the previous tick's positions.
      ground.sort();
      battle?.movement.beginOccupancyEdits();
      ore?.step();
      transport?.step();
      services?.step(economy?.house.money??0);
      harvest?.step();
      airOperations?.before();
      aircraft?.step();
      battle?.movement.endOccupancyEdits();
      if (battle) battle.step();
      else if (units) { units.step(); sight!.step(); }
      else simulation!.step(target === undefined ? [] : [{ frame: simulation!.frame + 1, target }]);
      airOperations?.after();
      if(battle)ore?.damage(battle.frame);
      if(aircraft)ground.transitionLayers();
      target = undefined;
      if(buildingEffects)battle!.movement.beginOccupancyEdits();
      buildingEffects?.step();
      if(buildingEffects)battle!.movement.endOccupancyEdits();
      ground.updateSprites(false); combatView?.update(false);buildingView?.update();aircraftView?.update();buildingEffects?.update();
      pipeline.updateGpuSprites((combatView?.count??ground.layout.count)+effectCapacity);
      economy?.endTick();sidebar?.update();
      eva?.step();
      combatAudio?.update(scroller.x, scroller.y, pixelToLepton(view.width), pixelToLepton(view.height));
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
        economy?.select(value[0]);
        if(value[2]===4)economy?.deploy();
        if(value[2]===5)economy?.selectPrimary(value[0]);
        const placed=unitDemo.setup.units[value[0]],type=MOVEMENT[economy?.types[value[0]]??placed.type];
        if(value[2]>0&&value[2]<=3&&type.domain!==2) voices?.play(type.name,!!type.infantry,type.infantry?value[0]-scene.scenario.units.length:value[0],value[2],active!.frame);
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
      unitView.shift.value=input.shift?1:0;unitView.ctrl.value=input.ctrl?1:0;
      const pointerIndex=scene.cursors.scroll.indexOf(cursor),blockedIndex=scene.cursors.blocked.indexOf(cursor);
      unitView.cursor.value=pointerIndex>=0?pointerIndex+1:blockedIndex>=0?blockedIndex+130:-1;
      if(bandStart && input.mouse && (Math.abs(x+input.mouse.x-bandStart.x)>4 || Math.abs(y+input.mouse.y-bandStart.y)>4))
        unitView.band.value.set(bandStart.x,bandStart.y,x+input.mouse.x,y+input.mouse.y);
      else unitView.band.value.set(-1,-1,-1,-1);
      unitView.update();pipeline.setOverlay(null);
    }else pipeline.setOverlay(mouse || null);
    pipeline.setTime(time - startTime);
    if(sidebar){sidebar.origin.value.set(x,y);sidebar.viewport.value.set(view.width,view.height);sidebar.pointer.value.set(input.mouse?input.mouse.x-view.width+160:-100,input.mouse?.y??-100);}
    radar?.update(x,y,view.width-160,view.height);
    lasers?.update(x,y,view.width,view.height);
    construction?.update(input.mouse&&input.mouse.x<view.width-160?input.mouse.x+x:-100,input.mouse?input.mouse.y+y:-100);
    // UNIT.CPP Take_Damage requests three shakes. The visual offset is local UI state.
    canvas.style.transform=time<shakeUntil?`translateY(${Math.ceil((shakeUntil-time)*60/1000)%2?2:-2}px)`:'';
    pipeline.render({ x, y, width: viewWidth, height: viewHeight }, scale);
  };

  await options.onProgress?.('Drawing the battlefield');
  const size = renderer.three.getDrawingBufferSize(new Vector2());
  drawFrame(size.x, size.y, performance.now());
  await finishGpuSetup(renderer.three);
  clock.pause();
  renderer.setFrame(drawFrame);

  return {
    setFlow(enabled) { if (flow) flow.enabled.value = enabled ? 1 : 0; if(unitView) unitView.flow.value=enabled?1:0; },
    setVision(enabled) { if(unitView) unitView.vision.value=enabled?1:0; },
    setPaused(value) { paused = value; clock.pause(); },
    setWaves(value){if(economy)economy.waves=value;},
    setDensity(value){if(radar)radar.densityEnabled.value=Number(value);},
    setProductionSpeed(value){economy?.setProductionSpeed(value);},
    dispose() {
      released=true;
      renderer.setFrame(null);
      input.dispose();
      document.removeEventListener('visibilitychange', visibility);
      checksum?.dispose();
      ground?.dispose();
      aircraftView?.dispose();aircraft?.dispose();
      airOperations?.dispose();
      transport?.dispose();
      services?.dispose();
      buildingEffects?.dispose();buildingView?.dispose();harvest?.dispose();ore?.dispose();sidebar?.dispose();economy?.dispose();
      eva?.dispose();
      radar?.dispose();
      construction?.dispose();
      lasers?.dispose();
      simulation?.dispose();
      canvas.style.transform='';combatView?.dispose();combatAudio?.dispose();battle?.dispose();
      if (!battle) { units?.dispose(); sight?.dispose(); } selection?.dispose();unitView?.dispose();voices?.dispose();
      pipeline.dispose();
    },
  };
}
