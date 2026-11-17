/**
 * Small, allocation-free dense linear algebra used by the physics core.
 * Matrices are row-major Float64Arrays.
 */

/** Writes the rotation matrix for a rotation of `angle` about unit axis (ax, ay, az). */
export function rodrigues(
  ax: number,
  ay: number,
  az: number,
  angle: number,
  out: Float64Array,
  o = 0,
): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const C = 1 - c;
  out[o + 0] = c + ax * ax * C;
  out[o + 1] = ax * ay * C - az * s;
  out[o + 2] = ax * az * C + ay * s;
  out[o + 3] = ay * ax * C + az * s;
  out[o + 4] = c + ay * ay * C;
  out[o + 5] = ay * az * C - ax * s;
  out[o + 6] = az * ax * C - ay * s;
  out[o + 7] = az * ay * C + ax * s;
  out[o + 8] = c + az * az * C;
}

/** out = A·B for 3×3 matrices (out must not alias A or B). */
export function mul33(
  A: Float64Array,
  a: number,
  B: Float64Array,
  b: number,
  out: Float64Array,
  o: number,
): void {
  for (let i = 0; i < 3; i++) {
    const a0 = A[a + i * 3];
    const a1 = A[a + i * 3 + 1];
    const a2 = A[a + i * 3 + 2];
    out[o + i * 3] = a0 * B[b] + a1 * B[b + 3] + a2 * B[b + 6];
    out[o + i * 3 + 1] = a0 * B[b + 1] + a1 * B[b + 4] + a2 * B[b + 7];
    out[o + i * 3 + 2] = a0 * B[b + 2] + a1 * B[b + 5] + a2 * B[b + 8];
  }
}

/**
 * Solves A x = b for symmetric positive-definite A (n×n, row-major) by
 * Cholesky factorisation. `L` is scratch of size n². If the matrix is not
 * numerically PD a growing ridge is added to the diagonal.
 * Returns the ridge that was needed (0 when A was PD as given).
 */
export function choleskySolve(
  A: Float64Array,
  n: number,
  b: Float64Array,
  x: Float64Array,
  L: Float64Array,
): number {
  let trace = 0;
  for (let i = 0; i < n; i++) trace += Math.abs(A[i * n + i]);
  const scale = trace / n || 1;
  let ridge = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (factor(A, n, L, ridge)) {
      // forward substitution: L y = b
      for (let i = 0; i < n; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k];
        x[i] = s / L[i * n + i];
      }
      // back substitution: Lᵀ x = y
      for (let i = n - 1; i >= 0; i--) {
        let s = x[i];
        for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
        x[i] = s / L[i * n + i];
      }
      return ridge;
    }
    ridge = ridge === 0 ? scale * 1e-10 : ridge * 100;
  }
  x.fill(0);
  return Infinity;
}

function factor(A: Float64Array, n: number, L: Float64Array, ridge: number): boolean {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      if (i === j) s += ridge;
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0) || !Number.isFinite(s)) return false;
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  return true;
}
