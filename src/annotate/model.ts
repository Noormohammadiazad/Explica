/**
 * Annotations live in page coordinates: x and y are fractions of the page's
 * width and height from its top-left corner (y down), and widths are fractions
 * of the page width. They are drawn into the page's own surface, so they bend,
 * curl and project with the paper exactly, at any zoom, in either reading
 * direction, on resting and turning pages alike.
 */
export type Tool = 'read' | 'highlight' | 'pen' | 'note' | 'eraser';

export interface Highlight {
  id: string;
  kind: 'highlight';
  page: number;
  color: string;
  /** Quadrilaterals [x0, y0, … x3, y3]: top-left, top-right, bottom-right, bottom-left. */
  quads: number[][];
  text: string;
}

export interface Stroke {
  id: string;
  kind: 'stroke';
  page: number;
  color: string;
  /** Pen width, as a fraction of the page width. */
  width: number;
  /** Flat polyline [x0, y0, x1, y1, …]. */
  points: number[];
}

export interface Note {
  id: string;
  kind: 'note';
  page: number;
  /** Centre of the note's mark. */
  x: number;
  y: number;
  text: string;
}

export type Annotation = Highlight | Stroke | Note;

export const HIGHLIGHT_COLORS = [
  { name: 'Yellow', value: '#ffe066' },
  { name: 'Green', value: '#aeea8c' },
  { name: 'Blue', value: '#9fd2ff' },
  { name: 'Pink', value: '#ffaccb' },
  { name: 'Orange', value: '#ffc078' },
] as const;

export const PEN_COLORS = [
  { name: 'Ink', value: '#1f2a44' },
  { name: 'Red', value: '#c8302c' },
  { name: 'Blue', value: '#1f5fd1' },
  { name: 'Green', value: '#2d8a4e' },
] as const;

export const PEN_WIDTHS = [
  { name: 'Fine', value: 0.0032 },
  { name: 'Medium', value: 0.0065 },
  { name: 'Bold', value: 0.013 },
] as const;

/** Size of a note's mark on the page (fraction of the page width). */
export const NOTE_SIZE = 0.045;

export function newId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Ramer–Douglas–Peucker simplification of a flat polyline, keeping its ends. */
export function simplify(points: readonly number[], tol: number): number[] {
  const n = points.length / 2;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bd = tol2;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance2(points[2 * i], points[2 * i + 1], points[2 * a], points[2 * a + 1], points[2 * b], points[2 * b + 1]);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[2 * i], points[2 * i + 1]);
  return out;
}

/** Squared distance from point p to segment ab. */
export function segmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** Is point (x, y) inside the convex quad q? */
export function inQuad(q: readonly number[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = q[2 * i];
    const ay = q[2 * i + 1];
    const bx = q[(2 * i + 2) % 8];
    const by = q[(2 * i + 3) % 8];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }
  return true;
}

/** Do two convex quads overlap (separating-axis test)? */
export function quadsOverlap(a: readonly number[], b: readonly number[]): boolean {
  for (const q of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const nx = -(q[(2 * i + 3) % 8] - q[2 * i + 1]);
      const ny = q[(2 * i + 2) % 8] - q[2 * i];
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (let k = 0; k < 4; k++) {
        const pa = a[2 * k] * nx + a[2 * k + 1] * ny;
        const pb = b[2 * k] * nx + b[2 * k + 1] * ny;
        amin = Math.min(amin, pa);
        amax = Math.max(amax, pa);
        bmin = Math.min(bmin, pb);
        bmax = Math.max(bmax, pb);
      }
      if (amax < bmin || bmax < amin) return false;
    }
  }
  return true;
}

/**
 * Annotations of a page touched by an eraser of radius r at (x, y). Distances
 * are measured in page-width units: `aspect` (page height / width) scales y.
 */
export function annotationsAt(items: readonly Annotation[], page: number, x: number, y: number, r: number, aspect: number): Annotation[] {
  const Y = y * aspect;
  return items.filter((a) => {
    if (a.page !== page) return false;
    if (a.kind === 'note') return Math.hypot(a.x - x, a.y * aspect - Y) <= r + NOTE_SIZE / 2;
    if (a.kind === 'highlight') {
      return a.quads.some((q) => inQuad(q, x, y) || nearQuad(q, x, Y, r, aspect));
    }
    const reach = r + a.width / 2;
    const p = a.points;
    if (p.length === 2) return Math.hypot(p[0] - x, p[1] * aspect - Y) <= reach;
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (segmentDistance2(x, Y, p[i], p[i + 1] * aspect, p[i + 2], p[i + 3] * aspect) <= reach * reach) return true;
    }
    return false;
  });
}

function nearQuad(q: readonly number[], x: number, Y: number, r: number, aspect: number): boolean {
  for (let i = 0; i < 4; i++) {
    const d = segmentDistance2(x, Y, q[2 * i], q[2 * i + 1] * aspect, q[(2 * i + 2) % 8], q[(2 * i + 3) % 8] * aspect);
    if (d <= r * r) return true;
  }
  return false;
}

/** Shape check for data read back from storage (it may be old, edited or corrupt). */
export function isAnnotation(a: unknown): a is Annotation {
  if (!a || typeof a !== 'object') return false;
  const o = a as Record<string, unknown>;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (typeof o.id !== 'string' || !Number.isInteger(o.page) || (o.page as number) < 0) return false;
  switch (o.kind) {
    case 'highlight':
      return typeof o.color === 'string' && Array.isArray(o.quads) && o.quads.every((q) => Array.isArray(q) && q.length === 8 && q.every(num));
    case 'stroke':
      return typeof o.color === 'string' && num(o.width) && Array.isArray(o.points) && o.points.length >= 2 && o.points.length % 2 === 0 && o.points.every(num);
    case 'note':
      return num(o.x) && num(o.y) && typeof o.text === 'string';
    default:
      return false;
  }
}
