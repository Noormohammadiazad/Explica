import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ViewController } from '../src/view/viewController';
import { rng } from './helpers';

/** Lets the pose springs converge. */
function settle(v: ViewController, seconds = 2): void {
  for (let t = 0; t < seconds; t += 1 / 120) v.update(1 / 120);
}

/** A complete, released drag: the springs settle and no inertia is left over. */
function drag(v: ViewController, dx: number, dy: number): void {
  v.orbit(dx, dy, 0);
  v.endOrbit(10); // long after the last move: no throw
  settle(v);
}

/** World position (or direction) of a book-frame point, posed as `apply()` poses the book root. */
function world(v: ViewController, x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z).applyQuaternion(v.rot.clone().multiply(ViewController.BASE));
}

// camera frame for the default 56° elevation: right, up (on screen) and towards the eye
const E = THREE.MathUtils.degToRad(56);
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, Math.cos(E), -Math.sin(E));
const EYE = new THREE.Vector3(0, Math.sin(E), Math.cos(E));

/** Normal of whichever face of the book is turned towards the reader. */
function visibleNormal(v: ViewController): THREE.Vector3 {
  const n = world(v, 0, 0, 1);
  return n.dot(EYE) >= 0 ? n : n.negate();
}

// book-frame landmarks: spine ends, page edges
const HEAD = [0, 0.1, 0] as const;
const TAIL = [0, -0.1, 0] as const;
const LEFT_EDGE = [-0.14, 0, 0] as const;
const RIGHT_EDGE = [0.14, 0, 0] as const;

describe('Turning the book in the hands (direct manipulation)', () => {
  it('starts lying back: tail towards the reader, right page on the right', () => {
    const v = new ViewController();
    expect(world(v, ...TAIL).z).toBeGreaterThan(0.09);
    expect(world(v, ...RIGHT_EDGE).x).toBeGreaterThan(0.13);
  });

  it('a horizontal drag turns the book about its spine: the face swings with the hand', () => {
    const v = new ViewController();
    const head0 = world(v, ...HEAD);
    const tail0 = world(v, ...TAIL);
    drag(v, 60, 0);
    // the spine is the axis: it does not move
    expect(world(v, ...HEAD).distanceTo(head0)).toBeLessThan(1e-12);
    expect(world(v, ...TAIL).distanceTo(tail0)).toBeLessThan(1e-12);
    // the face turns right: left page comes towards the reader, right page goes back
    expect(visibleNormal(v).x).toBeGreaterThan(0.25);
    expect(world(v, ...LEFT_EDGE).dot(EYE)).toBeGreaterThan(0.03);
    expect(world(v, ...RIGHT_EDGE).dot(EYE)).toBeLessThan(-0.03);
    // and back again
    drag(v, -120, 0);
    expect(visibleNormal(v).x).toBeLessThan(-0.25);
  });

  it('a vertical drag tilts the face with the hand: dragging down lifts the head towards the reader', () => {
    const v = new ViewController();
    const n0 = visibleNormal(v);
    drag(v, 0, 60);
    expect(world(v, ...HEAD).y).toBeGreaterThan(0.02);
    expect(world(v, ...TAIL).y).toBeLessThan(-0.02);
    const n1 = visibleNormal(v);
    expect(n1.dot(UP)).toBeLessThan(n0.dot(UP) - 0.2); // the face swung down on screen…
    expect(n1.dot(EYE)).toBeGreaterThan(n0.dot(EYE)); // …towards the reader
    expect(n1.x).toBeCloseTo(0, 12); // no sideways component
  });

  it('turns and tilts never roll the spine off the screen vertical (no trackball drift)', () => {
    const v = new ViewController();
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * 4 * Math.PI; // two loops of a circling drag
      v.orbit(14 * Math.cos(a), 14 * Math.sin(a), k / 60);
      v.update(1 / 60);
    }
    v.endOrbit(100);
    settle(v);
    const spine = world(v, ...HEAD).sub(world(v, ...TAIL));
    expect(Math.abs(spine.dot(RIGHT))).toBeLessThan(1e-12);
  });

  it('a small drag in any direction swings the visible face that way, in every pose facing the reader', () => {
    // Turn and tilt alone always follow the hand, in every pose (the direct terms are
    // |cos turn| and |cos turn|·sin(tilt + 56°)). Turning about an inclined spine also
    // swings the face slightly up or down (∝ sin turn), which can outweigh a diagonal drag
    // only once the book is turned nearly edge-on; while the visible face is within ~72°
    // of the reader (|n·eye| ≥ 0.3) every direction is guaranteed.
    const r = rng(11);
    let checked = 0;
    for (let n = 0; n < 300; n++) {
      const twist = (r() - 0.5) * 2 * Math.PI;
      const ex = (r() - 0.5) * 1400; // turn, in the un-twisted frame (up to ±210°)
      const ey = -100 + r() * 360; // tilt, inside its range
      const c = Math.cos(-twist);
      const s = Math.sin(-twist);
      const pose = (): ViewController => {
        const v = new ViewController();
        v.roll(twist); // clockwise by `twist`
        settle(v, 1);
        drag(v, c * ex + s * ey, -s * ex + c * ey); // the same turn and tilt, expressed on screen
        return v;
      };
      if (Math.abs(world(pose(), 0, 0, 1).dot(EYE)) < 0.3) continue;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * 2 * Math.PI;
        const dx = 2 * Math.cos(a);
        const dy = 2 * Math.sin(a);
        const v = pose();
        const before = visibleNormal(v);
        drag(v, dx, dy);
        const after = visibleNormal(v);
        // the screen direction of the drag, in world space (screen y points down)
        const dir = RIGHT.clone().multiplyScalar(dx).addScaledVector(UP, -dy).normalize();
        expect(after.sub(before).dot(dir)).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('pure horizontal and vertical drags follow the hand even with the book turned near edge-on', () => {
    for (const turnDeg of [-85, -60, 0, 60, 85, 120, 175]) {
      for (const tiltDeg of [-30, 0, 34, 80]) {
        for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
          const v = new ViewController();
          drag(v, (THREE.MathUtils.degToRad(turnDeg) / 0.0052) | 0, (THREE.MathUtils.degToRad(tiltDeg) / 0.0052) | 0);
          const before = visibleNormal(v);
          drag(v, dx, dy);
          const dir = RIGHT.clone().multiplyScalar(dx).addScaledVector(UP, -dy).normalize();
          expect(visibleNormal(v).sub(before).dot(dir)).toBeGreaterThan(0);
        }
      }
    }
  });

  it('a clockwise two-finger twist turns the book clockwise, with the fingers', () => {
    const v = new ViewController();
    v.roll(0.3); // screen coordinates (y down): positive = clockwise
    settle(v);
    expect(world(v, ...RIGHT_EDGE).dot(UP)).toBeLessThan(-0.01); // the right edge dips on screen
    expect(world(v, ...HEAD).dot(RIGHT)).toBeGreaterThan(0.01); // the head leans right
  });

  it('after a quarter twist, a horizontal drag still swings the face horizontally', () => {
    const v = new ViewController();
    v.roll(Math.PI / 2); // head now points to the right of the screen
    settle(v);
    drag(v, 60, 0);
    const n = visibleNormal(v);
    expect(n.dot(RIGHT)).toBeGreaterThan(0.25);
    // with the spine lying across the screen, that swing is a tilt about the book's width
    expect(Math.abs(v.turn)).toBeLessThan(1e-9);
  });

  it('released turns keep going the same way, and slow to rest', () => {
    const v = new ViewController();
    for (let i = 0; i < 5; i++) v.orbit(12, 0, i / 60);
    v.endOrbit(5 / 60);
    settle(v, 0.05);
    const a = v.turn;
    settle(v, 0.3);
    const b = v.turn;
    settle(v, 3);
    expect(b).toBeGreaterThan(a);
    expect(v.turn).toBeGreaterThan(b);
    expect(v.update(1 / 60)).toBe(false); // came to rest
  });

  it('tilt stops at the ends of its range, before the spine would point at the eye', () => {
    const v = new ViewController();
    drag(v, 0, 5000);
    expect(THREE.MathUtils.radToDeg(v.tilt)).toBeCloseTo(85, 6);
    drag(v, 0, -9000);
    expect(THREE.MathUtils.radToDeg(v.tilt)).toBeCloseTo(-32, 6);
    const spine = world(v, ...HEAD).sub(world(v, ...TAIL)).normalize();
    expect(Math.abs(spine.dot(EYE))).toBeLessThan(Math.cos(THREE.MathUtils.degToRad(20)));
  });

  it('reset takes the short way home after many turns', () => {
    const v = new ViewController();
    drag(v, ((6 * Math.PI + 0.3) / 0.0052) | 0, 0);
    v.reset(true);
    let worst = 0;
    for (let t = 0; t < 2; t += 1 / 120) {
      v.update(1 / 120);
      worst = Math.max(worst, Math.abs(v.turn));
    }
    expect(worst).toBeLessThan(0.31);
    expect(v.rot.angleTo(new THREE.Quaternion())).toBeLessThan(1e-4);
  });

  it('panning still follows the hand', () => {
    const camera = new THREE.PerspectiveCamera(30, 1.5, 0.02, 30);
    const v = new ViewController();
    v.frame(0.3, 0.21, camera);
    const t0 = v.target.clone();
    v.pan(40, 0, camera, 800, 0);
    v.endPan(10); // stale: no glide
    settle(v);
    // the eye moves left, so the book moves right with the drag
    expect(v.target.x - t0.x).toBeLessThan(-0.001);
    const t1 = v.target.clone();
    v.pan(0, 40, camera, 800, 20);
    v.endPan(30);
    settle(v);
    // dragging down moves the eye up (screen-up is (0, cos e, −sin e)), so the book moves down
    expect(v.target.y - t1.y).toBeGreaterThan(0.001);
  });

  it('portrait framing centres the page read next: right for LTR, left for RTL', () => {
    const camera = new THREE.PerspectiveCamera(30, 0.5, 0.02, 30);
    const v = new ViewController();
    v.frame(0.3, 0.21, camera, false, 1);
    expect(v.target.x).toBeCloseTo(0.075, 9);
    v.frame(0.3, 0.21, camera, false, -1);
    expect(v.target.x).toBeCloseTo(-0.075, 9);
  });
});
