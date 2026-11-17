import { SheetSim, type SheetEnvironment } from './sheetSim';
import type { PaperParams, SheetDims } from './params';

/**
 * Static equilibrium of a sheet resting on its stack, found with the dynamic
 * simulator itself: large implicit-Euler steps with extra damping are a
 * damped Newton iteration on the potential energy. Starting from the
 * analytic "lying on the surface" pose, it adds what the analytic pose
 * ignores — the binding's torsion spring lifting the gutter, the stiffness of
 * the paper bridging the curve, and contact compliance.
 *
 * Using this pose both for drawing resting pages and as the initial state of a
 * picked-up page guarantees there is no jump when a page is touched.
 */
export function staticEquilibrium(
  dims: SheetDims,
  params: PaperParams,
  env: SheetEnvironment,
  q0: ArrayLike<number>,
  K: number,
  maxSteps = 90,
): Float64Array {
  const p: PaperParams = {
    ...params,
    bendDamping: Math.max(params.bendDamping, 0.03),
    airLinear: 0,
    dragCoefficient: 0,
  };
  const sim = new SheetSim(dims, p, env, K, [K, 6]);
  sim.setState(q0);
  sim.maxIterations = 4;
  const prev = new Float64Array(sim.n);
  for (let i = 0; i < maxSteps; i++) {
    prev.set(sim.q);
    sim.step(0.012);
    let d = 0;
    for (let k = 0; k < sim.n; k++) d = Math.max(d, Math.abs(sim.q[k] - prev[k]));
    if (i > 4 && d < 2e-7) break;
  }
  const out = Float64Array.from(sim.q);
  out[0] = 0; // a resting sheet has parallel rulings
  return out;
}
