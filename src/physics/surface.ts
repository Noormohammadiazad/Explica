/**
 * The top surface of a page stack, a cylinder z = S(x) along the spine.
 *
 * Near the binding the stack is pulled down into the gutter: the surface
 * rises from the pivot height `base` at x = 0 to the stack height `top` over
 * the gutter width G with the C¹ profile g(s) = 1 − (1 − s)².
 *
 * Optionally the surface also includes the *actual* shape of the sheet lying
 * beneath (`profile`): resting sheets are cylinders, so their cross-section
 * is a polyline in |x|. A sheet in flight then collides with the sheet below
 * it rather than with an idealised stack — sheet-on-sheet contact.
 */
export interface StackSurface {
  /** Height at the spine (the binding pivot). */
  base: number;
  /** Height of the flat part of the stack. */
  top: number;
  /** Gutter width [m]. */
  gutter: number;
  /** Cross-section of the sheet beneath: |x| ascending … */
  profileX?: Float64Array;
  /** … and heights. */
  profileZ?: Float64Array;
}

function gutterHeight(s: StackSurface, ax: number): number {
  if (ax >= s.gutter || s.gutter <= 0) return s.top;
  const r = 1 - ax / s.gutter;
  return s.base + (s.top - s.base) * (1 - r * r);
}

function gutterSlope(s: StackSurface, ax: number): number {
  if (ax >= s.gutter || s.gutter <= 0) return 0;
  const r = 1 - ax / s.gutter;
  return ((s.top - s.base) * 2 * r) / s.gutter;
}

/** Index i with xs[i] ≤ ax < xs[i+1], or −1 outside the profile. */
function segment(xs: Float64Array, ax: number): number {
  const n = xs.length;
  if (n < 2 || ax < xs[0] || ax > xs[n - 1]) return -1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= ax) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Height of the stack surface at x (symmetric in x). */
export function surfaceHeight(s: StackSurface, x: number): number {
  const ax = Math.abs(x);
  let h = gutterHeight(s, ax);
  if (s.profileX && s.profileZ) {
    const i = segment(s.profileX, ax);
    if (i >= 0) {
      const x0 = s.profileX[i];
      const x1 = s.profileX[i + 1];
      const t = x1 > x0 ? (ax - x0) / (x1 - x0) : 0;
      const p = s.profileZ[i] + (s.profileZ[i + 1] - s.profileZ[i]) * t;
      if (p > h) h = p;
    }
  }
  return h;
}

/** dS/dx (signed: the surface is a function of |x|). */
export function surfaceSlope(s: StackSurface, x: number): number {
  const ax = Math.abs(x);
  let h = gutterHeight(s, ax);
  let d = gutterSlope(s, ax);
  if (s.profileX && s.profileZ) {
    const i = segment(s.profileX, ax);
    if (i >= 0) {
      const x0 = s.profileX[i];
      const x1 = s.profileX[i + 1];
      const t = x1 > x0 ? (ax - x0) / (x1 - x0) : 0;
      const p = s.profileZ[i] + (s.profileZ[i + 1] - s.profileZ[i]) * t;
      if (p > h) {
        h = p;
        d = x1 > x0 ? (s.profileZ[i + 1] - s.profileZ[i]) / (x1 - x0) : 0;
      }
    }
  }
  return x >= 0 ? d : -d;
}

/** Sensible gutter width for a given rise above the pivot. */
export function gutterWidth(rise: number, pageWidth: number): number {
  return Math.min(Math.max(3.2 * Math.abs(rise) + 0.006, 0.006), 0.25 * pageWidth);
}
