// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
// Ported from UDATA.CPP and IDATA.CPP, type constructors and DO_WALK tables;
// speed constants from DEFINES.H. Cross-checked against the Nyerguds fork.
export interface MovementType { name: string; infantry: number; speed: number; rotation: number; sight: number; cost: number; strength: number; locomotion: number; walk: number; walkCount: number; walkJump: number }
const rows: [string, number, number, number, number, number, number, number, number, number, number][] = [
  ["VICE",0,18,5,4,800,150,1,0,1,1],
  ["FTNK",0,18,5,4,800,300,1,0,1,1],
  ["STNK",0,30,5,4,900,110,1,0,1,1],
  ["LTNK",0,18,5,3,600,300,1,0,1,1],
  ["MTNK",0,18,5,3,800,400,1,0,1,1],
  ["HTNK",0,12,5,4,1500,600,1,0,1,1],
  ["MHQ",0,18,5,5,600,110,1,0,1,1],
  ["LST",0,30,127,3,300,400,5,0,1,1],
  ["MLRS",0,18,5,4,750,120,1,0,1,1],
  ["ARTY",0,12,2,4,450,75,1,0,1,1],
  ["HARV",0,12,5,2,1400,600,3,0,1,1],
  ["MCV",0,12,5,2,5000,600,3,0,1,1],
  ["JEEP",0,30,10,2,400,150,3,0,1,1],
  ["BGGY",0,30,10,2,300,140,3,0,1,1],
  ["BIKE",0,40,10,2,500,90,3,0,1,1],
  ["MSAM",0,18,5,4,800,100,1,0,1,1],
  ["APC",0,35,5,4,700,200,1,0,1,1],
  ["BOAT",0,8,1,5,300,700,6,0,1,1],
  ["TRIC",0,8,5,5,0,700,1,0,1,1],
  ["TREX",0,18,5,5,0,750,1,0,1,1],
  ["RAPT",0,40,5,5,0,180,1,0,1,1],
  ["STEG",0,8,5,5,0,600,1,0,1,1],
  ["E1",1,8,8,1,100,50,0,16,6,6],
  ["E2",1,10,8,1,160,50,0,16,6,6],
  ["E3",1,6,8,2,300,25,0,16,6,6],
  ["E4",1,10,8,1,200,70,0,16,6,6],
  ["E5",1,8,8,1,300,70,0,16,6,6],
  ["E6",1,8,8,2,500,25,0,16,6,6],
  ["RMBO",1,10,8,5,1000,80,0,16,6,6],
  ["C1",1,10,8,0,10,25,0,56,6,6],
  ["C2",1,10,8,0,10,5,0,56,6,6],
  ["C3",1,10,8,0,10,5,0,56,6,6],
  ["C4",1,10,8,0,10,5,0,56,6,6],
  ["C5",1,10,8,0,10,5,0,56,6,6],
  ["C6",1,10,8,0,10,5,0,56,6,6],
  ["C7",1,10,8,0,10,5,0,56,6,6],
  ["C8",1,10,8,0,10,5,0,56,6,6],
  ["C9",1,10,8,0,10,5,0,56,6,6],
  ["C10",1,10,8,0,10,50,0,56,6,6],
  ["MOEBIUS",1,10,8,0,10,50,0,56,6,6],
  ["DELPHI",1,10,8,0,10,25,0,56,6,6],
  ["CHAN",1,10,8,0,10,25,0,56,6,6],
];
export const MOVEMENT: readonly MovementType[] = rows.map(([name, infantry, speed, rotation, sight, cost, strength, locomotion, walk, walkCount, walkJump]) => ({name, infantry, speed, rotation, sight, cost, strength, locomotion, walk, walkCount, walkJump}));
export const movementType = (name: string) => MOVEMENT.findIndex(type => type.name === name);

// Ported from CONST.CPP, Ground. Rows are land types; columns are SpeedType.
export const GROUND_SPEED = [[112,112,112,160,255,192,0],[192,160,160,160,255,192,0],[0,0,0,0,255,192,255],[0,0,0,0,255,0,0],[0,0,0,0,255,0,0],[112,112,112,160,255,192,0],[112,112,112,160,255,192,0]];
