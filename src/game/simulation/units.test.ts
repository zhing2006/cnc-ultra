import { describe,it,expect } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { CpuFlowFields } from '../../engine/simulation/flow.ts';
import { movementType } from '../data/movement.ts';
import { CpuUnits,rotateFacing } from './units-cpu.ts';
import { CpuSight } from './sight.ts';
import * as S from './units-state.ts';
import { distance } from '../coord.ts';

function setup(name='MTNK',facing=64,health?:number):S.UnitsSetup {
  return {grid:gridEdges(8,5,new Uint8Array(40).fill(1),true),land:new Uint8Array(40),seed:0x1995,
    units:[{cell:17,type:movementType(name),facing,health}]};
}
function arrival(s:S.UnitsSetup){
  const cpu=new CpuUnits(s);cpu.step([{frame:1,kind:'move',target:18,ids:[0]}]);
  while(cpu.units[S.UCELL]!==18&&cpu.frame<200)cpu.step();return cpu;
}

describe('original unit movement',()=>{
  it.each([[9,'MTNK'],[12,'MTNK'],[16,'MTNK'],[12,'JEEP'],[30,'E1']] as const)(
    'settles all %i %s after a shared destination becomes occupied', (count,name)=>{
      const width=40,height=24,target=12*width+30;
      const units=Array.from({length:count},(_,id)=>({
        cell:(4+(id%4)*2)*width+3+Math.floor(id/4)*2,type:movementType(name),facing:64,
      }));
      const cpu=new CpuUnits({grid:gridEdges(width,height,new Uint8Array(width*height).fill(1),true),
        land:new Uint8Array(width*height),seed:0x1995,units});
      cpu.step([{frame:1,kind:'move',target,ids:units.map((_,id)=>id)}]);
      while(cpu.frame<3000)cpu.step();
      // DRIVE.CPP Start_Of_Move: occupied arrival cells lead to scattering or a bounded
      // path failure, never an endless sequence of successful backward detours.
      expect(Array.from(cpu.goals)).toEqual(new Array(count).fill(-1));
      expect(units.map((_,id)=>cpu.units[id*S.WORDS+S.UDEST])).toEqual(new Array(count).fill(-1));
      const positions=units.map((_,id)=>Array.from(cpu.units.subarray(id*S.WORDS,id*S.WORDS+3)));
      while(cpu.frame<3600)cpu.step();
      expect(units.map((_,id)=>Array.from(cpu.units.subarray(id*S.WORDS,id*S.WORDS+3)))).toEqual(positions);
      for(let id=0;id<count;id++)expect(distance(cpu.units[id*S.WORDS],cpu.units[id*S.WORDS+1],30*256+128,12*256+128)).toBeLessThan(4*256);
    });
  it('abandons opposing orders when a one-cell corridor has no route around the blocker',()=>{
    const width=20,passable=new Uint8Array(width*5);
    for(let x=0;x<width;x++)passable[2*width+x]=1;
    const cpu=new CpuUnits({grid:gridEdges(width,5,passable,true),passable,land:new Uint8Array(passable.length),seed:0x1995,
      units:[{cell:43,type:movementType('MTNK'),facing:64},{cell:56,type:movementType('MTNK'),facing:192}]});
    cpu.step([{frame:1,kind:'move',target:59,ids:[0]},{frame:1,kind:'move',target:40,ids:[1]}]);
    while(cpu.frame<2000)cpu.step();
    // UNIT.CPP Can_Enter_Cell returns MOVE_NO; failed paths exhaust FOOT.H PATH_RETRY.
    expect(Array.from(cpu.goals)).toEqual([-1,-1]);
    const positions=[cpu.units[S.UCELL],cpu.units[S.WORDS+S.UCELL]];
    while(cpu.frame<2600)cpu.step();
    expect([cpu.units[S.UCELL],cpu.units[S.WORDS+S.UCELL]]).toEqual(positions);
  });
  it('routes around an intervening tree before stopping at the shore of an impassable lake',()=>{
    const width=30,height=9,passable=new Uint8Array(width*height).fill(1);
    for(let y=0;y<height;y++)for(let x=20;x<width;x++)passable[y*width+x]=0;
    passable[4*width+8]=0;
    const cpu=new CpuUnits({grid:gridEdges(width,height,passable,true),passable,land:new Uint8Array(passable.length),seed:1995,
      units:[{cell:4*width+2,type:movementType('MTNK'),facing:64}]});
    cpu.step([{frame:1,kind:'move',target:4*width+25,ids:[0]}]);
    while(cpu.frame<1600)cpu.step();
    // FINDPATH.CPP Find_Path crosses intermediate obstacles in its search, then
    // Follow_Edge routes around them. Only the obstacle containing the goal ends the prefix.
    expect(cpu.units[S.UCELL]).toBe(4*width+19);
    expect(cpu.goals[0]).toBe(-1);
  });
  it('keeps a backed-up infantry stopping point in its coordinate cell',()=>{
    const s=setup('E1');s.units=[{cell:17,type:movementType('E1'),facing:64,slot:1}];
    const cpu=new CpuUnits(s);cpu.step([{frame:1,kind:'move',target:19,ids:[0]}]);cpu.step();
    // CELL.CPP Closest_Free_Spot masks the backed-up coordinate with 0xFF00FF00,
    // not the cell whose occupancy it queried. From NW to east, the first stop is NE here.
    expect([cpu.units[S.UHEAD_X],cpu.units[S.UHEAD_Y]]).toEqual([1*256+192,2*256+64]);
    while(cpu.units[S.UDEST]>=0)cpu.step();
    expect(cpu.units[S.UCELL]).toBe(17);
    expect(cpu.goals[0]).toBe(19);
  });
  it('approaches an impassable destination through the first legal neighbor on its own side',()=>{
    const width=16,passable=new Uint8Array(width*9).fill(1),target=4*width+8;
    passable[target]=0;
    const s:S.UnitsSetup={grid:gridEdges(width,9,passable,true),passable,land:new Uint8Array(passable.length),seed:1995,
      units:[{cell:4*width+2,type:movementType('MTNK'),facing:64},{cell:4*width+14,type:movementType('MTNK'),facing:192}]};
    const cpu=new CpuUnits(s);cpu.step([{frame:1,kind:'move',target,ids:[0,1]}]);cpu.step();
    // FOOT.CPP Basic_Path: offsets 0,+1,-1,... begin on each unit's side of the clicked cell.
    expect(cpu.units[S.USTARTED]).toBe(2);
    expect(cpu.units[S.WORDS+S.USTARTED]).toBe(2);
    while(cpu.frame<500)cpu.step();
    expect([cpu.units[S.UCELL],cpu.units[S.WORDS+S.UCELL]]).toEqual([target-1,target+1]);
    expect(Array.from(cpu.goals)).toEqual([-1,-1]);
  });
  it('does not redirect a nearby impassable destination past the original three-cell threshold',()=>{
    const s=setup(),passable=new Uint8Array(40).fill(1);passable[18]=0;
    s.passable=passable;s.grid=gridEdges(8,5,passable,true);
    const cpu=new CpuUnits(s);cpu.step([{frame:1,kind:'move',target:18,ids:[0]}]);
    while(cpu.frame<10)cpu.step();
    expect(cpu.units[S.UCELL]).toBe(17);expect(cpu.goals[0]).toBe(-1);
  });
  it('skips an occupied cliff neighbor in the original angular search order',()=>{
    const width=16,passable=new Uint8Array(144).fill(1),target=72;passable[target]=0;
    const s:S.UnitsSetup={grid:gridEdges(width,9,passable,true),passable,land:new Uint8Array(144),seed:1995,
      units:[{cell:66,type:movementType('MTNK'),facing:64},{cell:71,type:movementType('MTNK')}]};
    const cpu=new CpuUnits(s);cpu.step([{frame:1,kind:'move',target,ids:[0]}]);cpu.step();
    // From the west: W, NW, SW, N, S, NE, SE, E. W is occupied, so NW wins.
    expect(cpu.pathGoals[0]).toBe(55);
    expect(cpu.goals[0]).toBe(target);
  });
  it('keeps the reachable prefix when the clicked cell is inside a cliff',()=>{
    for(const deep of [false,true]){
      const width=16,passable=new Uint8Array(144).fill(1),target=72;
      if(deep)for(let y=3;y<=5;y++)for(let x=7;x<=9;x++)passable[y*width+x]=0;
      else passable[target]=0;
      const start=deep?66:70;
      const s:S.UnitsSetup={grid:gridEdges(width,9,passable,true),passable,land:new Uint8Array(144),seed:1995,
        units:[{cell:start,type:movementType('MTNK'),facing:64}]};
      const cpu=new CpuUnits(s);cpu.step([{frame:1,kind:'move',target,ids:[0]}]);
      while(cpu.frame<300)cpu.step();
      // FINDPATH.CPP Find_Path retains the legal prefix when it cannot enter the destination.
      expect(cpu.units[S.UCELL]).toBe(deep?70:71);
      expect(cpu.goals[0]).toBe(-1);
    }
  });
  it('breaks a four-way friendly traffic wait without dropping any reachable order',()=>{
    const width=16;
    const s:S.UnitsSetup={grid:gridEdges(width,16,new Uint8Array(256).fill(1),true),land:new Uint8Array(256),seed:1995,
      units:[{cell:85,type:movementType('MTNK'),facing:64},{cell:86,type:movementType('MTNK'),facing:128},
        {cell:102,type:movementType('MTNK'),facing:192},{cell:101,type:movementType('MTNK'),facing:0}]};
    const targets=[90,166,97,21],cpu=new CpuUnits(s);
    cpu.step(targets.map((target,id)=>({frame:1,kind:'move',target,ids:[id]})));
    while(cpu.frame<500)cpu.step();
    // Flow routing may change the path, but congestion must not cancel orders away from the destination.
    expect(targets.map((_,id)=>cpu.units[id*S.WORDS+S.UCELL])).toEqual(targets);
    expect(Array.from(cpu.goals)).toEqual([-1,-1,-1,-1]);
  });
  it('brings a mixed group through a one-cell opening without leaving units behind',()=>{
    const width=24,height=12,passable=new Uint8Array(width*height).fill(1),target=6*width+21;
    for(let y=0;y<height;y++)if(y!==6)passable[y*width+12]=0;
    const placements:S.UnitPlacement[]=[
      {cell:4*width+3,type:movementType('MTNK'),facing:64},{cell:5*width+3,type:movementType('HTNK'),facing:64},
      {cell:6*width+3,type:movementType('JEEP'),facing:64},{cell:7*width+3,type:movementType('APC'),facing:64},
      ...Array.from({length:10},(_,id)=>({cell:(5+Math.floor(id/5))*width+2,type:movementType('E1'),slot:id%5,facing:64})),
    ];
    const s:S.UnitsSetup={grid:gridEdges(width,height,passable,true),passable,land:new Uint8Array(width*height),seed:1995,units:placements};
    const cpu=new CpuUnits(s);cpu.step([{frame:1,kind:'move',target,ids:placements.map((_,i)=>i)}]);
    const approached=new Set<number>();
    while(cpu.frame<2200){
      cpu.step();
      for(let id=0;id<placements.length;id++)
        if(distance(cpu.units[id*S.WORDS],cpu.units[id*S.WORDS+1],21*256+128,6*256+128)<0x280)approached.add(id);
    }
    expect(approached.size).toBe(placements.length);
    for(let id=0;id<placements.length;id++){
      const at=id*S.WORDS;
      expect(cpu.goals[id],`unit ${id} still holds its order`).toBe(-1);
      expect(cpu.units[at+S.UDEST],`unit ${id} is still moving`).toBe(-1);
    }
    const positions=placements.map((_,id)=>Array.from(cpu.units.subarray(id*S.WORDS,id*S.WORDS+3)));
    while(cpu.frame<2800)cpu.step();
    expect(placements.map((_,id)=>Array.from(cpu.units.subarray(id*S.WORDS,id*S.WORDS+3)))).toEqual(positions);
  });
  it('abandons an unreachable order after the original path retries',()=>{
    const s=setup(),passable=new Uint8Array(40).fill(1);
    for(let y=0;y<5;y++)passable[y*8+4]=0;
    s.grid=gridEdges(8,5,passable,true);
    const cpu=new CpuUnits(s);
    cpu.step([{frame:1,kind:'move',target:22,ids:[0]}]);
    // DRIVE.CPP Start_Of_Move eventually clears NavCom after failed Basic_Path calls.
    while(cpu.frame<200)cpu.step();
    expect(cpu.goals[0]).toBe(-1);
  });
  it('reroutes close opposing vehicles instead of treating them as moving blockers forever',()=>{
    const s=setup();s.units=[{cell:18,type:movementType('MTNK'),facing:64},{cell:19,type:movementType('MTNK'),facing:192}];
    const cpu=new CpuUnits(s);
    cpu.step([{frame:1,kind:'move',target:22,ids:[0]},{frame:1,kind:'move',target:16,ids:[1]}]);
    // UNIT.CPP Can_Enter_Cell: opposing allied vehicles within 0x1ff return MOVE_NO.
    while(cpu.frame<300)cpu.step();
    expect([cpu.units[S.UCELL],cpu.units[S.WORDS+S.UCELL]]).not.toEqual([18,19]);
  });
  it('uses the entry-side infantry spot and reserves all five spots on the same tick',()=>{
    const s=setup('E1');
    s.units=Array.from({length:5},(_,slot)=>({cell:17,type:movementType('E1'),facing:64,slot}));
    const cpu=new CpuUnits(s);cpu.step([{frame:1,kind:'move',target:18,ids:[0,1,2,3,4]}]);cpu.step();
    // INFANTRY.CPP Start_Driver backs the target up by 0x7c before Closest_Free_Spot.
    // FACINGFF.ASM returns 63 for east; reversing gives 191. COORD.CPP's tables
    // produce local (5,131), whose Spot_Index is 3 (not an idealized left midpoint).
    expect(cpu.units[S.UDSLOT]).toBe(3);
    expect(Array.from({length:5},(_,id)=>cpu.units[id*S.WORDS+S.USTARTED])).toEqual([2,2,2,2,2]);
    expect(new Set(Array.from({length:5},(_,id)=>cpu.units[id*S.WORDS+S.UDSLOT])).size).toBe(5);
  });
  it('jumps into the next curve without stopping to rotate',()=>{
    const width=8,passable=new Uint8Array(64);
    for(const cell of [42,34,27,28,29])passable[cell]=1;
    const s:S.UnitsSetup={grid:gridEdges(width,8,passable,true),land:new Uint8Array(64),seed:0x1995,
      units:[{cell:42,type:movementType('MTNK'),facing:0}]};
    const cpu=new CpuUnits(s);cpu.step([{frame:1,kind:'move',target:29,ids:[0]}]);
    let jumped=false;
    // DRIVE.CPP While_Moving: north/NE Track3 jumps at 37 to NE/east Track6 Entry 16.
    while(cpu.frame<150){
      const previous=cpu.units[S.UTRACK];cpu.step();
      if(previous===1&&cpu.units[S.UTRACK]===10&&cpu.units[S.UTRACK_STEP]>=16)jumped=true;
    }
    expect(jumped).toBe(true);
  });
  it('uses the original track accumulator and terrain speed, including damaged vehicles',()=>{
    // DRIVE.CPP Track1 has 23 positions and a terminator. While_Moving consumes only
    // when the accumulator is > 10 (DISPLAY.H uses integer 256 / 24).
    // UDATA.CPP gives MTNK 18; Ground gives 112 or 160.
    // COORDA.ASM, Fixed_To_Cardinal adds 128 before shifting: 8, 11 and 6 leptons/tick.
    expect(arrival(setup()).frame).toBe(32);
    const road=setup();road.land.fill(1);expect(arrival(road).frame).toBe(23);
    expect(arrival(setup('MTNK',64,199)).frame).toBe(42);
  });
  it('executes orders after logic and turns before starting a track',()=>{
    const cpu=new CpuUnits(setup('MTNK',0));cpu.step([{frame:1,kind:'move',target:18,ids:[0]}]);
    expect(cpu.units[S.UDESIRED]).toBe(0);
    cpu.step();expect(cpu.units[S.UDESIRED]).toBe(64);expect(cpu.units[S.UFACE]).toBe(0);
    cpu.step();expect(cpu.units[S.UFACE]).toBe(5);expect(cpu.units[S.UROTATED]).toBe(3);
    while(cpu.frame<16)cpu.step();expect(cpu.units[S.USTARTED]).toBe(16);
  });
  it('takes 52 rotation updates for four quarter turns at MTNK rate 5',()=>{
    let facing=0,ticks=0;
    for(const target of [64,128,192,0])while(facing!==target){facing=rotateFacing(facing,target,5);ticks++;}
    expect(ticks).toBe(52);expect(rotateFacing(0,128,5)).toBe(251);
  });
  it('moves infantry after Start_Driver and snaps within 16 leptons',()=>{
    const cpu=new CpuUnits(setup('E1'));cpu.step([{frame:1,kind:'move',target:18,ids:[0]}]);cpu.step();
    expect([cpu.units[S.UX],cpu.units[S.UY]]).toEqual([384,640]);
    expect([cpu.units[S.UHEAD_X],cpu.units[S.UHEAD_Y]]).toEqual([576,704]);
    cpu.step();expect([cpu.units[S.UX],cpu.units[S.UY]]).not.toEqual([384,640]);
    while(cpu.units[S.UDEST]>=0)cpu.step();
    expect([cpu.units[S.UX],cpu.units[S.UY]]).toEqual([576,704]);
  });
  it('keeps active target fields unchanged while reclaiming unused fields',()=>{
    const s=setup(),flow=new CpuFlowFields(s.grid,2),goals=new Int32Array([2,37]);flow.step(goals);
    const second=flow.lookup[37],before=flow.distance.slice(second*40,(second+1)*40),bytes=flow.distance.byteLength;
    for(let target=3;target<30;target++){
      goals[0]=target;flow.step(goals);expect(flow.lookup[37]).toBe(second);
      expect(flow.distance.slice(second*40,(second+1)*40)).toEqual(before);expect(flow.distance.byteLength).toBe(bytes);
      expect(Array.from(flow.lookup).filter(x=>x>=0)).toHaveLength(2);
    }
  });
  it('bounds flow storage independently of unit count and serves targets after pool exhaustion',()=>{
    const grid=gridEdges(16,16,new Uint8Array(256).fill(1),true),flow=new CpuFlowFields(grid,20000);
    const bytes=flow.distance.byteLength,goals=Int32Array.from({length:20000},(_,i)=>i%100),served=new Set<number>();
    for(let tick=0;tick<5;tick++){
      flow.step(goals);
      for(let target=0;target<100;target++){
        const slot=flow.lookup[target];if(slot>=0&&flow.fields[slot*3+1])served.add(target);
      }
    }
    expect(served.size).toBe(100);
    expect(flow.distance.byteLength).toBe(bytes);
    expect(flow.capacity).toBeLessThanOrEqual(64);
    expect(bytes).toBeLessThanOrEqual(16*1024*1024);
  });
  it('retains explored terrain after a scout leaves, with the original sight footprint',()=>{
    const s=setup('E1'),units=S.initialUnits(s),sight=new CpuSight(8,5,1);sight.step(units);
    // MAP.CPP radius 1 includes the center and all eight neighbors.
    expect([8,9,10,16,17,18,24,25,26].map(i=>sight.current[i])).toEqual(new Array(9).fill(1));
    expect(sight.current.reduce((a,b)=>a+b)).toBe(9);
    units[S.UX]=6*256+128;sight.step(units);expect(sight.current[17]).toBe(0);expect(sight.mapped[17]).toBe(1);
  });
  it.each(['TRAN','ORCA','HELI','A10'])('reveals one cell around a flying %s and retains its explored route',name=>{
    // Design constitution §3: approved aircraft sight exception; MAP.CPP Sight_From footprint.
    const units=S.initialUnits(setup(name)),sight=new CpuSight(8,5,1);
    units[S.UALTITUDE]=24;sight.step(units);
    expect(sight.current.reduce((a,b)=>a+b)).toBe(9);
    expect(sight.mapped[17]).toBe(1);
    units[S.UX]=6*256+128;sight.step(units);
    expect(sight.current[22]).toBe(1);expect(sight.current[17]).toBe(0);expect(sight.mapped[17]).toBe(1);
  });
});
