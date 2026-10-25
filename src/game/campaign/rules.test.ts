import { expect, it } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { randomWord } from '../../engine/simulation/fixed.ts';
import { movementType } from '../data/movement.ts';
import { CpuCombat } from '../simulation/combat-cpu.ts';
import { applyLifecycle } from '../simulation/lifecycle-cpu.ts';
import { CHANGE_WORDS, CREATE, DIRECT_ENTRY, INITIAL_ORDER } from '../simulation/lifecycle-state.ts';
import * as U from '../simulation/units-state.ts';
import * as C from '../simulation/combat-state.ts';
import { stepBombers } from './bombers.ts';
import { retaliationTarget } from './team-targets.ts';
import { teamRetreatCell } from './team-retreat.ts';
import { CpuBuildingEffects } from '../simulation/building-effects-cpu.ts';
import * as E from '../simulation/building-effects-state.ts';
import { ANIMATION_IDS as A } from '../data/combat.ts';
import { campaignEvents, GpuCampaignEvents, ATTACKED, CAPTURED, DESTROYED, DISCOVERED, ENTERED, EVACUATED, REMOVED, SABOTAGED } from './events.ts';

const field = () => ({ grid: gridEdges(32, 32, new Uint8Array(1024).fill(1), true), land: new Uint8Array(1024),
  passable: new Uint8Array(1024).fill(1), bounds: { x: 1, y: 1, width: 30, height: 30 }, seed: 1995, campaignLevel: 10 });

it('keeps Nikoomba afraid, makes civilians run and reloads a brave civilian', () => {
  const battle = new CpuCombat({...field(),units:[{type:movementType('C10'),cell:330},{type:movementType('C1'),cell:340}]});
  battle.state[C.CFEAR]=200;battle.state[C.CWORDS+C.CFEAR]=1;battle.state[C.CWORDS+C.CAMMO]=0;
  battle.step();
  expect(battle.state[C.CFEAR]).toBe(200);
  expect(battle.units[U.USPEED]).toBe(510);
  expect(battle.state[C.CWORDS+C.CAMMO]).toBe(10);
});

it('sets a half-destroyed oil derrick on fire at its original attachment point', () => {
  const battle=new CpuCombat({...field(),units:[{type:movementType('V19'),cell:330}]});
  const effects=new CpuBuildingEffects(battle,{get:()=>Array(40)});
  battle.units[U.UHEALTH]=99;effects.step();
  const {state,base,capacity}=effects.layout;
  const slots=Array.from({length:capacity},(_,i)=>base+i*E.EFFECT_WORDS);
  const oil=slots.find(at=>state[at+E.ETYPE]===A.ANIM_OILFIELD_BURN+1);
  expect(oil).toBeDefined();
  expect(state[oil!+E.EPARENT]).toBe(1);
  // TYPE.H Coord_Fixup anchors the original building at its cell corner.
  expect(battle.units[U.UX]+state[oil!+E.EX]).toBe((330%32)*256+304);
  expect(battle.units[U.UY]+state[oil!+E.EY]).toBe(Math.trunc(330/32)*256+64);
});

it('rounds signed gunboat fire offsets as FUNCTION.H Pixel_To_Lepton does', () => {
  for(let seed=0;seed<32;seed++){
    const battle=new CpuCombat({...field(),seed,units:[{type:movementType('BOAT'),cell:330}]});
    const effects=new CpuBuildingEffects(battle,{get:()=>Array(40)});
    battle.units[U.UHEALTH]=349;effects.step();
    const {state,base}=effects.layout,pixelX=randomWord(seed,0,0,322)%17-8;
    expect(state[base+E.EX]).toBe(Math.trunc((pixelX*256+12)/24));
    expect(state[base+E.EY]).toBe(-20);
  }
});

it('destroys a gunboat hit directly by an Obelisk laser', () => {
  const battle=new CpuCombat({...field(),units:[{type:movementType('BOAT'),cell:330}]});
  battle.queueExplosions([{x:battle.units[U.UX],y:battle.units[U.UY],damage:200,warhead:4,source:-1,frame:1}]);
  battle.step();expect(battle.units[U.UHEALTH]).toBe(0);
});

it('turns an arriving A10 at the world edge and drops the original three-run bomb sequence', () => {
  // REINF.CPP initially faces north, even when arriving through the northern edge.
  const battle = new CpuCombat({ ...field(), units: [{ type: movementType('A10'), cell: 16, facing: 0, altitude: 24 }] });
  const state = new Int32Array(4), fired: number[] = [];
  battle.state[C.CTARGET] = -(16 * 32 + 16) - 2; battle.state[C.CMISSION] = C.ATTACK;
  for (let tick = 1; tick <= 2400 && battle.units[U.UHEALTH]; tick++) {
    stepBombers(battle, state); battle.step();
    if (battle.state[C.CLAST_FIRE] === tick) fired.push(tick);
  }
  // Mission_Hunt deliberately calls Fire_At even after the final empty-ammo retreat.
  expect(fired).toHaveLength(10);
  expect(fired[1] - fired[0]).toBe(5); expect(fired[2] - fired[1]).toBe(5);
  expect(battle.units[U.UHEALTH]).toBe(0);
  expect(state[2]).toBe(0);
});

it('places an entire reinforcement column outside the radar without overlapping infantry spots', () => {
  const setup = { ...field(), units: Array.from({ length: 16 }, () => ({ type: movementType('E1'), cell: 0, health: 0 })) };
  const battle = new CpuCombat(setup), commands = new Int32Array(16 * CHANGE_WORDS);
  for (let id = 0; id < 16; id++) commands.set([CREATE | DIRECT_ENTRY | INITIAL_ORDER, movementType('E1'), 1, 16, 50, 128, 0, -1, C.MOVE, -1, 0, 0, 0, 48, -1], id * CHANGE_WORDS);
  applyLifecycle(battle, commands);
  const occupied = new Set<string>();
  for (let id = 0; id < 16; id++) {
    const at = id * U.WORDS, cell = battle.units[at + U.UCELL], spot = `${cell}/${battle.units[at + U.USLOT]}`;
    expect(battle.units[at + U.UHEALTH]).toBe(50); expect(cell).toBeLessThan(32);
    expect(occupied.has(spot)).toBe(false); occupied.add(spot);
    expect(battle.movement.goals[id]).toBe(cell + 32);
    expect(battle.state[id * C.CWORDS + C.CSEEN]).toBe(0);
  }
});

it('reports capture, sabotage and destruction once while retaining the old owner for capture triggers', () => {
  const setup = { ...field(), units: [{ type: movementType('MISS'), cell: 330, owner: 1 }, { type: movementType('RMBO'), cell: 333, owner: 0 }] };
  const battle = new CpuCombat(setup), previous = GpuCampaignEvents.initial(setup);
  battle.movement.frame = 20; battle.units[U.UBOMB_TICK] = 21;
  battle.state[C.CSEEN] = 1; battle.state[C.CHIT_FRAME] = 20; battle.state[C.CHIT_SOURCE] = 2;
  expect(campaignEvents(battle, previous)[0] & 255).toBe(ATTACKED | DISCOVERED);
  battle.movement.frame = 21; battle.units[U.UOWNER] = 0; battle.units[U.UCAPTURE_TICK] = 21;
  const captured = campaignEvents(battle, previous)[0];
  expect(captured & 255).toBe(CAPTURED | SABOTAGED); expect(captured >>> 8 & 15).toBe(1); expect(captured >>> 12).toBe(0);
  battle.movement.frame = 22; battle.units[U.UHEALTH] = 0; battle.state[C.CDEATH] = 22;
  expect(campaignEvents(battle, previous)[0] & 255).toBe(DESTROYED);
  battle.movement.frame = 23; expect(campaignEvents(battle, previous)[0] & 255).toBe(0);
});

it('counts evacuated civilians only when their transport leaves alive, excluding technicians', () => {
  const setup = { ...field(), units: [{ type: movementType('TRAN'), cell: 48 },
    { type: movementType('MOEBIUS'), cell: 48, attached: 1 }, { type: movementType('C1'), cell: 48, attached: 1, flags: U.TECHNICIAN }] };
  const battle = new CpuCombat(setup), previous = GpuCampaignEvents.initial(setup);
  battle.movement.frame = 1; battle.units[U.UY] = 128;
  for (let id = 0; id < 3; id++) { battle.units[id * U.WORDS + U.UHEALTH] = 0; battle.units[id * U.WORDS + U.UATTACHED] = 0; }
  const events = campaignEvents(battle, previous);
  expect(events[3] & 255).toBe(REMOVED | EVACUATED); expect(events[6] & 255).toBe(REMOVED);
  // A newly allocated actor can enter a cell trigger even if its slot's previous cell was the same.
  battle.movement.frame = 2; battle.units[U.WORDS + U.UGENERATION]++; battle.units[U.WORDS + U.UHEALTH] = 50;
  expect(campaignEvents(battle, previous)[3] & ENTERED).toBe(ENTERED);
});

it('lets an engineer capture an empty landed Chinook and consumes the engineer', () => {
  const battle=new CpuCombat({...field(),units:[{type:movementType('E6'),cell:330},{type:movementType('TRAN'),cell:334,owner:1}]});
  for(let frame=1;frame<=240;frame++)battle.step(frame===1?[{frame,kind:'attack',target:1,ids:[0]}]:[]);
  expect(battle.units[U.WORDS+U.UOWNER]).toBe(0);
  expect(battle.units[U.UHEALTH]).toBe(0);
});

it('converts a scripted engineer attack into the original capture mission', () => {
  const battle=new CpuCombat({...field(),units:[{type:movementType('E6'),cell:330},{type:movementType('PYLE'),cell:334,owner:1}]});
  battle.state[C.CMISSION]=C.ATTACK;battle.state[C.CTARGET]=1;
  for(let frame=1;frame<=240;frame++)battle.step();
  expect(battle.units[U.WORDS+U.UOWNER]).toBe(0);
  expect(battle.units[U.UHEALTH]).toBe(0);
});

it('retaliates for another team member but keeps an armed target already in range',()=>{
  const battle=new CpuCombat({...field(),units:[
    {type:movementType('E1'),cell:330,owner:1},{type:movementType('E1'),cell:331,owner:1},
    {type:movementType('MCV'),cell:334},{type:movementType('MTNK'),cell:332},{type:movementType('E1'),cell:333},
  ]});
  battle.movement.frame=10;battle.state[C.CHIT_FRAME]=10;battle.state[C.CHIT_SOURCE]=5;
  expect(retaliationTarget(battle,[0,1],2)).toBe(4);
  expect(retaliationTarget(battle,[0,1],3)).toBe(3);
  expect(retaliationTarget(battle,[0,1],2,true)).toBe(2);
});

it('regroups near a repair facility and avoids an exposed retreat point',()=>{
  const battle=new CpuCombat({...field(),units:[{type:movementType('MTNK'),cell:16*32+16,owner:1},
    {type:movementType('NUKE'),cell:12*32+9,owner:1},{type:movementType('FIX'),cell:12*32+21,owner:1},
    ...Array.from({length:6},(_,i)=>({type:movementType('HTNK'),cell:8*32+19+i,health:0})),
  ]});
  const center=16*32+16;
  const quiet=teamRetreatCell(battle,0,center);
  expect(quiet%32).toBeGreaterThan(18);
  for(let id=3;id<9;id++)battle.units[id*U.WORDS+U.UHEALTH]=600;
  expect(teamRetreatCell(battle,0,center)%32).toBeLessThan(14);
});
