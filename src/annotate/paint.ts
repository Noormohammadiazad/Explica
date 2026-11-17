import { NOTE_SIZE, type Annotation, type Stroke } from './model';

/**
 * Paints a page's annotations into a canvas covering the page (w × h px).
 * The paper shader composites it with a "darken" blend, min(paper, mark): a
 * light highlighter colour tints white paper but leaves black type black, and
 * dark ink simply shows. So highlights go under the print, ink over it.
 */
export function paintPage(g: CanvasRenderingContext2D, items: readonly Annotation[], w: number, h: number, draft?: Stroke | null): void {
  g.clearRect(0, 0, w, h);
  for (const a of items) {
    if (a.kind !== 'highlight') continue;
    g.fillStyle = a.color;
    g.globalAlpha = 0.92;
    for (const q of a.quads) {
      g.beginPath();
      g.moveTo(q[0] * w, q[1] * h);
      g.lineTo(q[2] * w, q[3] * h);
      g.lineTo(q[4] * w, q[5] * h);
      g.lineTo(q[6] * w, q[7] * h);
      g.closePath();
      g.fill();
    }
  }
  g.globalAlpha = 1;
  for (const a of items) if (a.kind === 'stroke') paintStroke(g, a, w, h);
  if (draft) paintStroke(g, draft, w, h);
  for (const a of items) if (a.kind === 'note') paintNoteMark(g, a.x * w, a.y * h, NOTE_SIZE * w);
}

/** A pen stroke, smoothed through the midpoints of its polyline. */
export function paintStroke(g: CanvasRenderingContext2D, s: Stroke, w: number, h: number): void {
  const p = s.points;
  const lw = Math.max(1, s.width * w);
  g.strokeStyle = g.fillStyle = s.color;
  g.lineWidth = lw;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (p.length === 2) {
    g.beginPath();
    g.arc(p[0] * w, p[1] * h, lw / 2, 0, 2 * Math.PI);
    g.fill();
    return;
  }
  g.beginPath();
  g.moveTo(p[0] * w, p[1] * h);
  for (let i = 2; i + 3 < p.length; i += 2) {
    const mx = ((p[i] + p[i + 2]) / 2) * w;
    const my = ((p[i + 1] + p[i + 3]) / 2) * h;
    g.quadraticCurveTo(p[i] * w, p[i + 1] * h, mx, my);
  }
  g.lineTo(p[p.length - 2] * w, p[p.length - 1] * h);
  g.stroke();
}

/** A small sticky note: a yellow square with a turned-down corner and a few lines of "writing". */
export function paintNoteMark(g: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const s = size / 2;
  const fold = size * 0.3;
  g.save();
  g.translate(cx, cy);
  g.rotate(-0.06);
  g.beginPath();
  g.moveTo(-s, -s);
  g.lineTo(s, -s);
  g.lineTo(s, s - fold);
  g.lineTo(s - fold, s);
  g.lineTo(-s, s);
  g.closePath();
  g.fillStyle = '#ffd45c';
  g.fill();
  g.lineWidth = Math.max(1, size * 0.04);
  g.strokeStyle = '#9a7414';
  g.stroke();
  g.beginPath();
  g.moveTo(s, s - fold);
  g.lineTo(s - fold, s - fold);
  g.lineTo(s - fold, s);
  g.closePath();
  g.fillStyle = '#e2ad2d';
  g.fill();
  g.stroke();
  g.strokeStyle = '#a27a19';
  g.lineWidth = Math.max(1, size * 0.035);
  for (let i = 0; i < 3; i++) {
    const y = -s + size * (0.3 + i * 0.18);
    g.beginPath();
    g.moveTo(-s + size * 0.18, y);
    g.lineTo(s - size * (i === 2 ? 0.42 : 0.18), y);
    g.stroke();
  }
  g.restore();
}
