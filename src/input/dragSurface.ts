/**
 * Maps a pointer ray (in the book frame) to a 3D target for the hand that
 * holds a page.
 *
 * For a page picked up from a stack, the target lives on a height-field
 * z = Z(x) along the book: flat at the grab's rest height near the grab
 * (small drags stay low → a delicate peel), rising as A·sin²(π s) towards the
 * spine (s = progress across the book) and descending onto the opposite stack.
 * The physics, not this surface, decides the page's actual shape.
 */
export type Vec3 = [number, number, number];

export interface DragSurface {
  intersect(o: Vec3, d: Vec3): Vec3 | null;
}

export class ArcDragSurface implements DragSurface {
  /**
   * @param x0 signed x of the grab point at rest (> 0: right-hand page)
   * @param z0 rest height of the grab point
   * @param zFar height of the opposite stack top
   * @param lift peak height above the base over the spine
   */
  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly zFar: number,
    readonly lift: number,
  ) {}

  static forGrab(x0: number, z0: number, zFar: number): ArcDragSurface {
    const r = Math.max(Math.abs(x0), 0.01);
    return new ArcDragSurface(Math.sign(x0 || 1) * r, z0, zFar, 0.55 * r + 0.008);
  }

  /** Progress across the book: 0 at the grab, ½ over the spine, 1 at the mirrored point. */
  progress(x: number): number {
    const s = (this.x0 - x) / (2 * this.x0);
    return s < 0 ? 0 : s > 1 ? 1 : s;
  }

  height(x: number): number {
    const s = this.progress(x);
    const smooth = s * s * (3 - 2 * s);
    const bump = Math.sin(Math.PI * s) ** 2;
    return this.z0 + (this.zFar - this.z0) * smooth + this.lift * bump;
  }

  /** Point on the surface at progress s ∈ [0, 1] (used by automatic turns). */
  pointAt(s: number, y: number): Vec3 {
    const x = this.x0 * Math.cos(Math.PI * s);
    return [x, y, this.height(x)];
  }

  intersect(o: Vec3, d: Vec3): Vec3 | null {
    const zLo = Math.min(this.z0, this.zFar) - 0.02;
    const zHi = Math.max(this.z0, this.zFar) + this.lift + 0.02;
    // parameter range where the ray is inside the slab zLo ≤ z ≤ zHi
    let t0 = 0;
    let t1 = 20;
    if (Math.abs(d[2]) > 1e-9) {
      const ta = (zLo - o[2]) / d[2];
      const tb = (zHi - o[2]) / d[2];
      t0 = Math.max(0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    if (t1 <= t0) return null;
    const f = (t: number) => o[2] + t * d[2] - this.height(o[0] + t * d[0]);
    const N = 96;
    let prevT = t0;
    let prevF = f(t0);
    for (let i = 1; i <= N; i++) {
      const t = t0 + ((t1 - t0) * i) / N;
      const ft = f(t);
      if (prevF === 0) return at(o, d, prevT);
      if ((prevF > 0) !== (ft > 0)) {
        let a = prevT;
        let b = t;
        let fa = prevF;
        for (let k = 0; k < 40; k++) {
          const m = 0.5 * (a + b);
          const fm = f(m);
          if ((fa > 0) === (fm > 0)) {
            a = m;
            fa = fm;
          } else b = m;
        }
        return at(o, d, 0.5 * (a + b));
      }
      prevT = t;
      prevF = ft;
    }
    return null;
  }
}

/** A plane through a point (used when catching a page in mid-air). */
export class PlaneDragSurface implements DragSurface {
  constructor(
    readonly point: Vec3,
    readonly normal: Vec3,
  ) {}

  intersect(o: Vec3, d: Vec3): Vec3 | null {
    const n = this.normal;
    const den = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    if (Math.abs(den) < 1e-6) return null;
    const t =
      ((this.point[0] - o[0]) * n[0] + (this.point[1] - o[1]) * n[1] + (this.point[2] - o[2]) * n[2]) / den;
    if (t <= 0) return null;
    return at(o, d, t);
  }
}

function at(o: Vec3, d: Vec3, t: number): Vec3 {
  return [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
}

/**
 * Keeps a hand target inside the region a material point at distance `reach`
 * from the spine can physically reach (with some slack), so an over-eager
 * pointer cannot yank the paper with absurd forces.
 */
export function clampReach(target: Vec3, pivotZ: number, reach: number, y0: number): Vec3 {
  const dx = target[0];
  const dz = target[2] - pivotZ;
  const r = Math.hypot(dx, dz);
  const max = reach * 1.08 + 0.01;
  let x = target[0];
  let z = target[2];
  if (r > max) {
    x = (dx / r) * max;
    z = pivotZ + (dz / r) * max;
  }
  const dy = target[1] - y0;
  const maxY = 0.6 * reach + 0.02;
  const y = y0 + Math.max(-maxY, Math.min(maxY, dy));
  return [x, y, z];
}
