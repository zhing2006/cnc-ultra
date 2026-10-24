// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { animations, ANIMATION_IDS as A, combatTypes, SOUND_NAMES } from '../data/combat.ts';
import { MOVEMENT } from '../data/movement.ts';
import { CRUSHED } from './combat-state.ts';
/** UNIT.CPP and INFANTRY.CPP, Take_Damage: additional death animations. */
export function deathAnimation(type: number, ammo: number) {
  const unit = combatTypes[type];
  if (unit.name === 'E2')
    return A.ANIM_ART_EXP1;
  if (unit.name === 'E4')
    return A.ANIM_NAPALM1;
  if (unit.name === 'E5')
    return A.ANIM_CHEM_BALL;
  if (unit.name === 'MLRS' && ammo > 0)
    return A.ANIM_NAPALM3;
  return unit.explosion;
}
// INFANTRY.CPP, Take_Damage: the inclusive SCREAM1..SCREAM5 enum range
// contains four entries. DEFINES.H has no SCREAM2.
export const INFANTRY_SCREAMS = ['NUYELL1', 'NUYELL3', 'NUYELL4', 'NUYELL5'] as const;
/** INFANTRY.CPP InfantryClass::AI: the commando's four victory comments. */
export const COMMANDO_TAUNTS = ['LEFTY1','LAUGH1','KEEPEM1','TUFFGUY1'] as const;
export function deathVoice(type: number, warhead: number, random: number) {
  if (warhead === CRUSHED)
    return SOUND_NAMES.VOC_SQUISH2;
  if (!MOVEMENT[type].infantry)
    return '';
  if (combatTypes[type].name === 'RMBO')
    return SOUND_NAMES.VOC_RAMBO_YELL;
  if (warhead === 3 || warhead === 4 || warhead === 5)
    return SOUND_NAMES.VOC_YELL1;
  return INFANTRY_SCREAMS[random % INFANTRY_SCREAMS.length];
}
/** AUDIO.CPP Sound_Effect(VocType, COORDINATE, int), with master gain separate. */
export function soundGain(x: number, y: number, view: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const cx = Math.floor(x / 256), cy = Math.floor(y / 256);
  const left = Math.floor(view.x / 256), top = Math.floor(view.y / 256);
  if (x >= view.x && y >= view.y && x < view.x + view.width && y < view.y + view.height)
    return 1;
  const dx = Math.abs(cx - left), dy = Math.abs(cy - top);
  const distance = Math.min(64, Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2));
  return Math.max(25, Math.floor((255 - Math.min(255, Math.floor(distance * 256 / 64))) / 2)) / 255;
}
export const DEATH_SOUNDS = [...new Set([...INFANTRY_SCREAMS, SOUND_NAMES.VOC_RAMBO_YELL,
SOUND_NAMES.VOC_YELL1, SOUND_NAMES.VOC_SQUISH2,
...combatTypes.flatMap((_, i) => [0, 1].map(ammo => animations[deathAnimation(i, ammo)]?.sound ?? ''))])].filter(Boolean);
