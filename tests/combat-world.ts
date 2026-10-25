import type { WebGPURenderer } from 'three/webgpu';
import { gridEdges } from '../src/engine/simulation/state.ts';
import { movementType } from '../src/game/data/movement.ts';
import { CpuCombat } from '../src/game/simulation/combat-cpu.ts';
import { GpuCombat } from '../src/game/simulation/combat-gpu.ts';
import type { UnitCommand, UnitPlacement } from '../src/game/simulation/units-state.ts';
import { WORDS, UHEALTH } from '../src/game/simulation/units-state.ts';
import * as C from '../src/game/simulation/combat-state.ts';
import { backlineScenario } from './backline-scenario.ts';

/** Separate rooms share shader construction. The original CPU rule fixtures stay independent. */
export async function compareCombatWorld(renderer: WebGPURenderer, everyTick = false) {
  const width = 64, units: UnitPlacement[] = [], parents: number[] = [];
  const setup: C.CombatSetup = {grid:{width,height:width,edges:new Uint32Array(width * width)},
    land:new Uint8Array(width * width),units,crewParents:parents,seed:0x1995};
  const place = (source: C.CombatSetup, x: number, y: number) => {
    const first = units.length;
    const cell = (value: number) => (y + Math.floor(value / source.grid.width)) * width + x + value % source.grid.width;
    for (let i = 0; i < source.grid.edges.length; i++) {
      setup.grid.edges[cell(i)] = source.grid.edges[i];
      setup.land[cell(i)] = source.land[i];
    }
    units.push(...source.units.map(u => ({...u,cell:cell(u.cell)})));
    parents.push(...source.units.map((_, id) => {
      const parent = source.crewParents?.[id] ?? -1;
      return parent < 0 ? -1 : first + parent;
    }));
    return {first,cell};
  };
  // Preserve rear-rank IDs and seed. Gaps separate initial guard scans; HUNT remains global.
  place(backlineScenario(), 0, 0);
  const mixed = place({grid:gridEdges(32,24,new Uint8Array(768).fill(1),true),land:new Uint8Array(768),seed:setup.seed,
    units:[{cell:130,type:movementType('MTNK'),facing:64},{cell:134,type:movementType('MTNK'),owner:1,facing:192},
      {cell:450,type:movementType('E1'),facing:64},{cell:452,type:movementType('E1'),owner:1,facing:192},
      {cell:153,type:movementType('FTNK'),facing:64},{cell:155,type:movementType('E2'),owner:1,facing:192},
      {cell:472,type:movementType('BIKE'),facing:64},{cell:476,type:movementType('JEEP'),owner:1,facing:192},
      {cell:734,type:movementType('E1'),health:0,owner:1}],crewParents:[-1,-1,-1,-1,-1,-1,-1,-1,1]}, 0, 40);
  const collision = place({grid:gridEdges(8,8,new Uint8Array(64).fill(1),true),land:new Uint8Array(64),seed:setup.seed,
    units:Array.from({length:64},(_,id)=>({cell:id,type:movementType('MTNK'),health:id ? 0 : 400}))}, 48, 48);
  const commands: (UnitCommand | C.AttackCommand)[] = [
    {frame:1,kind:'attack',target:40,ids:Array.from({length:40},(_,i)=>i)},
    {frame:1,kind:'attack',target:mixed.first + 1,ids:[mixed.first]},
  ];
  const victims: {id:number;crushed:boolean}[] = [];
  const overrunEdges = gridEdges(16,32,new Uint8Array(512).fill(1),true).edges;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++)
    setup.grid.edges[y * width + 48 + x] = overrunEdges[y * 16 + x];
  for (const [row, name, owner] of [[2,'MTNK',1],[10,'JEEP',1],[18,'MTNK',0],[26,'MTNK',1]] as const) {
    const tank = units.length, cell = (x: number) => row * width + 48 + x;
    units.push({cell:cell(2),type:movementType(name),facing:64});
    parents.push(-1);
    commands.push({frame:1,kind:'move',target:cell(row === 26 ? 3 : 6),ids:[tank]});
    if (row === 26) {
      units.push({cell:cell(4),type:movementType('MTNK'),facing:192});
      parents.push(-1);
      commands.push({frame:1,kind:'move',target:cell(3),ids:[tank + 1]});
    }
    for (let slot = 0; slot < (row === 2 ? 5 : 1); slot++) {
      victims.push({id:units.length,crushed:name === 'MTNK' && owner === 1});
      units.push({cell:cell(3),type:movementType('C1'),slot,owner,health:10000});
      parents.push(-1);
    }
  }
  const celebration=place({grid:gridEdges(8,8,new Uint8Array(64).fill(1),true),land:new Uint8Array(64),seed:setup.seed,
    units:[{cell:18,type:movementType('RMBO'),facing:64},{cell:20,type:movementType('C1'),owner:1,health:1}]},37,33);
  // INFANTRY.CPP Mission_Guard: human commandos require an explicit attack order.
  commands.push({frame:1,kind:'attack',target:celebration.first+1,ids:[celebration.first]});
  const cpu = new CpuCombat(setup), gpu = new GpuCombat(renderer, setup);
  try {
    for (let id = 0; id < 256; id++) {
      const b = (collision.first * C.SHOTS_PER_UNIT + id) * C.BWORDS, p = cpu.projectiles;
      p[b] = p[b + C.BTO_X] = cpu.units[collision.first * WORDS];
      p[b + 1] = p[b + C.BTO_Y] = cpu.units[collision.first * WORDS + 1];
      p[b + C.BACTIVE] = p[b + C.BTIMER] = 1;
      p[b + C.BTYPE] = 2;
      p[b + C.BDAMAGE] = 25;
      p[b + C.BSOURCE] = celebration.first;
    }
    (gpu.projectiles.array as Int32Array).set(cpu.projectiles);
    gpu.projectiles.needsUpdate = true;
    for (let tick = 1; tick <= 2000; tick++) {
      // Refill an idle, nonzero projectile slot after its earlier queue has
      // drained. This also exercises external save-state uploads between ticks.
      const refilled = (collision.first * C.SHOTS_PER_UNIT + 511) * C.BWORDS;
      if (tick === 901 || tick === 1201) {
        const p = cpu.projectiles;
        p.fill(0, refilled, refilled + C.BWORDS);
        p[refilled] = p[refilled + C.BTO_X] = cpu.units[collision.first * WORDS];
        p[refilled + 1] = p[refilled + C.BTO_Y] = cpu.units[collision.first * WORDS + 1];
        p[refilled + C.BACTIVE] = p[refilled + C.BTIMER] = 1;
        p[refilled + C.BTYPE] = 2;
        p[refilled + C.BSOURCE] = -1;
        (gpu.projectiles.array as Int32Array).set(p);
        gpu.projectiles.needsUpdate = true;
      }
      cpu.step(tick === 1 ? commands : []);
      if (tick === 1) gpu.step(commands);
      const victimDeath=cpu.state[(celebration.first+1)*C.CWORDS+C.CDEATH];
      // Union of every original checkpoint; no case loses a state comparison.
      const sample = everyTick || tick <= 8 || (tick <= 780 && tick % 30 === 0) ||
        (tick <= 150 && tick % 10 === 0) || tick % 60 === 0 || tick === 2000 || (victimDeath>0 && tick===victimDeath+30) ||
        (tick >= 901 && tick <= 903) || (tick >= 1201 && tick <= 1203);
      if (sample) {
        gpu.stepMany(tick - gpu.frame);
        const actual = await gpu.snapshot(), expected = cpu.buffers();
        for (let i = 0; i < expected.length; i++) for (let j = 0; j < expected[i].length; j++)
          if (expected[i][j] !== actual[i][j]) {
            const id=i===1?Math.floor(j/WORDS):i===10?Math.floor(j/C.CWORDS):-1;
            const detail=id<0?'':JSON.stringify({id,
              cpu:Array.from(expected[1].slice(id*WORDS,(id+1)*WORDS)),gpu:Array.from(actual[1].slice(id*WORDS,(id+1)*WORDS)),
              stateCpu:Array.from(expected[10].slice(id*C.CWORDS,(id+1)*C.CWORDS)),stateGpu:Array.from(actual[10].slice(id*C.CWORDS,(id+1)*C.CWORDS))});
            throw new Error(`Combat rooms tick ${tick}, buffer ${i}, word ${j}: ${expected[i][j]}/${actual[i][j]} ${detail}`);
          }
      }
      if (tick === 1) {
        if(cpu.state[celebration.first*C.CWORDS+C.CKILLS]!==1)
          throw new Error('Simultaneous impacts must credit their single casualty exactly once');
        for (let id = 0; id < 64; id++) if (cpu.units[(collision.first + id) * WORDS + UHEALTH] !== 0)
          throw new Error('Simultaneous shell impacts must kill their target without activating dormant units');
      }
      if ((tick === 901 || tick === 1201) && cpu.projectiles[refilled + C.BIMPACT] !== 1)
        throw new Error('Refilled projectile did not emit its impact on the original fuse tick');
      if ((tick === 902 || tick === 1202) && cpu.projectiles[refilled + C.BIMPACT] !== 0)
        throw new Error('Retired projectile emitted its impact more than once');
      if(victimDeath>0 && tick===victimDeath+30) {
        const at=celebration.first*C.CWORDS;
        if(cpu.state[at+C.CKILLS]!==2 || cpu.state[at+C.CCELEBRATED]!==tick || ![27,29].includes(cpu.state[at+C.CACTION]))
          throw new Error('Commando did not celebrate both credited kills after the last two-second delay');
      }
      if (tick === 150) for (const {id, crushed} of victims) {
        if ((cpu.units[id * WORDS + UHEALTH] === 0) !== crushed) throw new Error(`Unexpected overrun result for unit ${id}`);
        if (crushed && cpu.state[id * C.CWORDS + C.CWARHEAD] !== C.CRUSHED) throw new Error(`Overrun triggered a normal death for unit ${id}`);
      }
    }
    for (let id = 0; id < 40; id++) if (cpu.units[id * WORDS + UHEALTH] > 0 && cpu.state[id * C.CWORDS + C.CLAST_FIRE] < 0)
      throw new Error(`Rear unit ${id} never fired`);
    if(cpu.state[(celebration.first+1)*C.CWORDS+C.CDEATH]<1) throw new Error('Commando never killed his local target');
    return {ticks:2000,units:units.length,scenarios:5,simultaneousHits:256};
  } finally { gpu.dispose(); }
}

