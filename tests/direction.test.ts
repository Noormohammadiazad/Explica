import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  folioLabel,
  mirrorSign,
  screenSpread,
  toBookFrame,
  turnForKey,
  turnForScreenSide,
  type ReadingDirection,
} from '../src/book/readingDirection';
import { BookLayout } from '../src/book/bookLayout';
import { ViewController } from '../src/view/viewController';
import { rng } from './helpers';

/** The spread as the app reports it: book-frame left is the verso, book-frame right the recto. */
function spreadOf(b: BookLayout): { verso: number | null; recto: number | null } {
  const s = b.readingSpread();
  return { verso: s.left, recto: s.right };
}

/** Screen x of a book-frame x (the book drawn through the mirror). */
const screenX = (x: number, d: ReadingDirection) => mirrorSign(d) * x;

describe('Right-to-left books', () => {
  it('open with page 1 on the left, and the unread stack on the left', () => {
    const b = new BookLayout(48, 0.15);
    const start = spreadOf(b);
    expect(screenSpread(start, 'ltr')).toEqual({ left: null, right: 0 });
    expect(screenSpread(start, 'rtl')).toEqual({ left: 0, right: null });
    // every sheet starts on the book-frame right stack, which an RTL book shows on the left
    expect(b.restingCount('R')).toBe(b.sheetCount);
    expect(screenX(+1, 'rtl')).toBeLessThan(0);
  });

  it('turn pages from left to right onto the right stack, with mirrored spread numbering', () => {
    const b = new BookLayout(48, 0.15);
    // a forward turn: the top sheet of the unread stack crosses the spine
    const sheet = b.topRight();
    b.liftOff(sheet);
    b.land(sheet, 'L');
    // ... from screen-left to screen-right
    expect(screenX(+1, 'rtl')).toBeLessThan(0);
    expect(screenX(-1, 'rtl')).toBeGreaterThan(0);
    const s = spreadOf(b);
    expect(s).toEqual({ verso: 1, recto: 2 }); // pages 2 and 3, read in that order
    expect(screenSpread(s, 'ltr')).toEqual({ left: 1, right: 2 });
    expect(screenSpread(s, 'rtl')).toEqual({ left: 2, right: 1 }); // page 2 now lies on the right
  });

  it('the folio is written in reading order (an RTL layout mirrors it visually)', () => {
    expect(folioLabel({ verso: 1, recto: 2 }, 48)).toBe('2–3  /  48');
    expect(folioLabel({ verso: null, recto: 0 }, 48)).toBe('1  /  48');
    expect(folioLabel({ verso: 47, recto: null }, 48)).toBe('48  /  48');
  });

  it('mirrors the arrow keys and the pager buttons; reading-order keys stay put', () => {
    expect(turnForKey('ArrowRight', 'ltr')).toBe(1);
    expect(turnForKey('ArrowLeft', 'ltr')).toBe(-1);
    expect(turnForKey('ArrowLeft', 'rtl')).toBe(1);
    expect(turnForKey('ArrowRight', 'rtl')).toBe(-1);
    for (const d of ['ltr', 'rtl'] as const) {
      expect(turnForKey('PageDown', d)).toBe(1);
      expect(turnForKey('ArrowDown', d)).toBe(1);
      expect(turnForKey('PageUp', d)).toBe(-1);
      expect(turnForKey('Enter', d)).toBe(0);
      // the button on each side does what the arrow key for that side does
      expect(turnForScreenSide('left', d)).toBe(turnForKey('ArrowLeft', d));
      expect(turnForScreenSide('right', d)).toBe(turnForKey('ArrowRight', d));
    }
  });

  it('gravity reaches the physics in the mirrored book frame, for any tilt of the book', () => {
    const r = rng(7);
    const g = new THREE.Vector3(0, -9.81, 0);
    for (let n = 0; n < 20; n++) {
      const v = new ViewController();
      v.orbit((r() - 0.5) * 400, (r() - 0.5) * 400, 0);
      v.roll((r() - 0.5) * 2);
      for (let i = 0; i < 400; i++) v.update(1 / 120);
      for (const d of ['ltr', 'rtl'] as const) {
        // reference: invert the whole book-root transform (rotation · base · mirror)
        const root = new THREE.Object3D();
        root.quaternion.copy(v.rot).multiply(ViewController.BASE);
        root.scale.set(mirrorSign(d), 1, 1);
        root.updateMatrixWorld(true);
        const ref = g.clone().transformDirection(root.matrixWorld.clone().invert()).multiplyScalar(9.81);
        const out = toBookFrame(v.gravityInBook([0, 0, 0]), d);
        expect(out[0]).toBeCloseTo(ref.x, 9);
        expect(out[1]).toBeCloseTo(ref.y, 9);
        expect(out[2]).toBeCloseTo(ref.z, 9);
      }
    }
  });
});
