import { surfaceHeight, type StackSurface } from './surface';

/**
 * Rest configuration of a sheet lying on a stack: the chain of rigid strips
 * whose hinge lines all lie exactly on the (gutter-curved) stack surface.
 *
 * Returns q = (p, ψ_0, …, ψ_{K−1}) with p = 0 (parallel rulings).
 *
 * @param side +1 for the right-hand stack, −1 for the left-hand stack
 */
export function restConfiguration(
  W: number,
  K: number,
  surface: StackSurface,
  side: 1 | -1,
  pivotZ: number,
  out = new Float64Array(K + 1),
): Float64Array {
  const delta = W / (K - 1);
  out[0] = 0;
  let px = 0;
  let pz = pivotZ;
  let prevTheta = 0;
  for (let j = 0; j < K; j++) {
    const a = j === 0 ? 0 : (j - 0.5) * delta;
    const b = j === K - 1 ? W : (j + 0.5) * delta;
    const L = b - a;
    // next point on the curve z = S(x) at Euclidean distance L (bisection on x)
    let lo = px;
    let hi = px + side * L;
    for (let it = 0; it < 48; it++) {
      const mid = 0.5 * (lo + hi);
      const dz = surfaceHeight(surface, mid) - pz;
      const dx = mid - px;
      if (dx * dx + dz * dz < L * L) lo = mid;
      else hi = mid;
    }
    const nx = 0.5 * (lo + hi);
    const nz = surfaceHeight(surface, nx);
    let theta = Math.atan2(nz - pz, nx - px);
    // left-hand pages live around ψ = π: unwrap so a dipping surface gives π + ε, not −π + ε
    if (side < 0 && theta < 0) theta += 2 * Math.PI;
    if (j === 0) out[1] = theta;
    else out[1 + j] = wrapAngle(theta - prevTheta);
    prevTheta = theta;
    px = nx;
    pz = nz;
  }
  return out;
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
