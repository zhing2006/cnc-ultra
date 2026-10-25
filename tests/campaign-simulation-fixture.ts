import { createRenderer } from '../src/engine/renderer.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { GpuNaval, stepNaval, NAVAL_WORDS, type NavalMap } from '../src/game/campaign/naval.ts';
import { CampaignAssets } from '../src/game/campaign/assets.ts';
import { readCampaignScenario } from '../src/game/campaign/scenario.ts';
import { campaignScene } from '../src/game/campaign/scene.ts';
import { CampaignRuntime } from '../src/game/campaign/runtime.ts';
import { startPreparedGame, type Game } from '../src/game/game.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import { GpuTeamTargets, teamTarget } from '../src/game/campaign/team-targets.ts';

function equal(actual: ArrayLike<number>, expected: ArrayLike<number>, label: string) {
  if (actual.length !== expected.length) throw new Error(`${label}: length differs`);
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) throw new Error(`${label}, word ${i}: ${actual[i]} != ${expected[i]}`);
}

export async function checkCampaignTransportTeams() {
  const canvas=document.createElement('canvas');canvas.style.cssText='width:640px;height:400px';document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>{throw new Error(message);}});
  if(!renderer)throw new Error('WebGPU is required');
  let game:Game|undefined;
  try{
    const assets=await CampaignAssets.open(),archives=['gdi/general.mix','general.mix'];
    const [ini,bin,files]=await Promise.all([assets.bytes('SCG04EA.INI',archives),assets.bytes('SCG04EA.BIN',archives),assets.mission('gdi','TEMPERATE')]);
    const mission=readCampaignScenario(new TextDecoder().decode(ini),bin);mission.buildLevel=4;
    // Isolate the original AIR1 reinforcement wave from the rescue mission's other triggers.
    mission.scenario.units=[];mission.scenario.infantry=[];mission.scenario.buildings=[];mission.objectTriggers=[];
    const definition=mission.triggers.find(trigger=>trigger.team==='AIR1')!;
    let runtime!:CampaignRuntime,target=0,reached:(()=>void)|undefined;
    const world=campaignScene(files,mission,1995,64);
    game=await startPreparedGame(renderer,canvas,files,{kind:'combat',scene:world.scene,setup:world.setup,economy:world,decalStart:world.decalStart},{
      createEconomy:battle=>runtime=new CampaignRuntime(battle,world,mission),
      onStats:frame=>{if(frame===target){game!.setPaused(true);reached?.();}},
    });
    game.setPaused(true);game.setSimulationSpeed(100);
    for(const trigger of runtime.triggers.state)trigger.active=false;
    const advance=async(frame:number)=>{target=frame;const done=new Promise<void>(resolve=>{reached=resolve;});game!.setPaused(false);await done;await runtime.saveState();};
    await advance(10);
    const index=mission.triggers.indexOf(definition);runtime.triggers.state[index].active=true;runtime.triggers.state[index].remaining=1;
    runtime.triggers.spring(index,definition.event,definition.data,{kind:'object',id:-1,house:'GoodGuy'});
    await advance(30);
    const wave=runtime.saveCampaign().teams.find(team=>team.name==='AIR1');
    if(!wave?.moving||wave.ids.length!==4)throw new Error('The arriving AIR1 team lost its members before the creation report');
    if(definition.event==='Time'&&runtime.triggers.state[index].remaining!==definition.data)throw new Error('Successful repeating reinforcements did not reset the original countdown');
    const ids=[...wave.ids];await advance(1200);
    const units=new Int32Array(await renderer.three.getArrayBufferAsync(runtime.battle.units));
    const passengers=ids.filter(id=>units[id*U.WORDS+U.UTYPE]!==movementType('TRAN'));
    if(passengers.some(id=>units[id*U.WORDS+U.UHEALTH]<=0||units[id*U.WORDS+U.UATTACHED]!==0)){
      const goals=new Int32Array(await renderer.three.getArrayBufferAsync(runtime.battle.movement.goals));
      const transport=new Int32Array(await renderer.three.getArrayBufferAsync(runtime.transportState));
      throw new Error(`The original AIR1 infantry did not unload: ${JSON.stringify({waypoint:mission.scenario.waypoints.get(10),teams:runtime.saveCampaign().teams,
        actors:ids.map(id=>({id,cell:units[id*U.WORDS+U.UCELL],health:units[id*U.WORDS+U.UHEALTH],altitude:units[id*U.WORDS+U.UALTITUDE],attached:units[id*U.WORDS+U.UATTACHED],goal:goals[id],mode:transport[6+id*16]}))})}`);
    }
    return {members:ids.length,passengers:passengers.length};
  }finally{game?.dispose();renderer.dispose();canvas.remove();}
}

export async function checkCampaignSimulation() {
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:640px;height:400px'; document.body.append(canvas);
  const renderer = await createRenderer(canvas, { onDeviceLost: message => { throw new Error(message); } });
  if (!renderer) throw new Error('WebGPU is required');
  let game: Game | undefined;
  try {
    {
      const setup = { grid: gridEdges(24, 12, new Uint8Array(288).fill(1), true), land: new Uint8Array(288), seed: 1995,
        houseCount: 4, allies: [5, 2, 4, 8], units: [
          { type: movementType('MTNK'), cell: 125, owner: 0 }, { type: movementType('MOEBIUS'), cell: 127, owner: 2 },
        ] };
      const cpu = new CpuCombat(setup), gpu = new GpuCombat(renderer.three, setup);
      try {
        await gpu.prepareForPlay();
        for (let frame = 1; frame <= 180; frame++) {
          const orders = frame === 91 ? [{ frame, kind: 'move' as const, target: 129, ids: [0] }] : [];
          cpu.step(orders); gpu.step(orders);
          if (frame % 30 === 0) (await gpu.snapshot()).forEach((values, i) => equal(values, cpu.buffers()[i], `campaign alliance ${frame}/${i}`));
        }
        if (cpu.units[U.WORDS + U.UHEALTH] !== 50) throw new Error('GDI attacked or crushed its neutral ally');
      } finally { gpu.dispose(); }
    }
    {
      const setup = { grid: gridEdges(20, 12, new Uint8Array(240).fill(1), true), land: new Uint8Array(240), seed: 1995,
        units: ['E1', 'E1', 'GUN', 'E1', 'MCV', 'STNK'].map((name, id) => ({ type: movementType(name), cell: 83 + id * 2, owner: id < 2 ? 1 : 0 })) };
      const cpu = new CpuCombat(setup), gpu = new GpuCombat(renderer.three, setup), targeting = new GpuTeamTargets(gpu);
      for (let id = 0; id < setup.units.length; id++) cpu.state[id * C.CWORDS + C.CSEEN] = 1;
      cpu.units[5 * U.WORDS + U.UCLOAK] = 2;
      try {
        await gpu.prepareForPlay(); await targeting.prepare(); targeting.set([[0, 1]]);
        for (let phase = 0; phase < 4; phase++) {
          if (phase === 1) cpu.units[4 * U.WORDS + U.UX] = cpu.units[U.UX];
          if (phase === 2) cpu.units[3 * U.WORDS + U.UHEALTH] = 0;
          if (phase === 3) cpu.units[4 * U.WORDS + U.UOWNER] = 1;
          const target = teamTarget(cpu, 1);
          if (target !== [3, 3, 4, -1][phase]) throw new Error(`Original mobile-target selection: ${target} in phase ${phase}`);
          (gpu.units.array as Int32Array).set(cpu.units); gpu.units.needsUpdate = true;
          (gpu.state.array as Int32Array).set(cpu.state); gpu.state.needsUpdate = true; targeting.step();
          for (const id of [0, 1]) { cpu.state[id * C.CWORDS + C.CTARGET] = target; cpu.state[id * C.CWORDS + C.CMISSION] = C.ATTACK; }
          equal(new Int32Array(await renderer.three.getArrayBufferAsync(gpu.state)), cpu.state, `team target ${phase}`);
        }
      } finally { targeting.dispose(); gpu.dispose(); }
    }
    for (const passengers of [['E1', 'E1', 'E1'], ['JEEP']]) {
      const width = 24, height = 16, land = new Uint8Array(width * height); land.fill(2, width * 10);
      const map: NavalMap = { width, land, clear: new Uint8Array(width * height).fill(1), bounds: { x: 3, y: 3, width: 18, height: 10 }, desert: false };
      const setup = { grid: gridEdges(width, height, map.clear, true), land, bounds: map.bounds, seed: 1995,
        units: [{ type: movementType('LST'), cell: 0, facing: 0 },
          ...passengers.map(type => ({ type: movementType(type), cell: 0, attached: 1 })),
          { type: movementType('BOAT'), cell: 12 * width + 10, facing: 192 }],
      };
      const cpu = new CpuCombat(setup), gpu = new GpuCombat(renderer.three, setup), naval = new GpuNaval(gpu, map);
      const state = new Int32Array(setup.units.length * NAVAL_WORDS);
      try {
        await gpu.prepareForPlay(); await naval.prepare();
        for (let frame = 1; frame <= 900; frame++) {
          stepNaval(cpu, state, map); cpu.movement.occupy(); cpu.step(); naval.step(); gpu.step();
          if (frame % 30 === 0) {
            const actual = await gpu.snapshot();
            actual.forEach((values, i) => equal(values, cpu.buffers()[i], `naval ${passengers}/${frame}/${i}`));
            equal(new Int32Array(await renderer.three.getArrayBufferAsync(naval.state)), state, `naval delivery state ${frame}`);
          }
        }
        if (cpu.units[U.UHEALTH] !== 0 || cpu.units[U.WORDS + U.UATTACHED]) throw new Error('The transport did not complete its delivery');
      } finally { naval.dispose(); gpu.dispose(); }
    }

    const assets = await CampaignAssets.open(), archives = ['gdi/general.mix', 'general.mix'];
    const [ini, bin, files] = await Promise.all([assets.bytes('SCG01EA.INI', archives), assets.bytes('SCG01EA.BIN', archives), assets.mission('gdi', 'TEMPERATE')]);
    const mission = readCampaignScenario(new TextDecoder().decode(ini), bin);
    let runtime!: CampaignRuntime, target = 0, reached: (() => void) | undefined;
    const start = async () => {
      const world = campaignScene(files, mission, 0x1995, 64);
      game = await startPreparedGame(renderer, canvas, files, { kind: 'combat', scene: world.scene, setup: world.setup, economy: world, decalStart: world.decalStart }, {
        createEconomy: battle => runtime = new CampaignRuntime(battle, world, mission),
        onProgress:message=>{canvas.dataset.status=message;},
        onStats: frame => { if (frame === target) { game!.setPaused(true); reached?.(); } },
        onOutcome: () => { throw new Error('Mission ended before the reinforcement checkpoint'); },
      });
      game.setPaused(true); game.setSimulationSpeed(100);
    };
    const advance = async (frame: number) => {
      target = frame; const done = new Promise<void>(resolve => { reached = resolve; });
      game!.setPaused(false); await done; await runtime.saveState();
    };
    await start(); await advance(210);
    const saved = await game!.saveState(), campaign = structuredClone(runtime.saveCampaign());
    await advance(600);
    const expected = await runtime.battle.snapshot(), rules = JSON.stringify(runtime.saveCampaign());
    const expectedCpu = JSON.stringify(await runtime.saveState());
    const ships = new Int32Array(await renderer.three.getArrayBufferAsync(runtime.extraSimulationBuffers[0]));
    for (const name of ['ATK2', 'RNF1', 'RFN2']) if (runtime.triggers.state[mission.triggers.findIndex(t => t.name === name)].active)
      throw new Error(`Original trigger ${name} did not complete`);
    game!.dispose(); game = undefined; await start(); game!.loadState(saved); runtime.loadCampaign(campaign); await advance(600);
    (await runtime.battle.snapshot()).forEach((values, i) => equal(values, expected[i], `campaign continuation ${i}`));
    equal(new Int32Array(await renderer.three.getArrayBufferAsync(runtime.extraSimulationBuffers[0])), ships, 'campaign transport continuation');
    if (JSON.stringify(runtime.saveCampaign()) !== rules || JSON.stringify(await runtime.saveState()) !== expectedCpu) throw new Error('Campaign CPU continuation differs');
    return { frame: runtime.frame, teams: runtime.saveCampaign().teams.length, triggers: runtime.triggers.state };
  } finally { game?.dispose(); renderer.dispose(); canvas.remove(); }
}
