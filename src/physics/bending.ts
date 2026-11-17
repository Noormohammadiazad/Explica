/**
 * Hinge bending stiffness for the fan-ruled discrete developable.
 *
 * Bending energy of an inextensible plate: E = ½ D ∫ κ² dA. A hinge of angle
 * ψ_k smeared over its dual cell of local width h_k(s) has κ = ψ_k / h_k,
 * hence E_k = ½ c_k ψ_k² with c_k = D ∫_{ruling ∩ Ω} ds / h_k(s).
 *
 * For the fan with convergence p, a point at height v on ruling k lies at
 * distance |σ_k − b|·(1 + p v) / √(1 + (b p)²) from the ruling through (b, 0),
 * so with dual-cell boundaries b_{k−1} = (k−1)δ, b_k = kδ the integral has
 * the closed form implemented here.
 */
export function hingeStiffness(
  k: number,
  p: number,
  W: number,
  H: number,
  delta: number,
  D: number,
): number {
  const sk = (k - 0.5) * delta;
  const b0 = (k - 1) * delta;
  const b1 = k * delta;
  // v-range of the ruling inside the sheet: σ_k(1 + p v) ≤ W
  let va = -H / 2;
  let vb = H / 2;
  if (sk > 0 && p !== 0) {
    const vEdge = (W / sk - 1) / p;
    if (p > 0) vb = Math.min(vb, vEdge);
    else va = Math.max(va, vEdge);
  }
  if (vb <= va) return 0;
  const len = logIntegral(p, va, vb); // ∫ dv / (1 + p v)
  const width =
    0.5 * delta * (1 / Math.sqrt(1 + (b0 * p) ** 2) + 1 / Math.sqrt(1 + (b1 * p) ** 2));
  return (D * Math.sqrt(1 + (sk * p) ** 2) * len) / width;
}

/** ∫_a^b dv / (1 + p v), stable as p → 0. */
export function logIntegral(p: number, a: number, b: number): number {
  if (Math.abs(p) < 1e-9) return b - a;
  return (Math.log1p(p * b) - Math.log1p(p * a)) / p;
}
