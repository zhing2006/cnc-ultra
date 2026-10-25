// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
// Ported from BDATA.CPP IsCaptureable / IsScanner and IDATA.CPP's TechnoTypeClass constructor.
export const CAPTURABLE_BUILDINGS = new Set(['EYE','WEAP','FACT','PROC','SILO','HPAD','HQ','AFLD','NUKE','NUK2','HOSP','PYLE','HAND','FIX','MISS']);
/** INFANTRY.CPP What_Action: late-campaign advanced communications centers cannot be captured. */
export function canCaptureBuilding(name:string,campaignLevel?:number){return CAPTURABLE_BUILDINGS.has(name)&&!(name==='EYE'&&campaignLevel!==undefined&&campaignLevel>=13);}
export const SCANNER_BUILDINGS = new Set(['GTWR','ATWR','OBLI','GUN','HQ']);
export const CIVILIAN_INFANTRY = new Set(['C1','C2','C3','C4','C5','C6','C7','C8','C9','C10','CHAN','DELPHI','MOEBIUS']);
// Ported from INFANTRY.CPP, InfantryClass::MasterDoControls (Interrupt column).
export const INTERRUPTIBLE_INFANTRY_ACTIONS = new Set([0,1,2,3,4,6,8,9,10,12,31,32,33]);
