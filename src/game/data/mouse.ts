/** A mouse pointer: its frame in MOUSE.SHP and the hotspot inside that frame. */
export interface MousePointer {
  frame: number;
  hotX: number;
  hotY: number;
}

// Ported from MOUSE.CPP, MouseClass::MouseControl: the entries M0 shows. None of them animate.
export const MOUSE_NORMAL: MousePointer = { frame: 0, hotX: 0, hotY: 0 };

/** Scroll arrows for the 8 facings, from north clockwise (MOUSE_N to MOUSE_NW). */
export const MOUSE_SCROLL: readonly MousePointer[] = [
  { frame: 1, hotX: 15, hotY: 0 },
  { frame: 2, hotX: 29, hotY: 0 },
  { frame: 3, hotX: 29, hotY: 12 },
  { frame: 4, hotX: 29, hotY: 23 },
  { frame: 5, hotX: 15, hotY: 23 },
  { frame: 6, hotX: 0, hotY: 23 },
  { frame: 7, hotX: 0, hotY: 13 },
  { frame: 8, hotX: 0, hotY: 0 },
];

/** Arrows for a direction the map cannot scroll in (MOUSE_NO_N to MOUSE_NO_NW). */
export const MOUSE_NO_SCROLL: readonly MousePointer[] = [
  { frame: 130, hotX: 15, hotY: 0 },
  { frame: 131, hotX: 29, hotY: 0 },
  { frame: 132, hotX: 29, hotY: 12 },
  { frame: 133, hotX: 29, hotY: 23 },
  { frame: 134, hotX: 15, hotY: 23 },
  { frame: 135, hotX: 0, hotY: 23 },
  { frame: 136, hotX: 0, hotY: 13 },
  { frame: 137, hotX: 0, hotY: 0 },
];
