import { ArcDragSurface, type Vec3 } from '../input/dragSurface';

/**
 * A virtual hand that turns a page by itself (keyboard, tap, buttons):
 * it grabs near the lower outer corner and sweeps along the same drag surface
 * a human drag would use, with an ease-in-out profile, then lets go. The page
 * shape is entirely produced by the physics.
 */
export class AutoTurn {
  private t = 0;
  readonly surface: ArcDragSurface;

  constructor(
    grabRest: Vec3,
    zFar: number,
    readonly duration: number,
  ) {
    this.surface = ArcDragSurface.forGrab(grabRest[0], grabRest[2], zFar);
    this.y = grabRest[1];
  }

  private readonly y: number;

  get done(): boolean {
    return this.t >= this.duration;
  }

  /** Advances time and returns the hand target and velocity. */
  advance(dt: number): { target: Vec3; velocity: Vec3 } {
    const t0 = this.t;
    this.t = Math.min(this.duration, this.t + dt);
    const a = this.sample(t0);
    const b = this.sample(this.t);
    const inv = dt > 0 ? 1 / dt : 0;
    return { target: b, velocity: [(b[0] - a[0]) * inv, (b[1] - a[1]) * inv, (b[2] - a[2]) * inv] };
  }

  private sample(t: number): Vec3 {
    const u = Math.min(1, t / this.duration);
    // ease-in-out (smootherstep), finishing slightly past the mirrored point
    const s = u * u * u * (u * (u * 6 - 15) + 10);
    const lift = Math.sin(Math.PI * u) * 0.015;
    const p = this.surface.pointAt(s * 0.96, this.y + lift);
    return p;
  }
}

/** Material grab point used for automatic turns (lower outer region). */
export const AUTO_GRAB = { uFrac: 0.94, vFrac: -0.36 };
