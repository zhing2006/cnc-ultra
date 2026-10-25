// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
// Ported from BDATA.CPP IsCaptureable / IsScanner and IDATA.CPP's TechnoTypeClass constructor.
export const CAPTURABLE_BUILDINGS = new Set(['EYE','WEAP','FACT','PROC','SILO','HPAD','HQ','AFLD','NUKE','NUK2','HOSP','PYLE','HAND','FIX']);
export const SCANNER_BUILDINGS = new Set(['GTWR','ATWR','OBLI','GUN','HQ']);
// Ported from INFANTRY.CPP, InfantryClass::MasterDoControls (Interrupt column).
export const INTERRUPTIBLE_INFANTRY_ACTIONS = new Set([0,1,2,3,4,6,8,9,10,12,31,32,33]);
