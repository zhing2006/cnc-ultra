import { createRenderer } from '../src/engine/renderer.ts';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import { GpuLifecycle } from '../src/game/simulation/lifecycle-gpu.ts';
import { applyLifecycle } from '../src/game/simulation/lifecycle-cpu.ts';
import { GpuBombers, stepBombers } from '../src/game/campaign/bombers.ts';
import { GpuCampaignEvents, campaignEvents,BASE_PANIC } from '../src/game/campaign/events.ts';
import { GpuPlacementFlush } from '../src/game/ai/placement-gpu.ts';
import { respondToBaseAttack } from '../src/game/ai/placement-cpu.ts';
import { GpuTeamTargets,retaliationTarget,TEAM_TARGET_WORDS } from '../src/game/campaign/team-targets.ts';
import { teamRetreatCell } from '../src/game/campaign/team-retreat.ts';
import { GpuSelection } from '../src/game/simulation/selection.ts';
import { CpuBuildingEffects } from '../src/game/simulation/building-effects-cpu.ts';
import { GpuBuildingEffects } from '../src/game/simulation/building-effects-gpu.ts';
import * as U from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';

function equal(actual: ArrayLike<number>, expected: ArrayLike<number>, label: string) {
  if (actual.length !== expected.length) throw new Error(`${label}: length differs`);
  for (let i=0;i<actual.length;i++) if(actual[i]!==expected[i]) throw new Error(`${label}, word ${i}: ${actual[i]} != ${expected[i]}`);
}

export async function campaignRules() {
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await createRenderer(canvas,{onDeviceLost:message=>{throw new Error(message);}});
  if(!renderer)throw new Error('WebGPU is required');
  const field={grid:gridEdges(32,32,new Uint8Array(1024).fill(1),true),land:new Uint8Array(1024),passable:new Uint8Array(1024).fill(1),
    bounds:{x:1,y:1,width:30,height:30},seed:1995,campaignLevel:10};
  try {
    {
      const setup={...field,units:[{type:movementType('C10'),cell:330},{type:movementType('C1'),cell:340},
        {type:movementType('BOAT'),cell:550},{type:movementType('V19'),cell:660}]};
      const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup),frames={get:()=>Array(80)};
      const effects=new CpuBuildingEffects(cpu,frames),gpuEffects=new GpuBuildingEffects(gpu,frames);
      try{
        cpu.state[C.CFEAR]=200;cpu.state[C.CWORDS+C.CFEAR]=1;cpu.state[C.CWORDS+C.CAMMO]=0;
        cpu.units[2*U.WORDS+U.UHEALTH]=349;cpu.units[3*U.WORDS+U.UHEALTH]=99;
        (gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
        (gpu.movement.units.array as Int32Array).set(cpu.units);gpu.movement.units.needsUpdate=true;
        await gpu.prepareForPlay();await gpuEffects.prepareForPlay();
        for(let frame=1;frame<=40;frame++){
          if(frame===10){
            const commands=[{x:cpu.units[2*U.WORDS+U.UX],y:cpu.units[2*U.WORDS+U.UY],damage:200,warhead:4,source:-1,frame}];
            cpu.queueExplosions(commands);gpu.queueExplosions(commands);
          }
          cpu.step();effects.step();gpu.step();gpuEffects.step();
          if(frame===1||frame===10||frame===40){
            (await gpu.snapshot()).forEach((values,i)=>equal(values,cpu.buffers()[i],`Campaign actors ${frame}/${i}`));
            equal(new Int32Array(await renderer.three.getArrayBufferAsync(gpuEffects.state)),effects.layout.state,`Campaign attached fire ${frame}`);
          }
        }
        if(cpu.state[C.CFEAR]!==200||cpu.state[C.CWORDS+C.CAMMO]!==10||cpu.units[2*U.WORDS+U.UHEALTH]!==0)throw new Error('Campaign actor special rules changed');
      }finally{gpuEffects.dispose();gpu.dispose();}
    }
    {
      const setup={...field,multiplayer:false,units:[{type:movementType('E1'),cell:330,owner:1},{type:movementType('E1'),cell:331,owner:1},
        {type:movementType('MTNK'),cell:335,owner:0},{type:movementType('TRAN'),cell:350,owner:0}]};
      const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup),teams=new GpuTeamTargets(gpu),defense=new GpuPlacementFlush(gpu),events=new GpuCampaignEvents(gpu),selection=new GpuSelection(renderer.three,gpu.movement,gpu.sight,true);
      try{
        cpu.state[C.CACTION]=7;(gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
        teams.gesture([0,1],1);cpu.state[C.CWORDS+C.CACTION]=29;cpu.state[C.CWORDS+C.CSTAGE]=0;cpu.state[C.CWORDS+C.CFIRE]=-1;
        equal(new Int32Array(await renderer.three.getArrayBufferAsync(gpu.state)),cpu.state,'Team activation gestures');
        respondToBaseAttack(cpu,1,2,new Int32Array(4));defense.respond(1,2);
        cpu.movement.frame=1;gpu.movement.frame=1;(gpu.movement.control.array as Int32Array)[0]=1;gpu.movement.control.needsUpdate=true;
        const expected=campaignEvents(cpu,GpuCampaignEvents.initial(setup)),actual=await events.read();
        equal(actual,expected,'Base defense campaign events');if(!(actual[2*3]&BASE_PANIC))throw new Error('Base defense did not suspend campaign teams');
        const cell=20*32+20;(gpu.sight.shadow.array as Int32Array).fill(-2);gpu.sight.shadow.needsUpdate=true;
        (selection.state.array as Int32Array)[3]=1;selection.state.needsUpdate=true;
        selection.apply({action:'point',x:(cell%32)*256+128,y:Math.trunc(cell/32)*256+128});await selection.read();
        let pending=new Int32Array(await renderer.three.getArrayBufferAsync(gpu.movement.pending));if(pending[6]!==-1)throw new Error('A campaign helicopter accepted a flight into unexplored terrain');
        (gpu.sight.shadow.array as Int32Array)[cell]=-1;gpu.sight.shadow.needsUpdate=true;
        selection.apply({action:'point',x:(cell%32)*256+128,y:Math.trunc(cell/32)*256+128});await selection.read();
        pending=new Int32Array(await renderer.three.getArrayBufferAsync(gpu.movement.pending));if(pending[6]!==0||pending[7]!==cell)throw new Error('A campaign helicopter rejected an explored destination');
      }finally{selection.dispose();events.dispose();defense.dispose();teams.dispose();gpu.dispose();}
    }
    const setup={...field,units:[{type:movementType('A10'),cell:16,facing:0,altitude:24}]};
    const cpu=new CpuCombat(setup),gpu=new GpuCombat(renderer.three,setup),bombers=new GpuBombers(gpu),events=new GpuCampaignEvents(gpu);
    const state=new Int32Array(4),previous=GpuCampaignEvents.initial(setup),fired:number[]=[];
    cpu.state[C.CTARGET]=-(16*32+16)-2;cpu.state[C.CMISSION]=C.ATTACK;
    (gpu.state.array as Int32Array).set(cpu.state);gpu.state.needsUpdate=true;
    try {
      await gpu.prepareForPlay();await Promise.all([bombers.prepare(),events.prepare()]);
      for(let tick=1;tick<=1800;tick++){
        stepBombers(cpu,state);cpu.step();bombers.step();gpu.step();
        if(cpu.state[C.CLAST_FIRE]===tick)fired.push(tick);
        if(tick%60===0){
          (await gpu.snapshot()).forEach((v,i)=>equal(v,cpu.buffers()[i],`bomber ${tick}/${i}`));
          equal(new Int32Array(await renderer.three.getArrayBufferAsync(bombers.state)),state,`bomber mission ${tick}`);
          equal(await events.read(),campaignEvents(cpu,previous),`bomber events ${tick}`);
        }
      }
      if(fired.length!==10||cpu.units[U.UHEALTH]!==0)throw new Error(`Airstrike did not finish: ${fired.length} bombs`);
    }finally{events.dispose();bombers.dispose();gpu.dispose();}

    const column={...field,units:Array.from({length:16},()=>({type:movementType('E1'),cell:0,health:0}))};
    const foot=new CpuCombat(column),footGpu=new GpuCombat(renderer.three,column),lifecycle=new GpuLifecycle(footGpu);
    try {
      await footGpu.prepareForPlay();await lifecycle.prepareForPlay();
      for(let id=0;id<16;id++)lifecycle.create(id,{type:movementType('E1'),cell:16,owner:1},{mission:C.MOVE,destination:48,direct:true});
      applyLifecycle(foot,(lifecycle.commands.array as Int32Array).slice());lifecycle.flush();
      (await footGpu.snapshot()).forEach((v,i)=>equal(v,foot.buffers()[i],`reinforcement column/${i}`));
      for(let id=0;id<16;id++)if(foot.units[id*U.WORDS+U.UHEALTH]!==50)throw new Error('A reinforcement was lost at entry');
    }finally{lifecycle.dispose();footGpu.dispose();}
    const capture={...field,units:[{type:movementType('E6'),cell:330},{type:movementType('TRAN'),cell:334,owner:1}]};
    const engineer=new CpuCombat(capture),captureGpu=new GpuCombat(renderer.three,capture);
    try{
      await captureGpu.prepareForPlay();
      for(let frame=1;frame<=240;frame++){
        const orders=frame===1?[{frame,kind:'attack' as const,target:1,ids:[0]}]:[];
        engineer.step(orders);captureGpu.step(orders);
      }
      (await captureGpu.snapshot()).forEach((v,i)=>equal(v,engineer.buffers()[i],`Chinook capture/${i}`));
      if(engineer.units[U.WORDS+U.UOWNER]!==0||engineer.units[U.UHEALTH]!==0)throw new Error('Chinook capture did not finish');
    }finally{captureGpu.dispose();}
    const teamSetup={...field,units:[
      {type:movementType('E1'),cell:330,owner:1},{type:movementType('E1'),cell:331,owner:1},
      {type:movementType('MCV'),cell:334},{type:movementType('MTNK'),cell:332},{type:movementType('E1'),cell:333},
      {type:movementType('FIX'),cell:20*32+20,owner:1},{type:movementType('NUKE'),cell:20*32+8,owner:1},
    ]};
    const teamCpu=new CpuCombat(teamSetup),teamGpu=new GpuCombat(renderer.three,teamSetup),teams=new GpuTeamTargets(teamGpu);
    try{
      await teamGpu.prepareForPlay();await teams.prepare();
      for(let id=0;id<teamSetup.units.length;id++)teamCpu.state[id*C.CWORDS+C.CSEEN]=1;
      for(let phase=0;phase<5;phase++){
        const frame=phase+10;teamCpu.movement.frame=frame;
        teamCpu.state[C.CHIT_FRAME]=frame;teamCpu.state[C.CHIT_SOURCE]=5;
        const target=phase===1?3:2,suicide=phase===2;
        for(const id of [0,1])teamCpu.state[id*C.CWORDS+C.CTARGET]=target;
        // Install orders once first; subsequent calls keep the original target unless the mission changes.
        teams.set([[0,1]],[phase===4?-2:0],[phase===4?'retreat':'attack'],[suicide]);
        if(phase===0){teams.step();await renderer.three.getArrayBufferAsync(teams.state);}
        (teamGpu.units.array as Int32Array).set(teamCpu.units);teamGpu.units.needsUpdate=true;
        (teamGpu.state.array as Int32Array).set(teamCpu.state);teamGpu.state.needsUpdate=true;
        (teamGpu.movement.control.array as Int32Array)[0]=frame;teamGpu.movement.control.needsUpdate=true;
        // Each case starts without an existing retaliation override.
        (teams.state.array as Int32Array).fill(0);teams.state.needsUpdate=true;
        teams.step();
        const actual=new Int32Array(await renderer.three.getArrayBufferAsync(teamGpu.state));
        if(phase<4){
          const chosen=retaliationTarget(teamCpu,[0,1],target,suicide);
          for(const id of [0,1]){teamCpu.state[id*C.CWORDS+C.CTARGET]=chosen;teamCpu.state[id*C.CWORDS+C.CMISSION]=C.ATTACK;}
          equal(actual,teamCpu.state,`team retaliation ${phase}`);
          if(phase===3){
            (teamGpu.movement.control.array as Int32Array)[0]=frame+1;teamGpu.movement.control.needsUpdate=true;
            teams.step();equal(new Int32Array(await renderer.three.getArrayBufferAsync(teamGpu.state)),actual,'retaliation persists');
          }
        }else{
          const cell=teamRetreatCell(teamCpu,1,330),state=new Int32Array(await renderer.three.getArrayBufferAsync(teams.state));
          if(state[TEAM_TARGET_WORDS+3]!==cell)throw new Error(`Retreat point: ${state[TEAM_TARGET_WORDS+3]} != ${cell}`);
          const goals=new Int32Array(await renderer.three.getArrayBufferAsync(teamGpu.movement.goals));
          for(const id of [0,1])if(goals[id]!==cell||actual[id*C.CWORDS+C.CMISSION]!==C.MOVE)throw new Error('Team did not retreat together');
        }
      }
      // EVENT.CPP MEGAMISSION removes manually commanded ground units from their team.
      const units=teamGpu.units.array as Int32Array;
      for(let id=0;id<teamSetup.units.length;id++)units[id*U.WORDS+U.UOWNER]=id<2?0:1;
      teamGpu.units.needsUpdate=true;
      const selection=new GpuSelection(renderer.three,teamGpu.movement,teamGpu.sight,true);
      try{
        await selection.prepare();selection.state.array[0]=1;selection.state.needsUpdate=true;
        selection.apply({action:'stop'});teamGpu.step();
        teams.set([[0,1]],[0],['manual takeover']);teams.step();
        const state=new Int32Array(await renderer.three.getArrayBufferAsync(teamGpu.state));
        if(state[C.CMISSION]!==C.GUARD||state[C.CWORDS+C.CMISSION]!==C.ATTACK)throw new Error('The scripted team overrode a manual stop order');
      }finally{selection.dispose();}
    }finally{teams.dispose();teamGpu.dispose();}
    const idleSetup={...field,allies:[3,3],units:[{type:movementType('C10'),cell:528,owner:1},
      {type:movementType('MOEBIUS'),cell:132},{type:movementType('E1'),cell:136}]};
    const idleCpu=new CpuCombat(idleSetup),idleGpu=new GpuCombat(renderer.three,idleSetup);
    try{
      await idleGpu.prepareForPlay();let wandered=false,animated=false;
      for(let frame=1;frame<=900;frame++){
        idleCpu.step();idleGpu.step();
        wandered ||= idleCpu.units[U.UCELL]!==528;
        animated ||= idleCpu.state[2*C.CWORDS+C.CACTION]>=9;
        if(frame%90===0)(await idleGpu.snapshot()).forEach((values,i)=>equal(values,idleCpu.buffers()[i],`idle infantry ${frame}/${i}`));
      }
      if(!wandered||!animated)throw new Error('Original infantry idle actions did not occur');
      if(idleCpu.units[U.WORDS+U.UCELL]!==132)throw new Error('Player-owned Moebius wandered without an order');
    }finally{idleGpu.dispose();}
    return {bombs:fired.length,reinforcements:16};
  }finally{renderer.dispose();canvas.remove();}
}
