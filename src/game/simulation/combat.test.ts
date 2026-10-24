import { describe, it, expect } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { movementType } from '../data/movement.ts';
import { weapons, bullets, modifyDamage, animations, ANIMATION_IDS } from '../data/combat.ts';
import { CpuCombat, firePoint } from './combat-cpu.ts';
import * as C from './combat-state.ts';
import * as U from './units-state.ts';
import { randomWord } from '../../engine/simulation/fixed.ts';
import { backlineScenario } from '../../../tests/backline-scenario.ts';
import { deathAnimation, deathVoice, soundGain } from './combat-effects.ts';
export function combatFixture(): C.CombatSetup {
  return { grid: gridEdges(16, 12, new Uint8Array(192).fill(1), true), land: new Uint8Array(192), seed: 0x1995,
    units: [{ cell: 66, type: movementType('MTNK'), facing: 64 }, { cell: 70, type: movementType('MTNK'), facing: 192, owner: 1 }] };
}
describe('original ground combat', () => {
  it('credits a commando kill and celebrates after the original two-second delay', () => {
    const setup=combatFixture();
    setup.units=[{cell:66,type:movementType('RMBO'),facing:64},
      {cell:68,type:movementType('C1'),owner:1,health:1}];
    const battle=new CpuCombat(setup);
    while(battle.frame<40 && battle.units[U.WORDS+U.UHEALTH]>0) battle.step();
    const killed=battle.state[C.CWORDS+C.CDEATH];
    expect(killed).toBeGreaterThan(0);
    expect(battle.state[C.CKILLS]).toBe(1);
    while(battle.frame<killed+29) battle.step();
    expect([27,29]).not.toContain(battle.state[C.CACTION]);
    battle.step();
    expect([27,29]).toContain(battle.state[C.CACTION]);
    expect(battle.state[C.CSTAGE]).toBe(0);
    const gesture=battle.state[C.CACTION];
    battle.state[C.CFEAR]=100;
    battle.step();
    // MasterDoControls marks both gestures uninterruptible, including by lying down.
    expect(battle.state[C.CACTION]).toBe(gesture);
    expect(battle.state[C.CPRONE]).toBe(0);
    for(let i=0;i<5;i++) battle.step();
    // IDATA.CPP CommandoDos: three frames at MasterDoControls' rate of two.
    expect(battle.state[C.CACTION]).toBe(0);
  });
  it.each([67,69])('finishes the existing approach to %i after its attack target dies', destination => {
    const setup=combatFixture();
    setup.units=[setup.units[0],{...setup.units[1],health:0}];
    const battle=new CpuCombat(setup);
    battle.state[C.CTARGET]=1;battle.state[C.CMISSION]=C.ATTACK;
    battle.movement.goals[0]=67;
    if(destination!==67) {battle.state[C.CLOCAL_ROUTE]=1;battle.state[C.CLOCAL_DEST]=destination;}
    battle.step();
    expect(battle.state[C.CMISSION]).toBe(C.MOVE);
    expect(battle.movement.goals[0]).toBe(destination);
    while(battle.frame<160 && battle.units[U.UCELL]!==destination) battle.step();
    expect(battle.units[U.UCELL]).toBe(destination);
    battle.step();
    expect(battle.state[C.CMISSION]).toBe(C.GUARD);
  });
  it('uses pre-increment kills for ordinary infantry excitement and counts simultaneous casualties', () => {
    const setup=combatFixture();setup.units=[{cell:66,type:movementType('E1')},
      {cell:68,type:movementType('C1'),owner:1,health:0},{cell:70,type:movementType('C1'),owner:1,health:0}];
    while(randomWord(setup.seed,0,0,80)%6!==0) setup.seed++;
    const battle=new CpuCombat(setup);
    battle.state[C.CWORDS+C.CDEATH]=0;battle.state[C.CWORDS+C.CKILLER]=0;
    battle['recordKills']();
    expect(battle.state[C.CKILLS]).toBe(1);
    expect(battle.state[C.CSTOKED]).toBe(0);
    battle.state[C.CKILLS]=6;battle.movement.frame=1;
    for(const id of [1,2]) {battle.state[id*C.CWORDS+C.CDEATH]=1;battle.state[id*C.CWORDS+C.CKILLER]=0;}
    battle['recordKills']();
    expect(battle.state[C.CKILLS]).toBe(8);
    expect(battle.state[C.CSTOKED]).toBe(1);
    expect(battle.state[C.CCOMMENT]).toBe(31);
  });
  it('uses the original bike Risk when scoring close hunt targets', () => {
    const setup=combatFixture();
    setup.units=[{cell:66,type:movementType('MTNK'),owner:1},
      {cell:67,type:movementType('MTNK')},{cell:68,type:movementType('BIKE')}];
    const battle=new CpuCombat(setup);
    battle.state[C.CMISSION]=C.HUNT;
    battle.units[U.WORDS+U.UX]=battle.units[U.UX]+60;
    battle.units[2*U.WORDS+U.UX]=battle.units[U.UX]+32;
    // TECHNO.CPP Evaluate_Object: (80+45)/32 > (80+62)/60.
    expect(battle['findTarget'](0)).toBe(2);
  });
  it.each(['LST','BOAT','DELPHI'])('excludes %s from automatic guard targets', name => {
    const setup=combatFixture();
    setup.units=[setup.units[0],{cell:68,type:movementType(name),owner:1}];
    const battle=new CpuCombat(setup);battle.state[C.CWORDS+C.CSEEN]=1;
    expect(battle['findTarget'](0)).toBe(-1);
  });
  it.each([0,1])('applies original idle panic direction and human exclusion for owner %i', owner => {
    const setup=combatFixture();setup.units=[{cell:66,type:movementType('E5'),owner,facing:0}];
    while(randomWord(setup.seed,0,0,1)%5!==2) setup.seed++;
    const battle=new CpuCombat(setup);
    battle.state[C.CFEAR]=100;battle.state[C.CPRONE]=1;
    battle['prepare']();
    // Scatter(true) means threat Coord(1), not forced=true. From this position
    // Direction8 is SE; the last open neighbor in the original loop is east.
    expect(battle.movement.goals[0]).toBe(owner===0?-1:67);
  });
  it('acquires a newly arrived enemy on explored ground beyond current sight', () => {
    const setup=combatFixture();setup.units=[setup.units[0],{cell:70,type:movementType('MCV'),owner:1}];
    const battle=new CpuCombat(setup);
    battle.sight.mapped[70]=1;
    battle.step();
    expect(battle.state[C.CWORDS+C.CSEEN]).toBe(1);
    expect(battle.state[C.CTARGET]).toBe(1);
  });
  it('scatters moving tank shots and keeps the destination within weapon range', () => {
    const setup=combatFixture();setup.units=[setup.units[0],{cell:70,type:movementType('MCV'),owner:1}];
    const stationary=new CpuCombat(setup), moving=new CpuCombat(setup);
    for(const battle of [stationary,moving]) battle.state[C.CTARGET]=1;
    moving.units[U.UDEST]=67;moving.movement.goals[0]=71;
    stationary['fire'](0);moving['fire'](0);
    expect(moving.projectiles[C.BTO_X]).not.toBe(stationary.projectiles[C.BTO_X]);
    const p=moving.projectiles;
    // Integer direction/Coord_Move rounding may leave at most one lepton at the boundary.
    expect(Math.abs(p[C.BTO_X]-p[C.BFIRE_X])).toBeLessThanOrEqual(1217);
  });
  it('emits original death effects and leaves audible offscreen battles', () => {
    expect(deathAnimation(movementType('E2'),-1)).toBe(ANIMATION_IDS.ANIM_ART_EXP1);
    expect(deathAnimation(movementType('E4'),-1)).toBe(ANIMATION_IDS.ANIM_NAPALM1);
    expect(deathAnimation(movementType('E5'),-1)).toBe(ANIMATION_IDS.ANIM_CHEM_BALL);
    expect(deathAnimation(movementType('MLRS'),1)).toBe(ANIMATION_IDS.ANIM_NAPALM3);
    expect(new Set([0,1,2,3].map(i=>deathVoice(movementType('E1'),0,i))).size).toBe(4);
    expect(deathVoice(movementType('E1'),3,0)).toBe('YELL1');
    expect(deathVoice(movementType('RMBO'),0,0)).toBe('RAMYELL1');
    const view={x:0,y:0,width:40*256,height:24*256};
    expect(soundGain(39*256,128,view)).toBe(1);
    expect(soundGain(200*256,128,view)).toBe(25/255);
  });
  it('releases an out-of-range guard target before acquiring a nearby enemy', () => {
    const setup = combatFixture();
    setup.units = [setup.units[0], {...setup.units[1], cell:79},
      {cell:69,type:movementType('MCV'),owner:1}];
    const battle = new CpuCombat(setup);
    battle.state[C.CTARGET] = 1;
    battle.state[2 * C.CWORDS + C.CSEEN] = 1;
    battle.step();
    // FOOT.CPP Mission_Guard calls Target_Something_Nearby(THREAT_RANGE).
    expect(battle.state[C.CTARGET]).toBe(2);
  });
  it('returns to guard after an explicit attack target dies', () => {
    const setup = combatFixture();
    setup.units = [setup.units[0], {...setup.units[1], health:0}];
    const battle = new CpuCombat(setup);
    battle.state[C.CMISSION] = C.ATTACK;
    battle.state[C.CTARGET] = 1;
    battle.step();
    expect(battle.state[C.CMISSION]).toBe(C.GUARD);
  });
  it('continues hunting enemies outside weapon range without changing target on damage', () => {
    const setup = combatFixture();
    setup.units = [{...setup.units[0],owner:1}, {...setup.units[1],cell:79,owner:0},
      {cell:68,type:movementType('MCV')}];
    const battle = new CpuCombat(setup);
    battle.state[C.CMISSION] = C.HUNT;
    battle.step();
    // Global threat scores tie at two; a stable ID resolves the tie.
    expect(battle.state[C.CTARGET]).toBe(1);
    battle['injure'](0, 1, 0, 2, []);
    expect(battle.state[C.CTARGET]).toBe(1);
  });
  it('points an idle turret toward its navigation destination', () => {
    const setup = combatFixture(); setup.units = [{...setup.units[0],facing:0}];
    const battle = new CpuCombat(setup);
    battle.movement.goals[0] = 70;
    battle.step();
    expect(battle.state[C.CTURN]).toBe(63);
  });
  it('offsets infantry muzzles by five pixels except for flame infantry', () => {
    // INFANTRY.CPP Fire_Coord; XYP_COORD uses 256 leptons per 24 pixels.
    expect(firePoint('E1',640,640,64,1)).toEqual([640,587]);
    expect(firePoint('E3',640,640,64,1)).toEqual([640,587]);
    expect(firePoint('E4',640,640,64,1)).toEqual([640,640]);
  });
  it('uses original injury fear thresholds, saturation and the fraidy-cat panic value', () => {
    const setup = combatFixture(); setup.units = [{cell:66,type:movementType('E1')},
      {cell:67,type:movementType('E5')}, {cell:70,type:movementType('MCV'),owner:1}];
    const battle = new CpuCombat(setup);
    battle['injure'](0,1,0,2,[]);
    expect(battle.state[C.CFEAR]).toBe(100);
    battle['injure'](0,1,0,2,[]);
    expect(battle.state[C.CFEAR]).toBe(102);
    battle.state[C.CFEAR] = 254;
    battle['injure'](0,1,0,2,[]);
    expect(battle.state[C.CFEAR]).toBe(255);
    battle['injure'](1,1,0,2,[]);
    expect(battle.state[C.CWORDS+C.CFEAR]).toBe(200);
  });
  it('crushes enemy infantry while driving through their cell', () => {
    const setup = combatFixture();
    setup.units = [{cell:66,type:movementType('MTNK'),facing:64},
      {cell:67,type:movementType('C1'),owner:1,health:10000}];
    const battle = new CpuCombat(setup);
    battle.step([{frame:1,kind:'move',target:69,ids:[0]}]);
    while (battle.frame < 100) battle.step();
    // DRIVE.CPP, Overrun_Square: crushing removes the enemy outright, independent of health.
    expect(battle.units[U.WORDS + U.UHEALTH]).toBe(0);
    expect(battle.units[U.UCELL]).toBe(69);
    expect(battle.state[C.CWORDS + C.CKILLER]).toBe(0);
  });
  it('brings the rear ranks into range when the original firing arc is occupied', () => {
    const battle = new CpuCombat(backlineScenario());
    battle.step([{frame:1,kind:'attack',target:40,ids:Array.from({length:40},(_,i)=>i)}]);
    while (battle.frame < 2000) battle.step();
    // FOOT.CPP, Approach_Target and FINDPATH.CPP: an attack seeks a reachable firing
    // position around obstructions; it must not keep retrying a blocked straight route.
    const neverFired = Array.from({length:40},(_,i)=>i)
      .filter(id => battle.units[id * U.WORDS + U.UHEALTH] > 0 && battle.state[id * C.CWORDS + C.CLAST_FIRE] < 0);
    expect(neverFired).toEqual([]);
  });
  // CONST.CPP, Warheads: independent copies of the original armor modifiers.
  const modifiers = [[255, 128, 144, 64, 64], [224, 192, 144, 64, 255], [64, 192, 192, 255, 128],
    [224, 255, 176, 64, 128], [255, 255, 255, 255, 255], [255, 255, 192, 192, 192],
    [255, 32, 32, 16, 16], [255, 32, 32, 16, 16], [255, 8, 8, 8, 8], [255, 1, 1, 1, 1], [255, 192, 128, 32, 8], [255, 192, 128, 32, 8]];
  const originalWeapons = [[125, 8], [25, 1], [1, 0], [15, 0], [30, 2], [35, 3], [50, 3], [80, 1], [50, 1],
    [25, 2], [30, 2], [40, 2], [40, 2], [75, 1], [75, 1], [150, 1], [15, 0], [60, 1], [60, 1], [100, 3],
    [200, 4], [50, 2], [100, 3], [100, 10], [155, 11]];
  it.each(weapons.map((_, i) => i))('matches original armor rounding for weapon %i', i => {
    const raw = weapons[i].damage, warhead = bullets[weapons[i].bullet].warhead;
    const [originalDamage, originalWarhead] = originalWeapons[i];
    for (let armor = 0; armor < 5; armor++)
      expect(modifyDamage(raw, warhead, armor)).toBe(Math.floor((originalDamage * modifiers[originalWarhead][armor] + 128) / 256));
  });
  it('halves HE damage each 64 leptons and does not impose a minimum damage', () => {
    expect([0, 63, 64, 128, 192, 256, 320].map(d => modifyDamage(50, 1, 0, d))).toEqual([44, 44, 22, 11, 5, 2, 1]);
    expect(modifyDamage(1, 0, 3, 0)).toBe(0);
  });
  it('offsets tank muzzles using the original barrel lengths', () => {
    // TURRET.CPP calls Coord_Move even for the northward offset. COORD.CPP's
    // sine table contains 127 at north, so the offsets are 47 and 63 leptons.
    expect(firePoint('MTNK', 640, 640, 64, 1)).toEqual([830, 593]);
    expect(firePoint('ARTY', 640, 640, 0, 1)).toEqual([640, 482]);
  });
  it('indexes flame animations in the original Pointers order', () => {
    // DEFINES.H, AnimType and ADATA.CPP, AnimTypeClass::Pointers.
    for (const [first, prefix] of [[ANIMATION_IDS.ANIM_FLAME_N, 'FLAME'], [ANIMATION_IDS.ANIM_CHEM_N, 'CHEM']] as const) {
      expect(animations.slice(first, first + 8).map(a => a.name))
        .toEqual(['N','NE','E','SE','S','SW','W','NW'].map(dir => `${prefix}-${dir}`));
    }
    // SAMFIRE.SHP stores directions counterclockwise: SAMNE starts at 18*7.
    expect(animations.slice(ANIMATION_IDS.ANIM_SAM_N, ANIMATION_IDS.ANIM_SAM_N + 8).map(a => a.start))
      .toEqual([0,126,108,90,72,54,36,18]);
  });
  it('tries the Mammoth secondary weapon while its primary cannot fire', () => {
    const setup = combatFixture();
    setup.units = [{cell:66,type:movementType('HTNK'),facing:0},
      {cell:69,type:movementType('MCV'),owner:1}];
    const battle = new CpuCombat(setup);
    battle.step([{frame:1,kind:'attack',target:1,ids:[0]}]);
    while (battle.frame < 30 && battle.state[C.CLAST_FIRE] < 0) battle.step();
    // TARCOM.CPP tries the secondary after any primary failure; homing missiles
    // satisfy TURRET.CPP's facing tolerance before the cannon finishes rotating.
    expect(battle.projectiles[C.BWEAPON]).toBe(13);
  });
  it('keeps moving infantry upright under the original defender-advantage rule', () => {
    const setup = combatFixture();
    setup.units = [{cell:66,type:movementType('E1'),facing:64}];
    const battle = new CpuCombat(setup);
    battle.step([{frame:1,kind:'move',target:70,ids:[0]}]);
    battle.step();
    battle.state[C.CFEAR] = 100;
    battle.step();
    // INFANTRY.CPP, AI; SPECIAL.H defaults IsDefenderAdvantage to true.
    expect(battle.state[C.CPRONE]).toBe(0);
  });
  it('turns a locked rocket launcher body toward its target before firing', () => {
    const setup = combatFixture();
    setup.units = [{cell:66,type:movementType('MSAM'),facing:0},
      {cell:70,type:movementType('MCV'),owner:1}];
    const battle = new CpuCombat(setup);
    battle.step([{frame:1,kind:'attack',target:1,ids:[0]}]);
    while (battle.frame < 50 && battle.state[C.CLAST_FIRE] < 0) battle.step();
    // TARCOM.CPP, FIRE_FACING aligns both facings for IsLockTurret units.
    // Desired_Facing256 returns 63 for due east (63 - the zero slope angle).
    expect(battle.units[U.UDESIRED]).toBe(63);
    expect(battle.units[U.UFACE]).toBeGreaterThan(0);
  });
  it('gives artillery the original setup delay after completing a move', () => {
    const setup = combatFixture();
    setup.units = [{cell:66,type:movementType('ARTY'),facing:64},
      {cell:70,type:movementType('MCV'),owner:1}];
    const battle = new CpuCombat(setup);
    battle.step([{frame:1,kind:'move',target:67,ids:[0]}]);
    while (battle.frame < 100 && battle.units[U.UCELL] !== 67) battle.step();
    const arrived = battle.frame;
    // UNIT.CPP, Per_Cell_Process: Rearm_Delay(false) * 2 = 18 ticks.
    expect(battle.state[C.CARM]).toBe(18);
    while (battle.frame < 150 && battle.state[C.CLAST_FIRE] < arrived) battle.step();
    expect(battle.state[C.CLAST_FIRE]).toBeGreaterThanOrEqual(arrived + 18);
  });
  it('uses the original ROF plus three ticks between medium tank shots', () => {
    const battle = new CpuCombat(combatFixture()), fired: number[] = [];
    for (let tick = 1; tick <= 180; tick++) {
      battle.step(tick === 1 ? [{ frame: 1, kind: 'attack', target: 1, ids: [0] }] : []);
      if (battle.state[C.CLAST_FIRE] === tick)
        fired.push(tick);
    }
    expect(fired.length).toBeGreaterThanOrEqual(3);
    expect(fired.slice(1).map((t, i) => t - fired[i])).toEqual(new Array(fired.length - 1).fill(53));
  });
  it('removes dead vehicles from movement reservations and emits a deterministic survivor', () => {
    const setup = combatFixture();
    setup.units = [...setup.units, { cell: 150, type: movementType('E1'), owner: 1, health: 0 }];
    setup.crewParents = [-1, -1, 1];
    const a = new CpuCombat(setup), b = new CpuCombat(setup);
    // Isolate explicit orders from the initial guard scan on already explored ground.
    for(const battle of [a,b]) for(let id=0;id<setup.units.length;id++) battle.state[id*C.CWORDS+C.CSCAN]=2;
    for (let tick = 1; tick <= 1000; tick++) {
      const commands: C.AttackCommand[] = tick === 1 ? [{ frame: 1, kind: 'attack', target: 1, ids: [0] }] : [];
      a.step(commands);
      b.step(commands);
    }
    expect(a.buffers().map(v => Array.from(v))).toEqual(b.buffers().map(v => Array.from(v)));
    // 105mm vs steel: 30 damage, ceil(400/30)=14 hits, 53 ticks between shots.
    // The first shot launches on tick 2, and FLY/FUSE take 10 updates to this target.
    expect(a.state[C.CWORDS + C.CDEATH]).toBe(11 + 13 * 53);
    expect(Array.from(a.movement.occupancy)).not.toContain(2);
    expect(a.units[U.WORDS + U.UHEALTH]).toBe(0);
  });
  it('places a surviving armed crew member with the original health range', () => {
    const setup = combatFixture();
    setup.units = [{ cell: 66, type: movementType('MTNK'), health: 1 }, { cell: 150, type: movementType('E1'), health: 0 }];
    setup.crewParents = [-1, 0];
    while (randomWord(setup.seed, 1, 0, 60) % 2)
      setup.seed++;
    const battle = new CpuCombat(setup), p = battle.projectiles;
    p[0] = p[C.BTO_X] = battle.units[0];
    p[1] = p[C.BTO_Y] = battle.units[1];
    p[C.BACTIVE] = 1;
    p[C.BTIMER] = 1;
    p[C.BTYPE] = 2;
    p[C.BDAMAGE] = 25;
    p[C.BSOURCE] = -1;
    battle.step();
    expect(battle.units[U.WORDS + U.UHEALTH]).toBe(5 + randomWord(setup.seed, 1, 0, 61) % 21);
    expect(battle.units[U.WORDS + U.UCELL]).toBe(66);
    expect(battle.movement.occupancy[66 * 5]).toBe(2);
    expect(battle.movement.goals[1]).toBeGreaterThanOrEqual(0);
  });
  it('limits each explosion to the original 32 candidate objects', () => {
    const setup = combatFixture();
    setup.units = [];
    const units: U.UnitPlacement[] = [];
    for (const [dx, dy] of [[0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]])
      for (let slot = 0; slot < 5; slot++)
        units.push({ cell: 66 + dy * 16 + dx, slot, type: movementType('E1') });
    setup.units = units;
    const battle = new CpuCombat(setup), p = battle.projectiles;
    p[0] = p[C.BTO_X] = battle.units[0];
    p[1] = p[C.BTO_Y] = battle.units[1];
    p[C.BACTIVE] = 1;
    p[C.BTIMER] = 1;
    p[C.BTYPE] = 3;
    p[C.BALTITUDE] = 1;
    p[C.BRISER] = -1;
    p[C.BDAMAGE] = 50;
    p[C.BSOURCE] = -1;
    battle.step();
    for (let id = 32; id < 45; id++)
      expect(battle.units[id * U.WORDS + U.UHEALTH]).toBe(50);
    expect(battle.units[U.UHEALTH]).toBe(6);
  });
});
