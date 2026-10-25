// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
// Ported from CONST.CPP, BBDATA.CPP, UDATA.CPP, IDATA.CPP and ADATA.CPP.
import { WEAPONS, WARHEADS, BULLETS, COMBAT_TYPES, ANIMATIONS, ANIMATION_BIGGEST,ANIMATION_IDS } from './combat-raw.ts';
import { MOVEMENT } from './movement.ts';
import { EXTRA_ACTORS } from './extra-actors.ts';
import { WALLS } from './overlays.ts';
export { ANIMATION_IDS, SOUND_NAMES } from './combat-raw.ts';
export const weapons = WEAPONS.map(([bullet, damage, rof, range, sound, animation]) => ({ bullet, damage, rof, range, sound, animation }));
export const warheads = WARHEADS.map(([spread, wall, wood, tiberium, ...armor]) => ({ spread, wall, wood, tiberium, armor }));
export const bullets = BULLETS.map(([name, high, homing, arcing, dropping, invisible, proximity, smoke, fueled, faceless, inaccurate, translucent, antiAir, arming, range, speed, rotation, warhead, explosion]) => ({ name, high, homing, arcing, dropping, invisible, proximity, smoke, fueled, faceless,
  inaccurate, translucent, antiAir, arming, range, speed, rotation, warhead, explosion }));
export const animations = ANIMATIONS.map(([name, scorch, crater, ground, translucent, damage, rate, start, loopStart, loopEnd, count, loops, sound, next], i) => ({ name, scorch, crater, ground, translucent, damage, rate, start, loopStart, loopEnd, count, loops, sound, next, biggest: ANIMATION_BIGGEST[i] }));
export const combatTypes = MOVEMENT.map(movement => {
  const extra = EXTRA_ACTORS.find(t=>t.name===movement.name);
  if(extra) {
    const weapon=weapons[extra.primary];
    return {...extra,targetable:extra.targetable&&!WALLS[extra.name],lockTurret:0,crusher:0,explosion:WALLS[extra.name]?-1:ANIMATION_IDS.ANIM_FBALL1,launch:0,proneLaunch:0,actions:[] as readonly number[],
      risk:weapon?Math.trunc(weapon.damage*(weapon.range>>4)/weapon.rof):0,fraidy:false};
  }
  const [name, primary, secondary, armor, turret, twoShooter, lockTurret, crew, transport, crusher, ammo, explosion, launch, proneLaunch, actions, reward, immune] = COMBAT_TYPES.find(t => t[0] === movement.name)!;
  // UDATA.CPP/IDATA.CPP constructors: Risk, IsFraidyCat and IsLegalTarget.
  const civilian = movement.infantry && !/^E[1-6]$|^RMBO$/.test(name);
  const risk = civilian ? 0 : ['TRIC','TREX','RAPT','STEG'].includes(name) ? 50 : 80;
  return { name, primary, secondary, armor, turret, twoShooter, lockTurret, crew, transport,
    crusher, ammo, explosion, launch, proneLaunch, actions: actions as readonly number[], reward, immune,
    risk, fraidy: !!civilian || name === 'E5', targetable: !['LST','BOAT','DELPHI'].includes(name) };
});
/** COMBAT.CPP, Modify_Damage; COORDA.ASM, Fixed_To_Cardinal rounds before shifting. */
export function modifyDamage(damage: number, warhead: number, armor: number, distance = 0) {
  if (!damage || warhead < 0)
    return 0;
  const data = warheads[warhead];
  // C++ on x86 masks variable shift counts to five bits, including SPORE's 255.
  return ((damage * data.armor[armor] + 128) >> 8) >> Math.min(16, distance >> (data.spread & 31));
}
