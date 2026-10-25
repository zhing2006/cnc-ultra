import { expect,it } from 'vitest';
import { combatTypes } from '../data/combat.ts';
import { movementType } from '../data/movement.ts';

it('uses the weapon-derived risk from TechnoTypeClass rather than constructor hint values',()=>{
  // TECHNO.CPP constructor overwrites Risk; CONST.CPP and IDATA/UDATA define these weapons.
  const risks=['E1','E2','MTNK','JEEP','RMBO','MCV','HARV'].map(name=>combatTypes[movementType(name)].risk);
  expect(risks).toEqual([24,43,45,32,275,0,0]);
});
