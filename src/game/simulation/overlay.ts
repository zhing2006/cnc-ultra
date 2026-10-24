import { Fn, If, abs, float, floor, ivec2, mix, storage, uniform, vec2, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { GpuSimulation } from '../../engine/simulation/gpu.ts';
import { READY, TARGET } from '../../engine/simulation/state.ts';

/** Cyan flow arrows are a diagnostic overlay, outside the original palette image. */
export function flowOverlay(simulation: GpuSimulation) {
  const enabled = uniform(0, 'int');
  const { width, height } = simulation.setup.grid;
  const next = storage(simulation.next, 'int', width * height).toReadOnly();
  const control = storage(simulation.control, 'int', 4).toReadOnly();
  const draw = (pixel: Node<'vec2'>, color: Node<'vec4'>) => Fn(() => {
    const result = color.toVar(), cell = ivec2(floor(pixel.div(24)));
    If(enabled.notEqual(0).and(control.element(READY).notEqual(0)).and(cell.x.greaterThanEqual(0)).and(cell.y.greaterThanEqual(0))
      .and(cell.x.lessThan(width)).and(cell.y.lessThan(height)), () => {
      const id = cell.y.mul(width).add(cell.x), target = next.element(id), local = pixel.sub(vec2(cell).mul(24)).sub(12);
      If(target.greaterThanEqual(0), () => {
        const direction = vec2(target.mod(width).sub(cell.x), target.div(width).sub(cell.y)).normalize();
        const along = local.dot(direction), across = abs(local.x.mul(direction.y).sub(local.y.mul(direction.x)));
        const stem = abs(along).lessThanEqual(6).and(across.lessThan(0.8));
        const head = along.greaterThanEqual(2).and(along.lessThanEqual(7)).and(abs(across.sub(float(7).sub(along))).lessThan(0.8));
        If(stem.or(head), () => result.assign(mix(result, vec4(0.1, 1, 0.95, 1), 0.85)));
      });
      If(id.equal(control.element(TARGET)).and(abs(local.x).lessThan(4)).and(abs(local.y).lessThan(4)), () => result.assign(vec4(1,0.3,0.9,1)));
    });
    return result;
  })();
  return { enabled, draw };
}
