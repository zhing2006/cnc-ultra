/** Signed 24.8 fixed point. Results wrap to 32 bits; products and quotients truncate toward zero. */
export const FIXED_ONE = 256;
export const fixedAdd = (a: number, b: number) => (a + b) | 0;
export const fixedSub = (a: number, b: number) => (a - b) | 0;
export const fixedMul = (a: number, b: number) => Number(BigInt.asIntN(32, BigInt(a) * BigInt(b) / 256n));
/** Callers must supply a nonzero divisor. */
export const fixedDiv = (a: number, b: number) => Number(BigInt.asIntN(32, BigInt(a) * 256n / BigInt(b)));

/** Stateless integer avalanche; the stream distinguishes several draws by the same object in a tick. */
export function hash32(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}
export function randomWord(seed: number, frame: number, object: number, stream = 0): number {
  return hash32(seed ^ hash32(frame) ^ hash32(object + 0x9e3779b9) ^ hash32(stream + 0x85ebca6b));
}

/** Index-salted reduction includes buffer boundaries and is independent of reduction order. */
export function checksum(buffers: readonly (Int32Array | Uint32Array)[]): Uint32Array {
  const result = new Uint32Array(4);
  let index = 0;
  for (const buffer of buffers) {
    for (const word of buffer) {
      result[index & 3] ^= hash32(word ^ hash32(index));
      index++;
    }
    result[index & 3] ^= hash32(buffer.length ^ hash32(index));
    index++;
  }
  return result;
}
