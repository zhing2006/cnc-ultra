import { expect, it } from 'vitest';
import { SuperCharge, SuperWeapons, type SuperBuilding } from './super-weapons.ts';

it.each([['ion', 9000], ['nuke', 12600]] as const)('charges %s for the original %i ticks and preserves progress through low power', (kind, duration) => {
  const weapon = new SuperCharge(kind);
  weapon.step(0, true, true);
  weapon.step(100, true, true);
  weapon.step(200, true, false);
  expect(weapon.remaining(200)).toBe(duration - 200);
  weapon.step(1200, true, true);
  expect(weapon.remaining(1200)).toBe(duration - 200);
  weapon.step(duration + 999, true, true); expect(weapon.ready).toBe(false);
  weapon.step(duration + 1000, true, true); expect(weapon.ready).toBe(true);
  expect(weapon.stage(duration + 1000)).toBe(102);
  weapon.step(duration + 1001, true, false);
  expect(weapon.discharge(duration + 1001)).toBe(true);
  expect(weapon.remaining(duration + 1001)).toBe(duration);
  weapon.step(duration + 1002, false, false);
  expect(weapon.present).toBe(false);
});

it('aims at the original center cell of even-sized structures',()=>{
  const weapons=new SuperWeapons(32,32,{x:1,y:1,width:30,height:30},new Map());
  const building={id:0,cell:100,owner:1,health:1000,active:true,selling:false};
  expect(weapons.targetCell({...building,type:'EYE'})).toBe(100);
  expect(weapons.targetCell({...building,type:'FACT'})).toBe(101);
});

it('fires the ion cannon at animation stage eleven and chains the original explosion', () => {
  const weapons = new SuperWeapons(32, 32, { x: 1, y: 1, width: 30, height: 30 }, new Map([['IONSFX', 15], ['ART-EXP1', 20]]));
  weapons.charges[0].ion.step(0, true, true); weapons.charges[0].ion.step(9000, true, true);
  const eye: SuperBuilding = { id: 0, type: 'EYE', cell: 100, owner: 0, health: 1000, active: true, selling: false };
  expect(weapons.fire(0, 'ion', 400, 9000, [eye])).toBe(true);
  for (let tick = 9000; tick < 9011; tick++) expect(weapons.step(tick)).toEqual([]);
  expect(weapons.step(9011)).toEqual([{ frame: 9011, x: 16 * 256 + 128, y: 12 * 256 + 128, damage: 600, warhead: 5, source: 0, scorch: true, crater: true }]);
  weapons.step(9015); expect(Array.from(weapons.visuals.slice(0, 2))).toEqual([1, 0]);
});

it('uses the multiplayer nuclear footprint instead of campaign damage', () => {
  const weapons = new SuperWeapons(32, 32, { x: 1, y: 1, width: 30, height: 30 }, new Map([['ATOMDOOR', 40], ['ATOMICUP', 1], ['ATOMICDN', 1], ['ATOMSFX', 40]]));
  weapons.charges[1].nuke.step(0, true, true); weapons.charges[1].nuke.step(12600, true, true);
  const temple: SuperBuilding = { id: 1, type: 'TMPL', cell: 400, owner: 1, health: 2000, active: true, selling: false };
  expect(weapons.fire(1, 'nuke', 400, 12600, [temple])).toBe(true);
  const hits = [];
  for (let tick = 12600; tick < 13000; tick++) hits.push(...weapons.step(tick, [temple]));
  expect(hits.filter(hit => hit.damage === 1)).toHaveLength(1);
  const blast = hits.filter(hit => hit.damage === 100);
  expect(blast).toHaveLength(49);
  expect(new Set(blast.map(hit => `${hit.x},${hit.y}`)).size).toBe(49);
  expect(blast.every(hit => hit.warhead === 3)).toBe(true);
  expect(new Set(blast.map(hit => hit.frame)).size).toBe(1);
});

it('fades the campaign nuclear strike to white before applying the original nine-cell-wide blast', () => {
  const weapons=new SuperWeapons(32,32,{x:1,y:1,width:30,height:30},new Map([['ATOMSFX',40]]));
  weapons.campaign=true;weapons.charges[1].nuke.grant(0,true);
  const temple:SuperBuilding={id:1,type:'TMPL',cell:400,owner:1,health:2000,active:true,selling:false};
  weapons.fire(1,'nuke',528,0,[temple]);
  const hits=[],flashes:{frame:number;phase:string}[]=[];
  for(let frame=0;frame<300;frame++){
    hits.push(...weapons.step(frame,[temple]));
    for(const event of weapons.events)if(event.flash)flashes.push({frame,phase:event.flash});
  }
  const damage=hits.filter(hit=>hit.damage===333);
  expect(damage).toHaveLength(81);expect(new Set(damage.map(hit=>`${hit.x},${hit.y}`)).size).toBe(81);
  expect(flashes).toEqual([{frame:damage[0].frame-1,phase:'rise'},{frame:damage[0].frame,phase:'fall'}]);
  expect(weapons.charges[1].nuke.present).toBe(false);
});
