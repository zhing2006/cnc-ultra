// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import type { Node } from 'three/webgpu';
import { Fn, If, abs, int, uint, ivec2, select, countLeadingZeros } from 'three/tsl';
import { intMax, intMin } from '../../engine/simulation/integer-nodes.ts';
type I = Node<'int'>;

/** Ported from MiscAsm.cpp, Distance_Coord. */
export const unitDistance = Fn(([a,b]:[Node<'ivec2'>,Node<'ivec2'>]) => {
  const d=abs(a.sub(b));return intMax(d.x,d.y).add(intMin(d.x,d.y).div(int(2)));
}).setLayout({name:'unitDistance',type:'int',inputs:[{name:'point_a',type:'ivec2'},{name:'point_b',type:'ivec2'}]});

/** Ported from MiscAsm.cpp, Desired_Facing256. */
export const unitDirection = Fn(([from,to]: [Node<'ivec2'>,Node<'ivec2'>]) => {
  const dx=to.x.sub(from.x).toVar(), dy=from.y.sub(to.y).toVar(), quadrant=int(0).toVar();
  dx.assign(abs(to.x.sub(from.x)));
  If(to.x.lessThan(from.x),()=>{ quadrant.assign(192); });
  If(dy.lessThan(int(0)),()=>{quadrant.assign(quadrant.bitXor(int(64)));dy.assign(dy.negate());});
  const add=quadrant.bitAnd(int(64)).bitXor(int(64)).toVar(), small=dy.toVar(), large=dx.toVar();
  If(small.greaterThanEqual(large),()=>{small.assign(dx);large.assign(dy);add.assign(add.bitXor(int(64)));});
  If(small.lessThan(int(256)),()=>{
    // The original shifts both operands until the larger fits in one byte.
    const zeros=countLeadingZeros(uint(large)) as unknown as Node<'uint'>;
    const shift=intMax(int(0),int(24).sub(int(zeros))).toVar();
    large.assign(large.shiftRight(shift));small.assign(small.shiftRight(shift));
  });
  const angle=select(large.equal(int(0)),int(0x1fffffff),small.mul(int(256)).div(intMax(large,int(1))).shiftRight(int(3))).toVar();
  If(add.notEqual(int(0)),()=>{ angle.assign(int(63).sub(angle)); });
  return angle.add(quadrant).bitAnd(int(255));
}).setLayout({name:'unitDirection',type:'int',inputs:[{name:'point_a',type:'ivec2'},{name:'point_b',type:'ivec2'}]});

/** Ported from FACING.H, Difference, and FACING.CPP, Rotation_Adjust. */
export const unitRotate=Fn(([current,desired,rate]:[I,I,I])=>{
  const diff=desired.sub(current).add(int(128)).bitAnd(int(255)).sub(int(128));
  return current.add(select(diff.lessThan(int(0)),int(-1),int(1)).mul(intMin(abs(diff),intMin(rate,int(127))))).bitAnd(int(255));
}).setLayout({name:'unitRotate',type:'int',inputs:[{name:'current',type:'int'},{name:'desired',type:'int'},{name:'rate',type:'int'}]});
export const direction8=(from:Node<'ivec2'>,to:Node<'ivec2'>)=>int(unitDirection(from,to)).add(int(16)).bitAnd(int(255)).shiftRight(int(5));
export const asPoint=(x:I,y:I)=>ivec2(x,y);
