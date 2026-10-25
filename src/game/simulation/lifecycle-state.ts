/** Integer commands shared by CPU construction and both lifecycle implementations. */
export const CHANGE_WORDS=15;
export const CREATE=1,HEALTH=2,REMOVE=4,DESTINATION=8,TARGET=16,AMMO=32,FACING=64,STATUS=128,NEARBY=256;
/** Creation can carry both a scatter destination and an independent mission target. */
export const INITIAL_ORDER=1024;
/** A reinforcement's first adjacent step crosses the map edge without a whole-map route. */
export const DIRECT_ENTRY=2048;
/** Replace a live actor's mission and its two independent targets. */
export const ORDER=4096;
export const CREATE_TECHNICIAN=8192, CREATE_LOANER=16384;
