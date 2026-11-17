/**
 * Reading direction.
 *
 * A right-to-left book (Persian, Arabic, Hebrew, Urdu…) is the mirror image of
 * a left-to-right one: it opens with the unread pages on the left, page 1 is
 * the left-hand page, and pages travel from left to right.
 *
 * Explica therefore keeps one book frame for both directions. In the book frame
 * the unread stack is always on the right (+x) and "forward" always means
 * right-to-left over the spine, so the layout, the physics and the gesture
 * machine never need to know the direction. An RTL book is drawn through the
 * mirror x ↦ −x, and only the print is mirrored back so it still reads
 * correctly. The helpers here translate between the screen (what the reader
 * sees and presses) and the book frame.
 */
export type ReadingDirection = 'ltr' | 'rtl';

/** Book-frame → world mirror along x: 1 for LTR, −1 for RTL. */
export function mirrorSign(d: ReadingDirection): 1 | -1 {
  return d === 'rtl' ? -1 : 1;
}

/**
 * Expresses a vector given in the unmirrored book frame (e.g. gravity from the
 * view's rotation) in the actual book frame, in place: the mirror acts on x.
 */
export function toBookFrame(v: [number, number, number], d: ReadingDirection): [number, number, number] {
  v[0] *= mirrorSign(d);
  return v;
}

/**
 * Turn direction (+1 forward, −1 back) for a control on one side of the
 * screen. In LTR, the right side moves forward; RTL mirrors that.
 */
export function turnForScreenSide(side: 'left' | 'right', d: ReadingDirection): 1 | -1 {
  return side === 'right' ? mirrorSign(d) : (-mirrorSign(d) as 1 | -1);
}

/** Turn direction for a key: ← → follow the screen, ↑ ↓ PgUp PgDn the reading order. 0 = not a turn key. */
export function turnForKey(key: string, d: ReadingDirection): -1 | 0 | 1 {
  switch (key) {
    case 'ArrowRight':
      return turnForScreenSide('right', d);
    case 'ArrowLeft':
      return turnForScreenSide('left', d);
    case 'PageDown':
    case 'ArrowDown':
      return 1;
    case 'PageUp':
    case 'ArrowUp':
      return -1;
    default:
      return 0;
  }
}

/** A spread in reading order: the verso is read first, then the recto. 0-based PDF pages; null = none. */
export interface Spread {
  verso: number | null;
  recto: number | null;
}

/** Pages on the left and right of the screen. In RTL the recto is on the left. */
export function screenSpread(s: Spread, d: ReadingDirection): { left: number | null; right: number | null } {
  return d === 'rtl' ? { left: s.recto, right: s.verso } : { left: s.verso, right: s.recto };
}

/**
 * Folio text in reading order, e.g. "2–3  /  48" (1-based). Laid out with
 * `dir` set to the reading direction, an RTL folio shows "48  /  3–2", which
 * matches the pages as they lie on screen, while screen readers still read it
 * in order.
 */
export function folioLabel(s: Spread, pageCount: number): string {
  const pages = [s.verso, s.recto].filter((p): p is number => p != null).map((p) => p + 1);
  return `${pages.join('–') || '—'}  /  ${pageCount}`;
}
