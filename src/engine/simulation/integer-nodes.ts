import { Fn, If, Loop, int, uint, select } from 'three/tsl';
import type { Node } from 'three/webgpu';

export const intMin = (a: Node<'int'>, b: Node<'int'>) => select(a.lessThan(b), a, b);
export const intMax = (a: Node<'int'>, b: Node<'int'>) => select(a.greaterThan(b), a, b);

export const hashNode = Fn(([value]: [Node<'uint'>]) => {
  const v = value.toVar();
  v.assign(v.bitXor(v.shiftRight(16)).mul(uint(0x7feb352d)));
  v.assign(v.bitXor(v.shiftRight(15)).mul(uint(0x846ca68b)));
  return v.bitXor(v.shiftRight(16));
});
export const randomNode = Fn(([seed, frame, object, stream]: [Node<'uint'>, Node<'uint'>, Node<'uint'>, Node<'uint'>]) =>
  hashNode(seed.bitXor(hashNode(frame)).bitXor(hashNode(object.add(uint(0x9e3779b9))))
    .bitXor(hashNode(stream.add(uint(0x85ebca6b))))));

const magnitude = Fn(([v]: [Node<'int'>]) => {
  const result = uint(v).toVar();
  If(v.lessThan(0), () => result.assign(uint(0).sub(result)));
  return result;
});

/** The low 40 bits of an unsigned product, using 16-bit limbs without a floating-point intermediate. */
export const fixedMulNode = Fn(([a, b]: [Node<'int'>, Node<'int'>]) => {
  const x = magnitude(a), y = magnitude(b);
  const low = x.bitAnd(65535).mul(y.bitAnd(65535)).toVar();
  const cross1 = x.shiftRight(16).mul(y.bitAnd(65535));
  const cross2 = y.shiftRight(16).mul(x.bitAnd(65535));
  const mid = low.shiftRight(16).add(cross1.bitAnd(65535)).add(cross2.bitAnd(65535)).toVar();
  const high = x.shiftRight(16).mul(y.shiftRight(16)).add(cross1.shiftRight(16))
    .add(cross2.shiftRight(16)).add(mid.shiftRight(16));
  const result = low.bitAnd(65535).shiftRight(8).bitOr(mid.bitAnd(65535).shiftLeft(8))
    .bitOr(high.shiftLeft(24)).toVar();
  If(a.bitXor(b).lessThan(0), () => result.assign(uint(0).sub(result)));
  return int(result);
});

/** Binary long division of a 40-bit numerator by a 32-bit divisor. Divisors are nonzero. */
export const fixedDivNode = Fn(([a, b]: [Node<'int'>, Node<'int'>]) => {
  const numerator = magnitude(a), divisor = magnitude(b);
  const remainder = uint(0).toVar(), quotient = uint(0).toVar();
  Loop({ start: 39, end: 0, condition: '>=', update: '--', type: 'int' }, ({ i }) => {
    const bit = uint(0).toVar();
    If(i.greaterThanEqual(8), () => bit.assign(numerator.shiftRight(uint(i.sub(8))).bitAnd(1)));
    const carry = remainder.shiftRight(31).toVar();
    remainder.assign(remainder.shiftLeft(1).bitOr(bit));
    quotient.assign(quotient.shiftLeft(1));
    If(carry.notEqual(0).or(remainder.greaterThanEqual(divisor)), () => {
      remainder.subAssign(divisor);
      quotient.bitOrAssign(1);
    });
  });
  If(a.bitXor(b).lessThan(0), () => quotient.assign(uint(0).sub(quotient)));
  return int(quotient);
});
