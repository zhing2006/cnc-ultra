// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
// Ported from SDATA.CPP, the SmudgeTypeClass objects. Bib images store one frame per cell.
export const SMUDGES = [
  'CR1', 'CR2', 'CR3', 'CR4', 'CR5', 'CR6',
  'SC1', 'SC2', 'SC3', 'SC4', 'SC5', 'SC6', 'BIB1', 'BIB2', 'BIB3',
];

export function bibWidth(name: string): number {
  return name === 'BIB1' ? 4 : name === 'BIB2' ? 3 : name === 'BIB3' ? 2 : 0;
}
