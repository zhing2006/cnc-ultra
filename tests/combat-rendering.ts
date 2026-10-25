import type { WebGPURenderer } from 'three/webgpu';
import { PalettePipeline } from '../src/engine/indexed/pipeline.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { CombatView, combatExtraSprites } from '../src/game/simulation/combat-view.ts';
import { GpuGround, groundLayout } from '../src/game/simulation/ground.ts';
import { initialUnits, WORDS, UHEALTH } from '../src/game/simulation/units-state.ts';
import { MOVEMENT, movementType } from '../src/game/data/movement.ts';
import { combatTypes } from '../src/game/data/combat.ts';
import type { combatScene } from '../src/demo/combat-scene.ts';
import * as C from '../src/game/simulation/combat-state.ts';

/** Check the actual draw records against UNIT.CPP and INFANTRY.CPP, Draw_It. */
export async function verifyCombatSprites(renderer: WebGPURenderer, demo: ReturnType<typeof combatScene>, shared?: GpuCombat) {
  const { scene, setup } = demo;
  const battle = shared ?? new GpuCombat(renderer, setup);
  const saved = [battle.units, battle.state, battle.projectiles, battle.movement.control].map(attribute => ({
    attribute, values:(attribute.array as Int32Array).slice(),
  }));
  const layout = groundLayout(scene, initialUnits(setup), WORDS);
  const regions = [...scene.animation!.frames.values()].flat();
  const pipeline = new PalettePipeline(renderer, { ...scene.setup,
    spriteCapacity: layout.count + combatExtraSprites(setup,scene),
    dynamicSprites: {
      maxWidth: Math.max(...regions.map(r => r.width)),
      maxHeight: Math.max(...regions.map(r => r.height)),
    },
  });
  const ground = new GpuGround(renderer, battle, pipeline, layout, scene);
  const view = new CombatView(renderer, battle, ground, pipeline, scene, demo.decalStart);
  const failures: string[] = [];
  try {
    const order = new Uint32Array(await renderer.getArrayBufferAsync(ground.order.order));
    // Infantry draws one body through Techno_Draw_Object, retaining its house remap
    // in prone, firing and death sequences. Turrets use SecondaryFacing, not the body.
    for (const [stage, facing] of [['prone', 0], ['firing', 64], ['dying', 128]] as const) {
      const state = battle.state.array as Int32Array;
      for (let id = 0; id < setup.units.length; id++) {
        const at = id * C.CWORDS;
        state[at + C.CTURRET] = (facing + (setup.units[id].owner ?? 0) * 64) & 255;
        if (!MOVEMENT[setup.units[id].type].infantry || setup.units[id].health === 0) continue;
        state[at + C.CPRONE] = 1;
        state[at + C.CFIRE] = stage === 'firing' ? 0 : -1;
        state[at + C.CDEATH] = stage === 'dying' ? 0 : -1;
        if (stage === 'dying') (battle.units.array as Int32Array)[id * WORDS + UHEALTH] = 0;
      }
      battle.state.needsUpdate = true;
      if (stage === 'dying') battle.units.needsUpdate = true;
      view.step(); ground.updateSprites();
      view.update();
      const sprites = new Float32Array(await renderer.getArrayBufferAsync(pipeline.spriteBuffer));
      for (let slot = 0; slot < order.length; slot++) {
        const object = order[slot], id = layout.bindings[object * 5];
        if (id < 0 || setup.units[id].health === 0) continue;
        const type = MOVEMENT[setup.units[id].type], start = (layout.first + slot * layout.slots) * 12;
        const source = (layout.first + object * layout.slots) * 12;
        if (type.infantry) {
          let count = 0;
          for (let part = 0; part < layout.slots; part++) {
            const at = start + part * 12;
            if (sprites[at + 2] <= 0 || sprites[at + 3] <= 0) continue;
            count++;
            if (sprites[at + 6] !== layout.packed[source + 6])
              failures.push(`${stage}: infantry ${id} part ${part} remap ${sprites[at + 6]}, expected ${layout.packed[source + 6]}`);
          }
          if (count !== 1) failures.push(`${stage}: infantry ${id} draws ${count} bodies`);
        } else if (combatTypes[setup.units[id].type].turret) {
          // TECHNO.CPP, BodyShape: N/E/S/W turret frames are 32/56/48/40.
          const direction = (facing / 64 + (setup.units[id].owner ?? 0)) % 4;
          const turretFrame = [32, 56, 48, 40][direction];
          const at = start + 12, expected = scene.animation!.frames.get(type.name)![turretFrame];
          if (sprites[at + 4] !== expected.x || sprites[at + 5] !== expected.y)
            failures.push(`${stage}: ${type.name} ${id} turret atlas ${sprites[at + 4]},${sprites[at + 5]}, expected ${expected.x},${expected.y}`);
        }
      }
    }
    // TECHNO.CPP, Fire_At selects FLAME-* from Fire_Direction even when the
    // projectile points at a nearby target at a different angle from its offset muzzle.
    const flame = setup.units.findIndex(u => MOVEMENT[u.type].name === 'FTNK');
    const state = battle.state.array as Int32Array, shots = battle.projectiles.array as Int32Array;
    const shot = flame * C.SHOTS_PER_UNIT * C.BWORDS, at = flame * C.CWORDS;
    for (const [facing, name] of [[0,'FLAME-N'],[64,'FLAME-E'],[128,'FLAME-S'],[192,'FLAME-W']] as const) {
      state[at + C.CLAST_FIRE] = 0;
      state[at + C.CCURSOR] = 1;
      shots[shot + C.BWEAPON] = 6;
      shots[shot + C.BFACE] = (facing + 96) & 255;
      shots[shot + C.BFIRE_FACE] = facing;
      battle.state.needsUpdate = battle.projectiles.needsUpdate = true;
      view.step(); ground.updateSprites();
      view.update();
      const sprites = new Float32Array(await renderer.getArrayBufferAsync(pipeline.spriteBuffer));
      const record = (layout.count + setup.units.length * C.SHOTS_PER_UNIT + flame) * 12;
      const expected = scene.animation!.frames.get(name)![0];
      if (sprites[record + 4] !== expected.x || sprites[record + 5] !== expected.y)
        failures.push(`Flame direction ${facing}: expected ${name}`);
    }
    // UNIT.CPP Take_Damage attaches SMOKE_M below half health.
    const damaged=setup.units.findIndex(u=>MOVEMENT[u.type].name==='MTNK');
    (battle.units.array as Int32Array)[damaged*WORDS+UHEALTH]=199;
    battle.units.needsUpdate=true;
    view.step();ground.updateSprites();view.update();
    const effects=new Float32Array(await renderer.getArrayBufferAsync(pipeline.spriteBuffer));
    const smoke=scene.animation!.frames.get('SMOKE_M')![0];
    let smoking=false;
    for(let at=0;at<effects.length;at+=12)
      if(effects[at+2]>0 && effects[at+4]===smoke.x && effects[at+5]===smoke.y) smoking=true;
    if(!smoking) failures.push('Damaged medium tank did not render SMOKE_M');
    for(const [name,shape] of [['E2','ART-EXP1'],['E4','NAPALM1'],['E5','CHEMBALL']]) {
      const id=setup.units.findIndex(u=>MOVEMENT[u.type].name===name);
      const at=(layout.count+setup.units.length*(C.SHOTS_PER_UNIT+2)+id)*12;
      const expected=scene.animation!.frames.get(shape)![0];
      if(effects[at+2]===0 || effects[at+4]!==expected.x || effects[at+5]!==expected.y)
        failures.push(`${name} death did not render ${shape}`);
    }
    const bike=setup.units.findIndex(u=>MOVEMENT[u.type].name==='BIKE');
    const b=bike*C.SHOTS_PER_UNIT*C.BWORDS;
    shots[b+C.BTRAIL_TICK]=1;shots[b+C.BTRAIL_X]=2560;shots[b+C.BTRAIL_Y]=2560;
    (battle.movement.control.array as Int32Array)[0]=1;
    battle.movement.control.needsUpdate=battle.projectiles.needsUpdate=true;
    view.step();view.update();
    const trail=new Float32Array(await renderer.getArrayBufferAsync(pipeline.spriteBuffer));
    const puff=scene.animation!.frames.get('SMOKEY')![0];
    let hasTrail=false;
    for(let at=0;at<trail.length;at+=12)
      if(trail[at+2]>0 && trail[at+4]===puff.x && trail[at+5]===puff.y) hasTrail=true;
    if(!hasTrail) failures.push('Missile did not leave a smoke puff');
    // UNIT_MSAM is MLRS in the INI, and switches to NAPALM3 only while loaded.
    (battle.units.array as Int32Array)[damaged*WORDS+12]=movementType('MLRS');
    (battle.units.array as Int32Array)[damaged*WORDS+UHEALTH]=0;
    state[damaged*C.CWORDS+C.CDEATH]=1;state[damaged*C.CWORDS+C.CAMMO]=1;
    battle.units.needsUpdate=battle.state.needsUpdate=true;
    view.step();ground.updateSprites();view.update();
    const loaded=new Float32Array(await renderer.getArrayBufferAsync(pipeline.spriteBuffer));
    const napalm=scene.animation!.frames.get('NAPALM3')![0];
    let loadedBlast=false;
    for(let at=0;at<loaded.length;at+=12)
      if(loaded[at+2]>0 && loaded[at+4]===napalm.x && loaded[at+5]===napalm.y) loadedBlast=true;
    if(!loadedBlast) failures.push('Loaded SSM launcher did not render NAPALM3');
    const commando=setup.units.findIndex(u=>MOVEMENT[u.type].name==='RMBO');
    const orderSlot=order.findIndex(entry=>layout.bindings[entry*5]===commando);
    const record=(layout.first+orderSlot*layout.slots)*12;
    (battle.units.array as Int32Array)[commando*WORDS+UHEALTH]=80;
    (battle.units.array as Int32Array)[commando*WORDS+10]=0;
    state[commando*C.CWORDS+C.CDEATH]=-1;
    state[commando*C.CWORDS+C.CPRONE]=0;
    state[commando*C.CWORDS+C.CFIRE]=-1;
    for(const [action,start] of [[27,372],[29,420]]) {
      state[commando*C.CWORDS+C.CACTION]=action;
      state[commando*C.CWORDS+C.CSTAGE]=4;
      battle.units.needsUpdate=battle.state.needsUpdate=true;
      view.step();ground.updateSprites();view.update();
      const drawn=new Float32Array(await renderer.getArrayBufferAsync(pipeline.spriteBuffer));
      // IDATA.CPP CommandoDos and INFANTRY.CPP MasterDoControls: frame 2 after four ticks.
      const expected=scene.animation!.frames.get('RMBO')![start+2];
      if(drawn[record+4]!==expected.x || drawn[record+5]!==expected.y)
        failures.push(`Commando gesture ${action} did not use its original animation frame`);
    }
    if (failures.length) throw new Error(failures.join('\n'));
  } finally {
    view.dispose();
    ground.dispose();
    pipeline.dispose();
    if (shared) {
      // The following command test needs the initial state; the sprite checks
      // only changed these three buffers and never advanced the simulation.
      for (const {attribute, values} of saved) {
        (attribute.array as Int32Array).set(values);
        attribute.needsUpdate = true;
      }
    } else battle.dispose();
  }
}
