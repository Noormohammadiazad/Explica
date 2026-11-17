import * as THREE from 'three';

const TAU_POSE = 0.055; // s: how tightly the pose follows its target (spring)
const TAU_SPIN = 0.28; // s: rotational inertia decay
const TAU_GLIDE = 0.32; // s: pan inertia decay
const ROT_PER_PX = 0.0052; // rad per CSS pixel
const MAX_SPIN = 4.5; // rad/s
/**
 * Tilt range, from the resting pose (lying back, seen from 56° above).
 * +34° holds the book upright facing the reader; the limits stop before the
 * spine would point along the line of sight, where turning about it would
 * degenerate into a spin on screen.
 */
const TILT_MIN = THREE.MathUtils.degToRad(-32);
const TILT_MAX = THREE.MathUtils.degToRad(85);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const TMP_Q = new THREE.Quaternion();

/** Exponential-smoothing gain for time constant τ over dt (frame-rate independent). */
function gain(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau);
}

/**
 * The book as an object held in the hands: 6-DoF pose (turn, tilt, twist,
 * pan, dolly) driven by critically damped springs towards a target pose, with
 * release velocities carried into exponentially decaying inertia.
 *
 * The camera looks at a pan target along a fixed direction; rotations are
 * applied to the book, so lights stay put and highlights travel across the
 * paper as it is tilted.
 *
 * Rotation is direct manipulation: the face of the book turned towards the
 * reader swings with the hand, like turning a real book. The axes are the
 * ones hands use:
 *
 *  - **turn** (horizontal drag) about the book's own spine. Drag right and
 *    the face swings right: the left page comes towards you, the right page
 *    goes back. Keep turning and the book rolls over onto its back cover.
 *  - **tilt** (vertical drag) about the screen's horizontal axis. Drag down
 *    and the face swings down towards you: the head of the book rises, as
 *    when lifting a book up to read.
 *  - **twist** (two-finger rotation) about the line of sight, with the
 *    fingers.
 *
 * The pose is R = R_sight(twist) · R_screen-x(tilt) · R_spine(turn), so turn
 * and tilt never move the spine out of the screen's vertical plane. Circling
 * drags cannot roll the book sideways (a free trackball drifts that way).
 * Drags are read in the un-twisted frame, so after a twist the face still
 * follows the hand. In every reachable pose a drag moves the visible face's
 * normal towards the drag direction on screen (tests/view.test.ts checks
 * this for random poses).
 */
export class ViewController {
  /** Book frame → world, before user rotation: the book lies on its back. */
  static readonly BASE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

  /** World rotation of the book (applied before BASE). Derived from turn, tilt and twist. */
  readonly rot = new THREE.Quaternion();
  /** Turn about the spine [rad]; + swings the face to the right. */
  turn = 0;
  /** Tilt about the screen's horizontal axis [rad]; + swings the face down, towards the reader. */
  tilt = 0;
  /** Twist about the line of sight [rad]; + is counter-clockwise on screen. */
  twist = 0;
  private turnGoal = 0;
  private tiltGoal = 0;
  private twistGoal = 0;
  private readonly spin = new THREE.Vector2(); // (turn, tilt) rates [rad/s]
  readonly target = new THREE.Vector3();
  private readonly targetGoal = new THREE.Vector3();
  private readonly glide = new THREE.Vector3(); // pan velocity [m/s]
  dist = 1;
  private distGoal = 1;
  private readonly viewDir: THREE.Vector3;
  private homeDist = 1;
  private homeTarget = new THREE.Vector3();
  private dragging = false;
  private lastMove = 0;
  private readonly velEstimate = new THREE.Vector3();
  private readonly panEstimate = new THREE.Vector3();
  minDist = 0.06;
  maxDist = 3;

  constructor(elevationDeg = 56) {
    const e = THREE.MathUtils.degToRad(elevationDeg);
    this.viewDir = new THREE.Vector3(0, Math.sin(e), Math.cos(e));
  }

  /**
   * Frames a book of the given open width/height (metres). On portrait screens
   * one page is framed on its own, like a phone reading app: the right-hand
   * page (`readingSide` = 1), or the left-hand one for right-to-left books (−1).
   */
  frame(openWidth: number, height: number, camera: THREE.PerspectiveCamera, animate = false, readingSide: 1 | -1 = 1): void {
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const portrait = camera.aspect < 0.8;
    const width = portrait ? openWidth / 2 + 0.01 : openWidth;
    const dW = width / 2 / Math.tan(hfov / 2);
    const dH = (height * 0.92) / 2 / Math.tan(vfov / 2);
    this.homeDist = Math.max(dW, dH) * (portrait ? 1.12 : 1.3);
    this.homeTarget.set(portrait ? (readingSide * openWidth) / 4 : 0, -0.004, 0.012);
    this.maxDist = this.homeDist * 4;
    this.minDist = Math.min(0.05, this.homeDist * 0.1);
    this.reset(animate);
  }

  reset(animate = true): void {
    this.dragging = false;
    // unwind whole turns first (same pose) so the way home is the short one
    const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
    this.turn = wrap(this.turn);
    this.twist = wrap(this.twist);
    this.turnGoal = this.tiltGoal = this.twistGoal = 0;
    this.spin.set(0, 0);
    this.glide.set(0, 0, 0);
    this.targetGoal.copy(this.homeTarget);
    this.distGoal = this.homeDist;
    if (!animate) {
      this.turn = this.tilt = this.twist = 0;
      this.compose();
      this.target.copy(this.homeTarget);
      this.dist = this.homeDist;
    }
  }

  get homeDistance(): number {
    return this.homeDist;
  }

  /** World-space metres per CSS pixel at the pan target. */
  private metresPerPx(camera: THREE.PerspectiveCamera, viewportCssHeight: number): number {
    return (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewportCssHeight;
  }

  // ---------------------------------------------------------------- gestures

  beginDrag(): void {
    this.dragging = true;
    this.spin.set(0, 0);
    this.glide.set(0, 0, 0);
    this.velEstimate.set(0, 0, 0);
    this.panEstimate.set(0, 0, 0);
  }

  /** Turns (horizontal) and tilts (vertical) the book for a drag of (dx, dy) CSS pixels, y down. */
  orbit(dxPx: number, dyPx: number, now: number): void {
    if (!this.dragging) this.beginDrag();
    // the drag in the book's un-twisted screen frame
    const c = Math.cos(this.twist);
    const s = Math.sin(this.twist);
    const ex = c * dxPx - s * dyPx;
    const ey = s * dxPx + c * dyPx;
    const dTurn = ex * ROT_PER_PX;
    const t0 = this.tiltGoal;
    this.turnGoal += dTurn;
    this.tiltGoal = THREE.MathUtils.clamp(t0 + ey * ROT_PER_PX, TILT_MIN, TILT_MAX);
    this.trackVelocity(this.velEstimate, new THREE.Vector3(dTurn, this.tiltGoal - t0, 0), now);
  }

  /**
   * Twists the book about the line of sight with the fingers, for a two-finger
   * rotation of `angle` radians in screen coordinates (positive = clockwise).
   */
  roll(angle: number): void {
    this.twistGoal -= angle;
  }

  endOrbit(now: number): void {
    this.dragging = false;
    if (now - this.lastMove > 0.09) return; // the hand had stopped
    this.spin.set(this.velEstimate.x, this.velEstimate.y);
    if (this.spin.length() > MAX_SPIN) this.spin.setLength(MAX_SPIN);
  }

  pan(dxPx: number, dyPx: number, camera: THREE.PerspectiveCamera, cssH: number, now: number): void {
    if (!this.dragging) this.beginDrag();
    const d = this.panBy(dxPx, dyPx, camera, cssH);
    this.trackVelocity(this.panEstimate, d, now);
  }

  /** Moves the pan target by a screen-space offset (no inertia). Returns the world offset. */
  panBy(dxPx: number, dyPx: number, camera: THREE.PerspectiveCamera, cssH: number): THREE.Vector3 {
    const k = this.metresPerPx(camera, cssH);
    const right = this.cameraRight();
    const up = new THREE.Vector3().crossVectors(right, this.viewDir).negate();
    const d = right.multiplyScalar(-dxPx * k).add(up.multiplyScalar(dyPx * k));
    this.targetGoal.add(d);
    this.clampTarget();
    return d;
  }

  endPan(now: number): void {
    this.dragging = false;
    if (now - this.lastMove > 0.09) return;
    this.glide.copy(this.panEstimate);
  }

  /**
   * Dollies by `factor` (> 1 zooms in) keeping the world point `anchor`
   * fixed on screen.
   */
  zoomAt(factor: number, anchor: THREE.Vector3 | null): void {
    const d0 = this.distGoal;
    const d1 = THREE.MathUtils.clamp(d0 / factor, this.minDist, this.maxDist);
    if (anchor) {
      // T' = P + (T − P)·d'/d keeps P's projection fixed
      this.targetGoal.sub(anchor).multiplyScalar(d1 / d0).add(anchor);
      this.clampTarget();
    }
    this.distGoal = d1;
  }

  // ---------------------------------------------------------------- integration

  /** Advances springs and inertia. Returns true while anything is still moving. */
  update(dt: number): boolean {
    if (!this.dragging) {
      if (this.spin.lengthSq() > 1e-6) {
        this.turnGoal += this.spin.x * dt;
        const p = this.tiltGoal + this.spin.y * dt;
        this.tiltGoal = THREE.MathUtils.clamp(p, TILT_MIN, TILT_MAX);
        if (this.tiltGoal !== p) this.spin.y = 0; // ran into the end of the tilt range
        this.spin.multiplyScalar(Math.exp(-dt / TAU_SPIN));
      } else this.spin.set(0, 0);
      if (this.glide.lengthSq() > 1e-10) {
        this.targetGoal.addScaledVector(this.glide, dt);
        this.clampTarget();
        this.glide.multiplyScalar(Math.exp(-dt / TAU_GLIDE));
      } else this.glide.set(0, 0, 0);
    }
    const a = gain(dt, TAU_POSE);
    this.turn += (this.turnGoal - this.turn) * a;
    this.tilt += (this.tiltGoal - this.tilt) * a;
    this.twist += (this.twistGoal - this.twist) * a;
    this.compose();
    this.target.lerp(this.targetGoal, a);
    this.dist += (this.distGoal - this.dist) * a;
    const moving =
      this.spin.lengthSq() > 0 ||
      this.glide.lengthSq() > 0 ||
      Math.abs(this.turnGoal - this.turn) > 1e-4 ||
      Math.abs(this.tiltGoal - this.tilt) > 1e-4 ||
      Math.abs(this.twistGoal - this.twist) > 1e-4 ||
      this.target.distanceToSquared(this.targetGoal) > 1e-10 ||
      Math.abs(this.distGoal - this.dist) > 1e-5;
    return moving;
  }

  /** Writes the pose into the camera and the book root. */
  apply(camera: THREE.PerspectiveCamera, bookRoot: THREE.Object3D): void {
    camera.position.copy(this.target).addScaledVector(this.viewDir, this.dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.target);
    bookRoot.quaternion.copy(this.rot).multiply(ViewController.BASE);
    bookRoot.updateMatrixWorld(true);
  }

  /** Gravity expressed in the book frame. */
  gravityInBook(out: [number, number, number]): [number, number, number] {
    const q = this.rot.clone().multiply(ViewController.BASE).invert();
    const g = new THREE.Vector3(0, -9.81, 0).applyQuaternion(q);
    out[0] = g.x;
    out[1] = g.y;
    out[2] = g.z;
    return out;
  }

  // ---------------------------------------------------------------- helpers

  private cameraRight(): THREE.Vector3 {
    return new THREE.Vector3(0, 1, 0).cross(this.viewDir).normalize();
  }

  /**
   * rot = R_sight(twist) · R_x(tilt) · R_z(−turn). With BASE (the book lying
   * on its back, head pointing away) R_z(−turn)·BASE = BASE·R_spine(turn): the
   * turn is about the book's own spine, its local +y axis.
   */
  private compose(): void {
    const q = this.rot.setFromAxisAngle(this.viewDir, this.twist);
    q.multiply(TMP_Q.setFromAxisAngle(X_AXIS, this.tilt));
    q.multiply(TMP_Q.setFromAxisAngle(Z_AXIS, -this.turn));
  }

  private trackVelocity(est: THREE.Vector3, delta: THREE.Vector3, now: number): void {
    const dt = Math.max(1 / 240, Math.min(0.1, now - this.lastMove));
    this.lastMove = now;
    const inst = delta.clone().divideScalar(dt);
    est.lerp(inst, 0.45);
  }

  private clampTarget(): void {
    const lim = 0.6;
    this.targetGoal.clampScalar(-lim, lim);
  }
}
