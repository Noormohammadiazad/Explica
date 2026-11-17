import { rodrigues, mul33 } from './linalg';

/**
 * Forward kinematics of a discrete developable sheet.
 *
 * The sheet occupies the material rectangle u ∈ [0, W], v ∈ [−H/2, H/2]
 * (u = distance from the spine). It is cut by straight rulings into rigid
 * strips joined by hinges. Hinge 0 is the spine (u = 0); bending hinge j ≥ 1
 * passes through (σ_j, 0) with σ_j = (j − ½)·δ, so the hinges' dual cells
 * [(j−1)δ, jδ] tile the sheet exactly.
 *
 * All rulings belong to a fan whose apex sits on the spine line at
 * v = −1/p (p = 0 → parallel rulings / cylinder). A material point has fan
 * coordinate σ = u / (1 + p·v) and lies in strip
 * s = clamp(⌊σ/δ + ½⌋, 0, nBend).
 *
 * Strip transforms follow the product-of-exponentials formula:
 *   T_s = B · exp(ψ_0 ξ̂_0) · … · exp(ψ_s ξ̂_s),
 * with B a translation of the spine axis to the binding pivot.
 */
export class HingeChain {
  /** Number of strips (= number of hinges including the spine). */
  readonly nStrips: number;
  /** Strip rotations, row-major 3×3 each. */
  readonly R: Float64Array;
  /** Strip translations. */
  readonly t: Float64Array;
  /** World-space unit axis of each hinge (after the preceding rotations). */
  readonly axis: Float64Array;
  /** World-space point on each hinge axis. */
  readonly axisPoint: Float64Array;
  /** Fan convergence used by the last update. */
  p = 0;

  private readonly tmpR = new Float64Array(9);
  private readonly tmpM = new Float64Array(9);

  constructor(
    readonly W: number,
    readonly H: number,
    /** Number of bending hinges (excluding the spine). */
    readonly nBend: number,
    /** Spacing of bending hinges along the mid-line. */
    readonly delta: number,
  ) {
    this.nStrips = nBend + 1;
    this.R = new Float64Array(9 * this.nStrips);
    this.t = new Float64Array(3 * this.nStrips);
    this.axis = new Float64Array(3 * this.nStrips);
    this.axisPoint = new Float64Array(3 * this.nStrips);
  }

  /** Mid-line coordinate σ_j of hinge j. */
  hingeSigma(j: number): number {
    return j === 0 ? 0 : (j - 0.5) * this.delta;
  }

  /** Fan coordinate of a material point. */
  static sigma(u: number, v: number, p: number): number {
    return u / (1 + p * v);
  }

  /** Strip containing material point (u, v) for the current p. */
  stripOf(u: number, v: number): number {
    const s = Math.floor(u / (1 + this.p * v) / this.delta + 0.5);
    return s < 0 ? 0 : s > this.nBend ? this.nBend : s;
  }

  /**
   * Recomputes all strip transforms.
   * @param p fan convergence
   * @param angles hinge angles; angles[j] for hinge j (0 = spine)
   * @param pivotZ height of the binding pivot (spine axis) in the book frame
   */
  update(p: number, angles: ArrayLike<number>, pivotZ: number): void {
    this.p = p;
    const { R, t, axis, axisPoint, tmpR, tmpM } = this;
    // running transform (rotation Rp, translation tp) = B·Π exp(...)
    let rp = -1; // index of previous strip; -1 means base B
    for (let j = 0; j < this.nStrips; j++) {
      const s = this.hingeSigma(j);
      // rest-frame hinge axis a = −normalize(s·p, 1, 0) through o = (s, 0, 0)
      const dx = s * p;
      const inv = 1 / Math.sqrt(dx * dx + 1);
      const ax = -dx * inv;
      const ay = -inv;
      // world axis & point: apply previous transform
      const o3 = 3 * j;
      if (rp < 0) {
        axis[o3] = ax;
        axis[o3 + 1] = ay;
        axis[o3 + 2] = 0;
        axisPoint[o3] = s;
        axisPoint[o3 + 1] = 0;
        axisPoint[o3 + 2] = pivotZ;
      } else {
        const r = 9 * rp;
        axis[o3] = R[r] * ax + R[r + 1] * ay;
        axis[o3 + 1] = R[r + 3] * ax + R[r + 4] * ay;
        axis[o3 + 2] = R[r + 6] * ax + R[r + 7] * ay;
        axisPoint[o3] = R[r] * s + t[3 * rp];
        axisPoint[o3 + 1] = R[r + 3] * s + t[3 * rp + 1];
        axisPoint[o3 + 2] = R[r + 6] * s + t[3 * rp + 2];
      }
      // local rotation about the rest-frame axis line
      rodrigues(ax, ay, 0, angles[j], tmpR, 0);
      // translation of the local joint transform: te = o − Re·o
      const tex = s - tmpR[0] * s;
      const tey = -tmpR[3] * s;
      const tez = -tmpR[6] * s;
      const r9 = 9 * j;
      if (rp < 0) {
        R.set(tmpR, r9);
        t[o3] = tex;
        t[o3 + 1] = tey;
        t[o3 + 2] = tez + pivotZ;
      } else {
        const r = 9 * rp;
        mul33(R, r, tmpR, 0, tmpM, 0);
        R.set(tmpM, r9);
        t[o3] = R[r] * tex + R[r + 1] * tey + R[r + 2] * tez + t[3 * rp];
        t[o3 + 1] = R[r + 3] * tex + R[r + 4] * tey + R[r + 5] * tez + t[3 * rp + 1];
        t[o3 + 2] = R[r + 6] * tex + R[r + 7] * tey + R[r + 8] * tez + t[3 * rp + 2];
      }
      rp = j;
    }
  }

  /** World position of material point (u, v) assuming it lies in strip s. */
  pointInStrip(s: number, u: number, v: number, out: Float64Array, o = 0): void {
    const r = 9 * s;
    const R = this.R;
    const t = this.t;
    out[o] = R[r] * u + R[r + 1] * v + t[3 * s];
    out[o + 1] = R[r + 3] * u + R[r + 4] * v + t[3 * s + 1];
    out[o + 2] = R[r + 6] * u + R[r + 7] * v + t[3 * s + 2];
  }

  /** World position of material point (u, v). Returns its strip. */
  point(u: number, v: number, out: Float64Array, o = 0): number {
    const s = this.stripOf(u, v);
    this.pointInStrip(s, u, v, out, o);
    return s;
  }
}
