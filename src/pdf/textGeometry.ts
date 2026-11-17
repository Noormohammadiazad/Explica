import type { TextRun } from './pageSource';

export interface Pt2 {
  x: number;
  y: number;
}

/** Selection box of a run above and below its baseline, as fractions of the font size. */
export const ASCENT = 0.82;
export const DESCENT = 0.24;

/** A run's selection box in page points: its top-left, top-right and bottom-left corners. */
export function runBox(r: TextRun): { tl: Pt2; tr: Pt2; bl: Pt2 } {
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  // "up" is the baseline direction turned a quarter towards −y (page y points down)
  const tl = { x: r.x + s * ASCENT * r.size, y: r.y - c * ASCENT * r.size };
  const tr = { x: tl.x + c * r.width, y: tl.y + s * r.width };
  const bl = { x: r.x - s * DESCENT * r.size, y: r.y + c * DESCENT * r.size };
  return { tl, tr, bl };
}

/**
 * CSS `matrix(a, b, c, d, e, f)` taking the box [0, w] × [0, h] (transform
 * origin at its top-left) onto the parallelogram with corners tl, tr, bl.
 */
export function affineOnto(tl: Pt2, tr: Pt2, bl: Pt2, w: number, h: number): [number, number, number, number, number, number] {
  return [(tr.x - tl.x) / w, (tr.y - tl.y) / w, (bl.x - tl.x) / h, (bl.y - tl.y) / h, tl.x, tl.y];
}

/**
 * Where point p lies in the parallelogram tl / tr / bl: s runs along the width
 * (tl → tr), t down the height (tl → bl); both are in 0..1 inside. Null if the
 * parallelogram is degenerate (seen edge-on).
 */
export function parallelogramCoords(tl: Pt2, tr: Pt2, bl: Pt2, p: Pt2): { s: number; t: number } | null {
  const ux = tr.x - tl.x;
  const uy = tr.y - tl.y;
  const vx = bl.x - tl.x;
  const vy = bl.y - tl.y;
  const det = ux * vy - uy * vx;
  if (Math.abs(det) < 1e-9) return null;
  const dx = p.x - tl.x;
  const dy = p.y - tl.y;
  return { s: (dx * vy - dy * vx) / det, t: (ux * dy - uy * dx) / det };
}

/** Distance from p to the parallelogram (0 inside), in the units of the points. */
export function parallelogramDistance(tl: Pt2, tr: Pt2, bl: Pt2, p: Pt2): number {
  const st = parallelogramCoords(tl, tr, bl, p);
  if (!st) return Infinity;
  const s = Math.min(1, Math.max(0, st.s));
  const t = Math.min(1, Math.max(0, st.t));
  const qx = tl.x + s * (tr.x - tl.x) + t * (bl.x - tl.x);
  const qy = tl.y + s * (tr.y - tl.y) + t * (bl.y - tl.y);
  return Math.hypot(p.x - qx, p.y - qy);
}

/** Caret index nearest to `at` along a run whose character boundaries are `edges` (edges[0] = 0 … edges[n]). */
export function caretIndex(edges: readonly number[], at: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < edges.length; i++) {
    const d = Math.abs(edges[i] - at);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

const WORD = /[\p{L}\p{N}\p{M}_'’-]/u;

/** The word around caret index i in str, as [start, end); a single character if i is not on a word. */
export function wordAround(str: string, i: number): [number, number] {
  if (!str.length) return [0, 0];
  let a = Math.max(0, Math.min(i, str.length - 1));
  // a caret just after a word belongs to that word
  if (!WORD.test(str[a]) && a > 0 && WORD.test(str[a - 1])) a--;
  if (!WORD.test(str[a])) return [a, a + 1];
  let s = a;
  while (s > 0 && WORD.test(str[s - 1])) s--;
  let e = a + 1;
  while (e < str.length && WORD.test(str[e])) e++;
  return [s, e];
}
