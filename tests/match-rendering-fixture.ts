import { createRenderer, type FrameCallback } from '../src/engine/renderer.ts';
import { loadData } from '../src/game/data-files.ts';
import { startPreparedGame, type Game } from '../src/game/game.ts';
import { economyScene } from '../src/demo/economy-scene.ts';
import { EconomyRuntime } from '../src/game/simulation/economy-runtime.ts';
import { GpuGround, groundLayout } from '../src/game/simulation/ground.ts';
import { CombatView, combatExtraSprites } from '../src/game/simulation/combat-view.ts';
import { BuildingView } from '../src/game/simulation/building-view.ts';
import { AircraftView } from '../src/game/simulation/aircraft-view.ts';
import { GpuBuildingEffects } from '../src/game/simulation/building-effects-gpu.ts';
import { PalettePipeline, type Sprite } from '../src/engine/indexed/pipeline.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { GpuTiberium } from '../src/game/simulation/tiberium-gpu.ts';
import { movementType } from '../src/game/data/movement.ts';
import { animations, bullets } from '../src/game/data/combat.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import { SightView } from '../src/game/simulation/sight-view.ts';
import { CloakView } from '../src/game/simulation/cloak-view.ts';
import { cloakedSprites, type CloakStage } from '../src/game/cloak.ts';
import { SuperView } from '../src/game/simulation/super-view.ts';

/** Exercise the real game loop with 25 logic ticks between two manually presented frames. */
export async function checkDeferredGameDrawing() {
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:320px;height:240px'; document.body.append(canvas);
  const renderer = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!renderer) throw new Error('No WebGPU');
  let frame!: FrameCallback, economy!: EconomyRuntime, game: Game | undefined, report: Promise<void> | undefined;
  const restore: (() => void)[] = [], calls: Record<string, number> = {};
  const observe = (prototype: object, name: string, label: string) => {
    const methods = prototype as Record<string, (this: unknown, ...args: unknown[]) => unknown>, original = methods[name];
    methods[name] = function (...args) { calls[label] = (calls[label] ?? 0) + 1; return original.apply(this, args); };
    restore.push(() => { methods[name] = original; });
  };
  try {
    const data = await loadData(false, true, true), world = economyScene(data, false, 16);
    game = await startPreparedGame({ ...renderer, setFrame(next) { if (next) frame = next; } }, canvas, data,
      { kind: 'combat', ...world, economy: world }, { createEconomy(battle, setup) { return economy = new EconomyRuntime(battle, setup); } });
    const endTick = economy.endTick.bind(economy);
    economy.endTick = () => report = endTick();
    game.setSimulationSpeed(100);
    frame(320, 240, 0);
    observe(GpuGround.prototype, 'sort', 'sort'); observe(GpuGround.prototype, 'updateSprites', 'ground');
    observe(CombatView.prototype, 'update', 'combat'); observe(BuildingView.prototype, 'update', 'buildings');
    observe(AircraftView.prototype, 'update', 'aircraft'); observe(GpuBuildingEffects.prototype, 'update', 'effects');
    observe(PalettePipeline.prototype, 'updateGpuSprites', 'index');
    frame(320, 240, 1000 / 60);
    const deadline = performance.now() + 15000;
    while (economy.battle.frame < 25) {
      if (performance.now() > deadline) throw new Error(`Fast-forward stopped at tick ${economy.battle.frame}`);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await report;
    game.setPaused(true);
    if (economy.battle.frame !== 25 || calls.sort !== 25) throw new Error(`Logic/sort cadence changed: ${JSON.stringify(calls)}`);
    for (const label of ['ground', 'combat', 'buildings', 'aircraft', 'effects', 'index']) {
      if (calls[label]) throw new Error(`${label} was updated ${calls[label]} times without presenting a frame`);
    }
    frame(320, 240, 2000 / 60);
    for (const label of ['ground', 'combat', 'buildings', 'aircraft', 'effects', 'index']) {
      if (calls[label] !== 1) throw new Error(`${label} should be updated once for the final visible state, got ${calls[label]}`);
    }
    frame(320, 240, 3000 / 60);
    if (calls.index !== 1) throw new Error('A paused frame rebuilt the unchanged sprite index');
    return calls;
  } finally {
    game?.setPaused(true); await report;
    for (const reset of restore) reset();
    game?.dispose(); renderer.dispose(); canvas.remove();
  }
}

/** Verify the live GPU projection against the original cloak layer composition and SHP frames. */
export async function checkSpecialDrawing(){
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const wrapper=await createRenderer(canvas,{onDeviceLost:message=>console.error(message)});if(!wrapper)throw new Error('No WebGPU');
  const renderer=wrapper.three,world=economyScene(await loadData(false,true,true),false,8);world.setup.units[0].type=movementType('STNK');
  const battle=new GpuCombat(renderer,world.setup),economy=new EconomyRuntime(battle,world),sight=new SightView(battle.sight);
  const layout=groundLayout(world.scene,U.initialUnits(world.setup),U.WORDS,true);
  const pipeline=new PalettePipeline(renderer,{...world.scene.setup,spriteCapacity:layout.count+8,dynamicSprites:{maxWidth:128,maxHeight:128}});
  const ground=new GpuGround(renderer,battle,pipeline,layout,world.scene),cloak=new CloakView(battle,ground,pipeline,sight),supers=new SuperView(economy,pipeline,world.scene,layout.count);
  try{
    const order=new Uint32Array(await renderer.getArrayBufferAsync(ground.order.order)),position=order.findIndex(id=>layout.bindings[id*5]===0),start=(layout.first+position*layout.slots)*12;
    const u=battle.units.array as Int32Array;
    const cases:[number,number,CloakStage][]=[[0,0,'normal'],[1,1,'indistinct'],[1,10,'darken'],[1,19,'shadowy'],[1,29,'ripple'],[2,38,'hidden']];
    for(const owner of [1,0] as const)for(const [state,stage,visual] of cases){
      u[U.UCLOAK]=state;u[U.UCLOAK_STAGE]=stage;battle.units.needsUpdate=true;sight.setPerspective(owner);
      ground.updateSprites(false);
      const normal=new Float32Array(await renderer.getArrayBufferAsync(pipeline.spriteBuffer)).slice(start,start+12);
      const body:Sprite={x:normal[0],y:normal[1],region:{x:normal[4],y:normal[5],width:normal[2],height:normal[3]},remap:normal[6],shadow:!!normal[7]};
      const expected=cloakedSprites(body,owner===0&&(visual==='ripple'||visual==='hidden')?'shadowy':visual);
      cloak.update();const records=new Float32Array(await renderer.getArrayBufferAsync(pipeline.spriteBuffer));
      for(let part=0;part<3;part++){
        const at=start+part*12,record=expected[part];
        if(!record){if(records[at+2]!==0)throw new Error(`Cloak ${owner}/${visual} left an extra layer`);continue;}
        const values=[record.x,record.y,record.region.width,record.region.height,record.region.x,record.region.y,record.remap,Number(!!record.shadow),record.filter===undefined?0:record.filter+2,Number(!!record.displace)];
        for(let i=0;i<values.length;i++)if(values[i]!==records[at+i])throw new Error(`Cloak ${owner}/${visual}, layer ${part}, word ${i}: ${records[at+i]} != ${values[i]}`);
      }
    }
    const charge=economy.supers.charges[0].ion;charge.step(0,true,true);charge.step(9000,true,true);
    economy.supers.fire(0,'ion',world.setup.units[0].cell,9000,[]);economy.supers.step(9000);supers.update();
    const records=new Float32Array(await renderer.getArrayBufferAsync(pipeline.spriteBuffer)),region=world.scene.animation!.frames.get('IONSFX')![0],at=layout.count*12;
    if(records[at+2]!==region.width||records[at+3]!==region.height||records[at+4]!==region.x||records[at+5]!==region.y)throw new Error('Ion cannon did not project the original animation frame');
  }finally{supers.dispose();cloak.dispose();ground.dispose();pipeline.dispose();sight.dispose();economy.dispose();battle.dispose();wrapper.dispose();canvas.remove();}
}

/** Every-tick and sparse drawing must retain the same smoke, craters, scorch marks and foundations. */
export async function checkDeferredVisualHistory() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const wrapper = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!wrapper) throw new Error('No WebGPU');
  const renderer = wrapper.three, world = economyScene(await loadData(false, true, true), false, 8);
  world.setup.units[0].type = movementType('MTNK');
  const battle = new GpuCombat(renderer, world.setup), economy = new EconomyRuntime(battle, world);
  const ore = new GpuTiberium(renderer, world.tiberium);
  const makeView = () => {
    const layout = groundLayout(world.scene, U.initialUnits(world.setup), U.WORDS, true);
    const pipeline = new PalettePipeline(renderer, { ...world.scene.setup, spriteCapacity: layout.count + combatExtraSprites(world.setup, world.scene),
      dynamicSprites: { maxWidth: 128, maxHeight: 128 } });
    const ground = new GpuGround(renderer, battle, pipeline, layout, world.scene);
    const combat = new CombatView(renderer, battle, ground, pipeline, world.scene, world.decalStart, true);
    const buildings = new BuildingView(economy, ground, pipeline, ore);
    return { pipeline, ground, combat, buildings,
      draw() { ground.updateSprites(false); combat.update(false); buildings.update(); pipeline.updateGpuSprites(combat.count); },
      dispose() { buildings.dispose(); combat.dispose(); ground.dispose(); pipeline.dispose(); },
    };
  };
  const every = makeView(), sparse = makeView();
  const equal = (a: ArrayLike<number>, b: ArrayLike<number>, label: string) => {
    if (a.length !== b.length) throw new Error(`${label}: length differs`);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`${label}: word ${i}, ${a[i]} != ${b[i]}`);
  };
  const u = battle.units.array as Int32Array, p = battle.projectiles.array as Int32Array;
  const crater = bullets.findIndex(b => animations[b.explosion]?.crater), scorch = bullets.findIndex(b => animations[b.explosion]?.scorch);
  const cell = world.setup.units[0].cell, width = world.setup.grid.width;
  const end = Math.max(32, ...[crater, scorch].map(id => 6 + animations[bullets[id].explosion].biggest * (animations[bullets[id].explosion].rate || 1)));
  try {
    for (let tick = 1; tick <= end; tick++) {
      every.ground.sort(); sparse.ground.sort();
      (battle.movement.control.array as Int32Array)[0] = tick; battle.movement.control.needsUpdate = true;
      u[U.UHEALTH] = tick === 3 ? 199 : 400; u[U.UX] += 8; battle.units.needsUpdate = true;
      for (const [id, type] of [crater, scorch].entries()) {
        const at = id * C.BWORDS, c = cell + id * 3;
        p[at + C.BTYPE] = type; p[at + C.BEXPLODED] = tick >= 2 ? 2 : -1;
        p[at] = c % width * 256 + 128; p[at + 1] = Math.trunc(c / width) * 256 + 128;
      }
      p[2 * C.BWORDS + C.BTRAIL_TICK] = tick % 2 === 0 ? tick : -1;
      p[2 * C.BWORDS + C.BTRAIL_X] = u[U.UX]; p[2 * C.BWORDS + C.BTRAIL_Y] = u[U.UY];
      battle.projectiles.needsUpdate = true;
      if (tick === 4) {
        economy.buildings.set(3, { id: 3, type: 'NUKE', owner: 0, faction: 1, cell, health: 400, active: true, opened: true,
          started: tick, duration: 0, selling: false, repairing: false });
        economy.placementVersion++;
      }
      if (tick === 7) { economy.buildings.delete(3); economy.placementVersion++; }
      for (const view of [every, sparse]) { view.combat.step(); view.buildings.step(); }
      every.draw();
    }
    sparse.draw();
    for (const [label, a, b] of [
      ['order', every.ground.order.order, sparse.ground.order.order], ['smudges', every.combat.smudges, sparse.combat.smudges],
      ['smoke history', every.combat.effects, sparse.combat.effects], ['foundations', every.buildings.bibs, sparse.buildings.bibs],
    ] as const) equal(new Int32Array(await renderer.getArrayBufferAsync(a)), new Int32Array(await renderer.getArrayBufferAsync(b)), label);
    const marks = new Int32Array(await renderer.getArrayBufferAsync(sparse.combat.smudges));
    if (!marks[cell] || !marks[cell + 3]) throw new Error('Intermediate explosion ages lost their permanent marks');
    const bibs = new Int32Array(await renderer.getArrayBufferAsync(sparse.buildings.bibs));
    if (bibs[(cell + width) * 2] < 0) throw new Error('A building removed between renders lost its foundation');
    const normalize = (data: Float32Array) => {
      // Atlas metadata of zero-size sprites is not visible and may retain an earlier frame.
      for (let at = 0; at < data.length; at += 12) if (data[at + 2] <= 0 || data[at + 3] <= 0) data.fill(0, at, at + 12);
      return data;
    };
    equal(normalize(new Float32Array(await renderer.getArrayBufferAsync(every.pipeline.spriteBuffer))),
      normalize(new Float32Array(await renderer.getArrayBufferAsync(sparse.pipeline.spriteBuffer))), 'visible sprite records');
  } finally { every.dispose(); sparse.dispose(); ore.dispose(); economy.dispose(); battle.dispose(); wrapper.dispose(); canvas.remove(); }
}
