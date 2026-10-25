/** Integer commands shared by CPU construction and both lifecycle implementations. */
export const CHANGE_WORDS=15;
export const CREATE=1,HEALTH=2,REMOVE=4,DESTINATION=8,TARGET=16,AMMO=32,FACING=64,STATUS=128,NEARBY=256;
/** Creation can carry both a scatter destination and an independent mission target. */
export const INITIAL_ORDER=1024;
