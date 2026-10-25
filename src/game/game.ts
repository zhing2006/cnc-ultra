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
import { PlaybackPresentation } from './playback-presentation.ts';
import { initialZoom, MAX_ZOOM, zoomOrigin } from './zoom.ts';
import { DelayedReadback } from '../engine/simulation/clock.ts';
import { SimulationDriver } from '../engine/simulation/driver.ts';
import { batchCompute } from '../engine/compute-batch.ts';
import { GpuSimulation } from '../engine/simulation/gpu.ts';
import { GpuChecksum } from '../engine/simulation/checksum.ts';
import { unitState } from '../engine/simulation/state.ts';
import type { PreparedGame } from './game-setup.ts';
import type { MixSet } from './formats/mix.ts';
import type { EconomySetup } from './simulation/economy-setup.ts';
import { GpuGround, groundLayout } from './simulation/ground.ts';
import { flowOverlay } from './simulation/overlay.ts';
import { LOGIC_HZ } from './simulation/map.ts';
import { initialUnits, WORDS } from './simulation/units-state.ts';
import { GpuSight } from './simulation/sight.ts';
import { SightView, type SightPerspective } from './simulation/sight-view.ts';
import { GpuSelection, type SelectionCommand } from './simulation/selection.ts';
import { UnitsView } from './simulation/units-view.ts';
import { UnitVoices } from './voices.ts';
import { GpuCombat } from './simulation/combat-gpu.ts';
import { CombatView, combatExtraSprites } from './simulation/combat-view.ts';
import { CombatAudio } from './simulation/combat-audio.ts';
import { MOVEMENT } from './data/movement.ts';
import { GpuAircraft } from './simulation/aircraft-gpu.ts';
import { AircraftView } from './simulation/aircraft-view.ts';
import { EconomyRuntime } from './simulation/economy-runtime.ts';
import { GpuTiberium } from './simulation/tiberium-gpu.ts';
import { BuildingView } from './simulation/building-view.ts';
import { Sidebar } from './sidebar.ts';
import { GpuHarvest } from './simulation/harvest-gpu.ts';
import { Eva, hearHouseEvent } from './eva.ts';
import { GpuAirOperations } from './simulation/air-operations-gpu.ts';
import { GpuTransport } from './simulation/transport-gpu.ts';
import { Radar } from './radar.ts';
import { ConstructionPreview } from './construction-preview.ts';
import { GpuServices } from './simulation/services-gpu.ts';
import { LaserView } from './simulation/laser-view.ts';
import { GpuBuildingEffects } from './simulation/building-effects-gpu.ts';
import { buildingEffectCapacity } from './simulation/building-effects-state.ts';
import { SuperView } from './simulation/super-view.ts';
import { CloakView } from './simulation/cloak-view.ts';
import { stepBattle } from './simulation/tick.ts';
import { SUPER_SPRITES } from './simulation/super-weapons.ts';
import { adjustGamePalette, type GamePreferences } from './options.ts';
import { validDebugState, type DebugState, type DebugSpeed } from './debug.ts';

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
  setPerspective(perspective: SightPerspective): void;
  setDensity(enabled:boolean):void;
  setSimulationSpeed(speed:1|10|100):void;
  setController(owner:number|null):void;
  setPreferences(preferences: GamePreferences): void;
  canDebug(): boolean;
  isPaused(): boolean;
  readDebugState(): Promise<DebugState>;
  applyDebugState(value: DebugState): void;
  saveState(): Promise<GameState>;
  loadState(saved: GameState): void;
}

export interface GameState {
  frame: number;
  economy: Awaited<ReturnType<EconomyRuntime['saveState']>>;
  camera: { x: number; y: number; scale: number; bookmarks: number[] };
  buffers: Uint8Array[];
  debug?: { gameSpeed: DebugSpeed };
}

export interface GameOptions {
  createEconomy?: (battle: GpuCombat, setup: EconomySetup, faction?: number) => EconomyRuntime;
  onProgress?: (message: string) => void | Promise<void>;
  onStats?: (frame: number, checksum: string) => void;
  onSpeed?: (actual: number) => void;
  onOutcome?: (winner: number) => void;
  onOptions?: () => void;
}

/** Loads the original data and shows scg08eb on the renderer's canvas. */
export async function startGame(renderer: Renderer, canvas: HTMLCanvasElement, options: GameOptions = {}): Promise<Game> {
  await options.onProgress?.('Loading game files');
  const data = await loadData();
  await options.onProgress?.('Building the battlefield');
  return startPreparedGame(renderer, canvas, data, { kind: 'map', scene: buildScene(data, SCENARIO) }, options);
}

/** Runs a prepared scenario without knowing which menu, campaign or diagnostic selected it. */
export async function startPreparedGame(renderer: Renderer, canvas: HTMLCanvasElement, data: MixSet,
  world: PreparedGame, options: GameOptions = {}): Promise<Game> {
  const combatSetup = world.kind === 'combat' ? world : undefined;
  const simulationSetup = world.kind === 'simulation' ? world : undefined;
  const economySetup = combatSetup?.economy;
  const { scene } = world;
  await options.onProgress?.('Preparing units and controls');
  const battle = combatSetup && new GpuCombat(renderer.three, combatSetup.setup);
  const simulation = simulationSetup && new GpuSimulation(renderer.three, simulationSetup.setup);
  const units = battle?.movement;
  const aircraft=units&&combatSetup?.setup.units.some(unit=>MOVEMENT[unit.type].domain===1)?new GpuAircraft(units):undefined;
  const airOperations=battle&&aircraft?new GpuAirOperations(battle,aircraft,economySetup?.playable??Int32Array.from({length:battle.setup.grid.edges.length},()=>1)):undefined;
  const active = battle ?? simulation;
  const sight = battle?.sight;
  const opposingSight = units && new GpuSight(renderer.three, units.setup.grid.width, units.setup.grid.height, units.units, 1, units.setup.bounds);
  const perspective = sight && opposingSight && new SightView(sight, opposingSight);
  const controlSight = sight && opposingSight && new SightView(sight, opposingSight);
  const selection = units && controlSight && new GpuSelection(renderer.three, units, controlSight, true);
  const economy=battle&&economySetup?(options.createEconomy?.(battle,economySetup,combatSetup?.faction)??new EconomyRuntime(battle,economySetup,combatSetup?.faction)):undefined;
  let controlledOwner = economy ? economy.controlledOwner : 0;
  selection?.setOwner(controlledOwner??-1);
  if(economy&&aircraft)economy.lifecycle.useAircraft(aircraft.state);
  const transport=battle&&(aircraft||battle.setup.units.some(unit=>MOVEMENT[unit.type].name==='APC'))?new GpuTransport(battle,aircraft,economySetup?.playable??Int32Array.from({length:battle.setup.grid.edges.length},()=>1),economy?.transportState):undefined;
  const services=battle?new GpuServices(battle,economy?.serviceState):undefined;
  const ore=economySetup?new GpuTiberium(renderer.three,economySetup.tiberium,units?.occupancy):undefined;
  if(ore&&battle&&economySetup)ore.connect(battle,economySetup.baseLand,()=>economy!.placement.bibs);
  const harvest=economy&&ore?new GpuHarvest(economy,ore):undefined;
  if(economy&&ore)economy.lifecycle.validateTerrain(ore.amount);
  const construction=economy&&ore?new ConstructionPreview(economy,ore):undefined;
  const lasers=economy?new LaserView(economy.battle,scene.setup.palette):undefined;
  const radar=economy&&ore?new Radar(economy,ore,data,perspective):undefined;
  const sidebar=economy?new Sidebar(economy,data,radar):undefined;
  if (sidebar) sidebar.onOptions = options.onOptions;
  const eva=economy?new Eva(data):undefined;
  if(economy&&eva)economy.onEvent=(name,owner)=>{if(hearHouseEvent(name,owner,economy.controlledOwner))eva.speak(name);};
  await selection?.prepare();
  if (battle) {battle.movement.enableOccupancyEdits();await battle.prepareForPlay();}
  if(aircraft)await renderer.three.compileComputeAsync(aircraft.kernels);
  if(airOperations)await renderer.three.compileComputeAsync([...airOperations.beforePass,airOperations.afterPass]);
  if(transport)await renderer.three.compileComputeAsync(transport.kernels);
  if(services)await renderer.three.compileComputeAsync(services.kernels);
  if(harvest)await renderer.three.compileComputeAsync(harvest.kernels);
  await ore?.prepareForPlay();
  await economy?.prepareForPlay();
  await options.onProgress?.('Preparing graphics and sound');
  const unitView = units && sight && selection && new UnitsView(renderer.three,units,sight,selection,scene,data,!!battle,
    battle?{combat:battle.state,transport:transport?.state,mining:economy?.miningState,buildings:economy?.visuals}:undefined,perspective);
  const combatAudio = battle && new CombatAudio(renderer.three, battle, data, selection?.state);
  const voices = units && new UnitVoices(data);
  await combatAudio?.prepareForPlay();
  const layout = combatSetup ? groundLayout(scene, initialUnits(combatSetup.setup), WORDS, true) : simulationSetup && groundLayout(scene, unitState(simulationSetup.setup));
  const flow = simulation && flowOverlay(simulation);
  const spriteSize = [...scene.sprites, ...[...(scene.animation?.frames.values() ?? [])].flat().map(region => ({region}))].reduce((size, sprite) => ({
    maxWidth: Math.max(size.maxWidth, sprite.region.width), maxHeight: Math.max(size.maxHeight, sprite.region.height),
  }), {maxWidth:1,maxHeight:1});
  const effectCapacity=economy?buildingEffectCapacity(economy.battle.setup.units.length):0;
  const superCapacity=economy?SUPER_SPRITES:0;
  const pipeline = new PalettePipeline(renderer.three, { ...scene.setup, spriteCapacity: (layout?.count ?? scene.sprites.length) + 1 + (battle ? combatExtraSprites(battle.setup,scene) : 0)+effectCapacity+superCapacity,
    ...(layout && { dynamicSprites: spriteSize, overlay: sidebar&&unitView ? (pixel,color)=>{
      let out=lasers?lasers.draw(pixel,color):color;out=radar?radar.densityDraw(pixel,out):out;if(construction)out=construction.draw(pixel,out);return sidebar.draw(pixel,unitView.draw(pixel,out));
    } : unitView?.draw ?? flow!.draw }),
    ...(unitView && { indexEffect: unitView.indexEffect }) });
  const ground = active && layout && new GpuGround(renderer.three, active, pipeline, layout, combatSetup ? scene : undefined,
    selection && units ? {state:selection.state,offset:selection.flashOffset,clock:units.control}:undefined);
  if(economy&&ground)economy.onSceneryVisibility=(sprite,visible)=>ground.setStaticSpriteVisible(sprite,visible);
  const combatView = battle && ground && combatSetup && new CombatView(renderer.three, battle, ground, pipeline, scene, combatSetup.decalStart,!!economy);
  const buildingEffects=economy&&combatView?new GpuBuildingEffects(economy.battle,scene.animation!.frames,combatView.smudges):undefined;
  if(buildingEffects&&combatView){buildingEffects.setView(pipeline,scene,combatView.count);await buildingEffects.prepareForPlay();}
  const aircraftView=aircraft&&ground?new AircraftView(aircraft,ground,pipeline,scene):undefined;
  const buildingView=economy&&ground&&ore?new BuildingView(economy,ground,pipeline,ore):undefined;
  const superView=economy&&combatView?new SuperView(economy,pipeline,scene,combatView.count+effectCapacity):undefined;
  const cloakView=battle&&ground&&perspective&&ground.layout.slots>=3?new CloakView(battle,ground,pipeline,perspective):undefined;
  buildingView?.update();aircraftView?.update();buildingEffects?.update();superView?.update();cloakView?.update();
  if(ground)pipeline.updateGpuSprites((combatView?.count??ground.layout.count)+effectCapacity+superCapacity);
  const battleSystems=battle?{battle,economy,ore,transport,services,harvest,aircraft,airOperations,opposingSight,buildingEffects}:undefined;
  const saveBuffers = [...new Set([
    ...(battle?.saveBuffers ?? []), ...(opposingSight?.saveBuffers ?? []), ...(ore?.saveBuffers ?? []),
    ...(economy ? [economy.miningState,economy.transportState,economy.serviceState,economy.visuals,...economy.report.saveBuffers,...economy.extraSimulationBuffers] : []),
    ...(aircraft ? [aircraft.state] : []), ...(airOperations?.saveBuffers ?? []), ...(selection?.saveBuffers ?? []), ...(combatView?.saveBuffers ?? []), ...(buildingEffects?.saveBuffers ?? []),
  ])];
  const afterFlight=()=>{if(aircraft)ground?.transitionLayers();};
  const checksum = active && ground && new GpuChecksum(renderer.three,
    [...active.buffers(), ...(aircraft?[aircraft.state]:[]), ...(ore?ore.buffers():[]), ...(economy?[economy.miningState,...economy.extraSimulationBuffers]:[]), ...(transport?[transport.state]:[]), ...(services?[services.state]:[]), ...(units ? [] : [ground.order.order])]);
  // Compile the periodic diagnostic before play, alongside the first selection.
  await checksum?.read();
  const driver = new SimulationDriver(LOGIC_HZ, stepSimulation);
  const presentation = new PlaybackPresentation();
  const readback = new DelayedReadback<Uint32Array>();
  let paused = false, digest = '', spritesDirty = false;
  let simulationSpeed:1|10|100 = 1;
  let debugPace: DebugSpeed | undefined;
  let gamePace = 1;
  let sampleTime = 0, sampleFrame = 0;
  let shakeUntil = 0;
  let nuclearFlash:{phase:'rise'|'peak'|'fall';elapsed:number;last:number}|undefined;
  let flashIntensity=0;
  const flashPalette=new Uint8Array(scene.setup.palette.length);
  if (combatAudio) combatAudio.onShake = () => { shakeUntil=performance.now()+100; };
  const syncPlayback = () => {
    const stopped = paused || document.hidden;
    driver.setPaused(stopped||!!nuclearFlash&&nuclearFlash.phase!=='peak');
    presentation.configure(simulationSpeed, stopped);
    const muted = stopped || simulationSpeed !== 1;
    combatAudio?.setMuted(muted); voices?.setMuted(muted); eva?.setMuted(muted);
    if (muted) shakeUntil = 0;
    sampleTime = 0;
    options.onSpeed?.(0);
  };
  const visibility = syncPlayback;
  syncPlayback();
  document.addEventListener('visibilitychange', visibility);
  const { scenario } = scene;
  const mapWidth=units?.setup.grid.width??simulationSetup?.setup.grid.width??ORIGINAL_MAP_SIZE;
  const scroller = new Scroller(scenario);
  if(economy){
    economy.onSound=(name,x,y)=>combatAudio?.playExternal(name,x,y,{x:scroller.x,y:scroller.y,width:pixelToLepton(view.width),height:pixelToLepton(view.height)});
    economy.onShake=()=>{if(simulationSpeed===1&&!paused)shakeUntil=performance.now()+150;};
    // ANIM.CPP Middle blocks simulation for the 30/15 ticks of nuclear palette fades.
    economy.onNuclearFlash=phase=>{nuclearFlash={phase,elapsed:0,last:performance.now()};input.enabled=false;syncPlayback();};
  }
  if(sidebar){sidebar.onRadarCell=cell=>scroller.setPosition((cell%mapWidth)*256-pixelToLepton(view.width-sidebar.width)/2,Math.trunc(cell/mapWidth)*256-pixelToLepton(view.height)/2);sidebar.onResize=()=>resize();}
  const palette = new PaletteCycle(scene.setup.palette);

  // Ported from CONQUER.CPP, Handle_View: a bookmark keeps the cell under the view's top-left corner,
  // and jumping to it puts the view's corner at that cell's corner. All four start at the home cell
  // (DisplayClass::Read_INI).
  const bookmarks = [scene.home, scene.home, scene.home, scene.home];
  const jumpTo = (cell: number) => scroller.setPosition((cell % mapWidth) * CELL_LEPTONS,
    Math.floor(cell / mapWidth) * CELL_LEPTONS);

  let view: ViewSize = { width: 1, height: 1, scale: 1 };
  let released = false, renderFrame = 0, inputEpoch = 0;
  let bandStart: {x:number;y:number} | null = null;
  const responses: {frame:number;value:Int32Array;voiceEpoch:number|undefined}[] = [];
  const act = (command: SelectionCommand) => {
    if (!selection || controlledOwner === null) return;
    selection.apply(command);
    const frame = renderFrame, voiceEpoch = voices?.epoch, epoch = inputEpoch;
    void selection.read().then(value => { if (!released && epoch === inputEpoch) responses.push({frame,value,voiceEpoch}); });
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
    interfaceClick(position,button) { return controlledOwner!==null && (sidebar?.hit(position.x,position.y,button)??false); },
    down(position,button) {
      if(controlledOwner===null)return;
      if(sidebar?.contains(position.x,position.y))return;
      if (button === 2) { bandStart = null; act({action:'clear'}); }
      if(button===2)economy?.cancelPlacement();
      if (button === 0) { const origin=viewOrigin();bandStart={x:position.x+origin.x,y:position.y+origin.y}; }
    },
    up(position,button,shift,ctrl) {
      if(controlledOwner===null)return;
      if(sidebar?.hit(position.x,position.y,button)){bandStart=null;return;}
      if (button !== 0 || !bandStart) return;
      const origin=viewOrigin(),x=position.x+origin.x,y=position.y+origin.y;
      if(economy?.click(Math.floor(y/24)*mapWidth+Math.floor(x/24))){bandStart=null;return;}
      if(Math.abs(x-bandStart.x)>4 || Math.abs(y-bandStart.y)>4) act({action:'box',x:pixelToLepton(bandStart.x),y:pixelToLepton(bandStart.y),x2:pixelToLepton(x),y2:pixelToLepton(y)});
      else act({action:'point',x:pixelToLepton(x),y:pixelToLepton(y),modifier:ctrl?2:shift?1:0});
      bandStart=null;
    },
    key(event) {
      if(controlledOwner===null)return false;
      voices?.unlock();
      eva?.unlock();
      const modifier=event.ctrlKey?2:event.altKey?3:event.shiftKey?1:0;
      if(/^Digit[0-9]$/.test(event.code)){act({action:'group',group:Number(event.code.slice(-1))-1,modifier});return true;}
      const key=event.key.toLowerCase();
      if(key==='tab'&&sidebar&&!paused){sidebar.toggle();return true;}
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
    scroller.setViewSize(view.width-(sidebar?.width??0), view.height);
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
    if (!simulationSetup) return;
    const origin = viewOrigin(), x = Math.floor((position.x + origin.x) / CELL_PIXELS), y = Math.floor((position.y + origin.y) / CELL_PIXELS);
    const { width, height } = simulationSetup.setup.grid;
    if (x >= 0 && y >= 0 && x < width && y < height && simulationSetup.passable[y * width + x]) {
      simulationSetup.onMapClick(y * width + x);
    }
  }, unitActions);

  let started = false;
  let lastTick = 0;
  let startTime = 0;
  let cursor: CursorImage = scene.cursors.normal;
  // Static scenarios upload sprites once; an active simulation updates them on the GPU.
  if (!active) pipeline.setSprites(scene.sprites);

  function stepSimulation() {
    return batchCompute(renderer.three, () => {
      if (!active || !ground) return;
      if (economy && !economy.beginTick()) {
        if(economy.outcome!==undefined){paused=true;input.enabled=false;void document.exitPointerLock();syncPlayback();options.onOutcome?.(economy.outcome);}
        return false;
      }
      // Ported from CONQUER.CPP, Main_Loop: Sort precedes Logic.AI, so the new positions are
      // rendered with the order computed from the previous tick's positions.
      ground.sort();
      if(battleSystems)stepBattle(battleSystems,afterFlight);
      else simulation!.step(simulationSetup!.commands(simulation!.frame + 1));
      combatView?.step();
      buildingView?.step();
      spritesDirty = true;
      const completion = economy?.endTick();
      sidebar?.update(false);
      eva?.step();
      combatAudio?.update(scroller.x, scroller.y, pixelToLepton(view.width), pixelToLepton(view.height));
      if (active.frame % 15 === 0 && checksum) readback.request(active.frame, () => checksum.read());
      const completed = readback.take(active.frame);
      if (completed) digest = Array.from(completed.value, word => word.toString(16).padStart(8, '0')).join('');
      options.onStats?.(active.frame, digest);
      return completion;
    });
  }

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

    const paletteChanged=palette.update(time-startTime);
    if(nuclearFlash){
      const flash=nuclearFlash;
      if(!document.hidden)flash.elapsed+=Math.max(0,time-flash.last);
      flash.last=time;
      if(flash.phase==='rise'&&flash.elapsed>=500){flash.phase='peak';syncPlayback();}
      if(flash.phase==='fall'&&flash.elapsed>=250){nuclearFlash=undefined;input.enabled=!paused;syncPlayback();}
    }
    if(nuclearFlash||flashIntensity){
      flashIntensity=nuclearFlash?(nuclearFlash.phase==='peak'?1:nuclearFlash.phase==='rise'?Math.min(1,nuclearFlash.elapsed/500):Math.max(0,1-nuclearFlash.elapsed/250)):0;
      for(let i=0;i<flashPalette.length;i++)flashPalette[i]=i%4===3?255:Math.round(palette.colors[i]+(252-palette.colors[i])*flashIntensity);
      pipeline.setPalette(flashPalette);
    }else if(paletteChanged)pipeline.setPalette(palette.colors);

    if (active) {
      driver.advance(time);
      if (!sampleTime) { sampleTime = time; sampleFrame = active.frame; }
      if (time - sampleTime >= 500) {
        const actual = (active.frame - sampleFrame) * 1000 / (LOGIC_HZ * (time - sampleTime));
        options.onSpeed?.(actual);
        presentation.sample(actual);
        sampleTime = time; sampleFrame = active.frame;
      }
    }

    for (let steps = 0; time - lastTick >= TICK; steps++) {
      if (steps === MAX_STEPS) {
        lastTick = time;
        break;
      }
      lastTick += TICK;
      const shape = paused ? null : scroller.step({ mouse: input.mouse, rightButton: input.rightButton, keys: input.keyDirection() });
      const arrows = shape?.blocked ? scene.cursors.blocked : scene.cursors.scroll;
      cursor = shape ? arrows[shape.facing] : scene.cursors.normal;
    }

    const { x, y } = viewOrigin();
    while(responses.length && responses[0].frame < renderFrame){
      const {value,voiceEpoch}=responses.shift()!;
      if(value[0]>=0 && combatSetup){
        economy?.select(value[0]);
        if(value[2]===4)economy?.deploy();
        if(value[2]===5)economy?.selectPrimary(value[0]);
        const placed=combatSetup.setup.units[value[0]],type=MOVEMENT[economy?.types[value[0]]??placed.type];
        if(value[2]>0&&value[2]<=3&&type.domain!==2) voices?.play(type.name,!!type.infantry,type.infantry?value[0]-scene.scenario.units.length:value[0],value[2],active!.frame,voiceEpoch);
        if(value[7]) scroller.setPosition(Math.floor((value[3]+value[5])/2)-pixelToLepton(view.width/2),Math.floor((value[4]+value[6])/2)-pixelToLepton(view.height/2));
      }
    }
    if (!presentation.draw(time)) return;
    if (spritesDirty && ground) {
      ground.updateSprites(false); combatView?.update(false); buildingView?.update(); aircraftView?.update(); buildingEffects?.update();superView?.update();cloakView?.update();
      pipeline.updateGpuSprites((combatView?.count??ground.layout.count)+effectCapacity+superCapacity);
      spritesDirty = false;
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
      unitView.special.value=controlledOwner!==null&&economy?.current.specialTarget?(economy.current.specialTarget==='ion'?1:2):0;
      if(bandStart && input.mouse && (Math.abs(x+input.mouse.x-bandStart.x)>4 || Math.abs(y+input.mouse.y-bandStart.y)>4))
        unitView.band.value.set(bandStart.x,bandStart.y,x+input.mouse.x,y+input.mouse.y);
      else unitView.band.value.set(-1,-1,-1,-1);
      unitView.update();pipeline.setOverlay(null);
    }else pipeline.setOverlay(mouse || null);
    pipeline.setTime(time - startTime);
    if(sidebar){sidebar.origin.value.set(x,y);sidebar.viewport.value.set(view.width,view.height);sidebar.pointer.value.set(input.mouse?.x??-100,input.mouse?.y??-100);}
    sidebar?.drawPixels();
    radar?.update(x,y,view.width-(sidebar?.width??0),view.height);
    lasers?.update(x,y,view.width,view.height);
    construction?.update(input.mouse&&!sidebar?.contains(input.mouse.x,input.mouse.y)?input.mouse.x+x:-100,input.mouse?input.mouse.y+y:-100);
    // UNIT.CPP Take_Damage requests three shakes. The visual offset is local UI state.
    canvas.style.transform=time<shakeUntil?`translateY(${Math.ceil((shakeUntil-time)*60/1000)%2?2:-2}px)`:'';
    pipeline.render({ x, y, width: viewWidth, height: viewHeight }, scale);
  };

  await options.onProgress?.('Drawing the battlefield');
  const size = renderer.three.getDrawingBufferSize(new Vector2());
  drawFrame(size.x, size.y, performance.now());
  await finishGpuSetup(renderer.three);
  syncPlayback();
  renderer.setFrame(drawFrame);

  return {
    setFlow(enabled) { if (flow) flow.enabled.value = enabled ? 1 : 0; if(unitView) unitView.flow.value=enabled?1:0; },
    setVision(enabled) { if(unitView) unitView.vision.value=enabled?1:0; },
    setPerspective(value) { perspective?.setPerspective(value);spritesDirty=true; },
    setPaused(value) { paused = value || economy?.outcome!==undefined; input.enabled=!paused&&!nuclearFlash; syncPlayback(); if (!value) renderer.setFrame(drawFrame); },
    isPaused() { return paused; },
    canDebug() { return !released && !nuclearFlash && !!economy && controlledOwner !== null && economy.outcome === undefined; },
    async readDebugState() {
      if (!economy || controlledOwner === null || !paused || released) throw new Error('Pause a playable mission before opening Debug');
      await economy.settleForDebug();
      if (released || controlledOwner === null) throw new Error('The mission has ended');
      const house = economy.houses[controlledOwner];
      return { money: house.economy.money, buildSpeed: house.debugBuildSpeed, gameSpeed: simulationSpeed, damageScale: house.debugDamageScale };
    },
    applyDebugState(value) {
      if (!economy || controlledOwner === null || !paused || released || economy.outcome !== undefined || !validDebugState(value)) throw new Error('Invalid Debug settings');
      const house = economy.houses[controlledOwner];
      house.economy.setDebugMoney(value.money); house.debugBuildSpeed = value.buildSpeed; house.debugDamageScale = value.damageScale;
      economy.syncDebugDamage();
      simulationSpeed = value.gameSpeed;debugPace=value.gameSpeed===1?undefined:value.gameSpeed;
      driver.setSpeed(simulationSpeed*gamePace); syncPlayback();
    },
    setController(owner) {
      controlledOwner=owner;inputEpoch++;responses.length=0;bandStart=null;
      eva?.clear();economy?.setController(owner);selection?.setOwner(owner??-1);sidebar?.resetHouse();
    },
    setSimulationSpeed(value) { debugPace = undefined; simulationSpeed = value; driver.setSpeed(value * gamePace); syncPlayback(); },
    setPreferences(preferences) {
      gamePace = preferences.gameSpeed === 0 ? Infinity : 4 / preferences.gameSpeed;
      driver.setSpeed(simulationSpeed * gamePace); scroller.rate = preferences.scrollRate;
      combatAudio?.setVolume(preferences.volume); voices?.setVolume(preferences.volume); eva?.setVolume(preferences.volume);
      palette.setColors(adjustGamePalette(scene.setup.palette, preferences)); pipeline.setPalette(palette.colors);
      if (paused && bufferWidth && bufferHeight) drawFrame(bufferWidth, bufferHeight, performance.now());
    },
    setDensity(value){if(radar)radar.densityEnabled.value=Number(value);},
    async saveState() {
      if (!battle || !economy) throw new Error('This scene has no saved mission state');
      paused = true; input.enabled=false; syncPlayback();
      const savedEconomy = await economy.saveState();
      const buffers = await Promise.all(saveBuffers.map(async buffer => new Uint8Array(await renderer.three.getArrayBufferAsync(buffer))));
      return { frame: battle.frame, economy: savedEconomy, camera: { x: scroller.x, y: scroller.y, scale, bookmarks: [...bookmarks] }, buffers,
        ...(debugPace === undefined ? {} : { debug: { gameSpeed: debugPace } }) };
    },
    loadState(saved) {
      if (!battle || !economy || saved.buffers.length !== saveBuffers.length || saved.buffers.some((bytes, i) => bytes.byteLength !== saveBuffers[i].array.byteLength))
        throw new Error('This saved mission uses a different simulation layout');
      paused = true; input.enabled=false; syncPlayback();
      economy.loadState(saved.economy);
      debugPace = saved.debug?.gameSpeed===1?undefined:saved.debug?.gameSpeed; simulationSpeed = debugPace ?? 1;
      driver.setSpeed(simulationSpeed*gamePace); syncPlayback();
      battle.movement.frame = saved.frame;
      for (let i = 0; i < saveBuffers.length; i++) {
        const buffer = saveBuffers[i];
        new Uint8Array(buffer.array.buffer, buffer.array.byteOffset, buffer.array.byteLength).set(saved.buffers[i]);
        buffer.clearUpdateRanges(); buffer.needsUpdate = true;
      }
      scale = saved.camera.scale; bookmarks.splice(0, bookmarks.length, ...saved.camera.bookmarks);
      scroller.setPosition(saved.camera.x, saved.camera.y);
      controlledOwner = saved.economy.controlledOwner; selection?.setOwner(controlledOwner ?? -1); sidebar?.resetHouse();
      spritesDirty = true; inputEpoch++; responses.length = 0; bandStart = null;
    },
    dispose() {
      released=true;
      driver.dispose();
      renderer.setFrame(null);
      input.dispose();
      document.removeEventListener('visibilitychange', visibility);
      checksum?.dispose();
      ground?.dispose();
      aircraftView?.dispose();aircraft?.dispose();
      airOperations?.dispose();
      transport?.dispose();
      services?.dispose();
      cloakView?.dispose();superView?.dispose();buildingEffects?.dispose();buildingView?.dispose();harvest?.dispose();ore?.dispose();sidebar?.dispose();economy?.dispose();
      eva?.dispose();
      radar?.dispose();
      construction?.dispose();
      lasers?.dispose();
      simulation?.dispose();
      canvas.style.transform='';combatView?.dispose();combatAudio?.dispose();battle?.dispose();
      perspective?.dispose();controlSight?.dispose();
      opposingSight?.dispose();selection?.dispose();unitView?.dispose();voices?.dispose();
      pipeline.dispose();
    },
  };
}
