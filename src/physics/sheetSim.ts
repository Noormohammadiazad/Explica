import { HingeChain } from './hingeChain';
import { choleskySolve } from './linalg';
import { hingeStiffness } from './bending';
import { surfaceHeight, surfaceSlope, type StackSurface } from './surface';
import type { PaperParams, SheetDims } from './params';

/** Where the sheet lives: gravity and the two stack surfaces, in the book frame. */
export interface SheetEnvironment {
  /** Gravitational acceleration in the book frame [m/s²]. */
  gravity: [number, number, number];
  /** Height of the binding pivot (spine axis). */
  pivotZ: number;
  /** Surface under the sheet when it lies on the right (x > 0). */
  right: StackSurface;
  /** Surface under the sheet when it lies on the left (x < 0). */
  left: StackSurface;
}

/** A hand holding a material point of the sheet. */
export interface Hand {
  /** Material coordinates of the grabbed point. */
  u: number;
  v: number;
  /** Target position (book frame) at the end of the current step. */
  target: [number, number, number];
  /** Target velocity (book frame). */
  velocity: [number, number, number];
  /** Stiffness multiplier (1 = default grip). */
  strength: number;
}

export interface SimStats {
  iterations: number;
  kinetic: number;
  maxSpeed: number;
  activeContacts: number;
}

const P_EPS = 1e-6;

/**
 * One sheet of paper as a reduced-coordinate multibody of rigid strips,
 * integrated with implicit Euler written as an incremental potential and
 * minimised by Gauss–Newton with a backtracking line search.
 *
 * Generalised coordinates: q = (p, ψ_0, …, ψ_{K−1}).
 */
export class SheetSim {
  readonly K: number;
  readonly n: number;
  readonly delta: number;
  readonly chain: HingeChain;
  private readonly chainP: HingeChain;
  private readonly chainM: HingeChain;

  readonly q: Float64Array;
  readonly qd: Float64Array;

  params: PaperParams;
  env: SheetEnvironment;
  hand: Hand | null = null;
  /** Multiplier on aerodynamic drag. */
  airScale = 1;
  /** Gauss–Newton iterations per step. */
  maxIterations = 3;

  readonly stats: SimStats = { iterations: 0, kinetic: 0, maxSpeed: 0, activeContacts: 0 };

  // --- material sample points
  private readonly nMass: number;
  private readonly mu: Float64Array;
  private readonly mv: Float64Array;
  private readonly nCon: number;
  private readonly cu: Float64Array;
  private readonly cv: Float64Array;

  // --- per-step state
  private readonly qN: Float64Array;
  private readonly XN: Float64Array; // mass points at step start
  private readonly Xt: Float64Array; // predicted (inertial) positions
  private readonly cAir: Float64Array; // drag coefficient per mass point
  private readonly nN: Float64Array; // strip normals at step start
  private readonly XcN: Float64Array; // contact points at step start
  private readonly phiN: Float64Array; // contact gaps at step start
  private readonly fricOn: Uint8Array;
  private readonly XhN = new Float64Array(3);
  private readonly ckN: Float64Array; // hinge stiffness at step start (for damping)

  // --- per-iteration scratch
  private readonly X: Float64Array;
  private readonly sM: Int32Array;
  private readonly Xc: Float64Array;
  private readonly sC: Int32Array;
  private readonly Xh = new Float64Array(3);
  private readonly G: Float64Array; // 6×6 per strip
  private readonly F: Float64Array; // 6 per strip
  private readonly Gs: Float64Array; // suffix sums
  private readonly Fs: Float64Array;
  private readonly xiH: Float64Array; // hinge twists (6 per hinge)
  private readonly xiP: Float64Array; // p twists (6 per strip)
  private readonly Wp: Float64Array; // suffix sums of G_s·ξ^p_s
  private readonly Hm: Float64Array;
  private readonly g: Float64Array;
  private readonly dq: Float64Array;
  private readonly L: Float64Array;
  private readonly qTry: Float64Array;
  private readonly ck: Float64Array;
  private readonly ckd: Float64Array;
  private readonly ckPlus: Float64Array;
  private readonly tmp6 = new Float64Array(6);

  // --- derived constants
  private mPt = 0;
  private aPt = 0;
  private mSheet = 0;

  constructor(
    readonly dims: SheetDims,
    params: PaperParams,
    env: SheetEnvironment,
    K = 24,
    massGrid: [number, number] = [2 * K, 10],
  ) {
    this.K = K;
    this.n = K + 1;
    this.delta = dims.W / (K - 1);
    this.params = params;
    this.env = env;
    const nb = K - 1;
    this.chain = new HingeChain(dims.W, dims.H, nb, this.delta);
    this.chainP = new HingeChain(dims.W, dims.H, nb, this.delta);
    this.chainM = new HingeChain(dims.W, dims.H, nb, this.delta);
    this.q = new Float64Array(this.n);
    this.qd = new Float64Array(this.n);
    this.qN = new Float64Array(this.n);
    this.qTry = new Float64Array(this.n);

    // mass quadrature: cell-centred grid
    const [nu, nv] = massGrid;
    this.nMass = nu * nv;
    this.mu = new Float64Array(this.nMass);
    this.mv = new Float64Array(this.nMass);
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        this.mu[i * nv + j] = ((i + 0.5) / nu) * dims.W;
        this.mv[i * nv + j] = ((j + 0.5) / nv - 0.5) * dims.H;
      }
    }
    // contact samples: on every bending hinge line + fore-edge, 5 rows
    const rows = [-0.5, -0.25, 0, 0.25, 0.5];
    this.nCon = K * rows.length;
    this.cu = new Float64Array(this.nCon);
    this.cv = new Float64Array(this.nCon);
    for (let k = 1; k <= K; k++) {
      const u = k === K ? dims.W : (k - 0.5) * this.delta;
      for (let r = 0; r < rows.length; r++) {
        const idx = (k - 1) * rows.length + r;
        this.cu[idx] = u;
        this.cv[idx] = rows[r] * dims.H;
      }
    }

    const nS = K;
    this.XN = new Float64Array(3 * this.nMass);
    this.Xt = new Float64Array(3 * this.nMass);
    this.X = new Float64Array(3 * this.nMass);
    this.sM = new Int32Array(this.nMass);
    this.cAir = new Float64Array(this.nMass);
    this.nN = new Float64Array(3 * nS);
    this.XcN = new Float64Array(3 * this.nCon);
    this.Xc = new Float64Array(3 * this.nCon);
    this.sC = new Int32Array(this.nCon);
    this.phiN = new Float64Array(this.nCon);
    this.fricOn = new Uint8Array(this.nCon);
    this.G = new Float64Array(36 * nS);
    this.F = new Float64Array(6 * nS);
    this.Gs = new Float64Array(36 * nS);
    this.Fs = new Float64Array(6 * nS);
    this.xiH = new Float64Array(6 * nS);
    this.xiP = new Float64Array(6 * nS);
    this.Wp = new Float64Array(6 * nS);
    this.Hm = new Float64Array(this.n * this.n);
    this.g = new Float64Array(this.n);
    this.dq = new Float64Array(this.n);
    this.L = new Float64Array(this.n * this.n);
    this.ck = new Float64Array(K);
    this.ckd = new Float64Array(K);
    this.ckPlus = new Float64Array(K);
    this.ckN = new Float64Array(K);
    this.setParams(params);
  }

  setParams(params: PaperParams): void {
    this.params = params;
    this.mSheet = params.arealDensity * this.dims.W * this.dims.H;
    this.mPt = this.mSheet / this.nMass;
    this.aPt = (this.dims.W * this.dims.H) / this.nMass;
  }

  get sheetMass(): number {
    return this.mSheet;
  }

  /** Sets the configuration and zeroes velocities. */
  setState(q: ArrayLike<number>, qd?: ArrayLike<number>): void {
    this.q.set(q);
    if (qd) this.qd.set(qd);
    else this.qd.fill(0);
    this.chain.update(this.q[0], this.q.subarray(1), this.env.pivotZ);
  }

  // ------------------------------------------------------------------ kinematics

  /** Updates strip transforms (and twists if requested) for configuration q. */
  private kinematics(q: Float64Array, twists: boolean): void {
    const pz = this.env.pivotZ;
    const angles = q.subarray(1);
    this.chain.update(q[0], angles, pz);
    if (!twists) return;
    this.chainP.update(q[0] + P_EPS, angles, pz);
    this.chainM.update(q[0] - P_EPS, angles, pz);
    const { chain, chainP, chainM, xiH, xiP } = this;
    const nS = this.K;
    for (let j = 0; j < nS; j++) {
      // hinge twist (ω, v = c × ω)
      const o = 3 * j;
      const wx = chain.axis[o];
      const wy = chain.axis[o + 1];
      const wz = chain.axis[o + 2];
      const cx = chain.axisPoint[o];
      const cy = chain.axisPoint[o + 1];
      const cz = chain.axisPoint[o + 2];
      const x6 = 6 * j;
      xiH[x6] = wx;
      xiH[x6 + 1] = wy;
      xiH[x6 + 2] = wz;
      xiH[x6 + 3] = cy * wz - cz * wy;
      xiH[x6 + 4] = cz * wx - cx * wz;
      xiH[x6 + 5] = cx * wy - cy * wx;
      // p twist of strip j via central differences: Ω = dR·Rᵀ, v = dt − ω × t
      const r = 9 * j;
      const R = chain.R;
      const inv = 1 / (2 * P_EPS);
      let O01 = 0;
      let O02 = 0;
      let O10 = 0;
      let O12 = 0;
      let O20 = 0;
      let O21 = 0;
      for (let k = 0; k < 3; k++) {
        const d0 = (chainP.R[r + k] - chainM.R[r + k]) * inv;
        const d1 = (chainP.R[r + 3 + k] - chainM.R[r + 3 + k]) * inv;
        const d2 = (chainP.R[r + 6 + k] - chainM.R[r + 6 + k]) * inv;
        // Ω_ab = Σ_k dR_ak R_bk
        O01 += d0 * R[r + 3 + k];
        O02 += d0 * R[r + 6 + k];
        O10 += d1 * R[r + k];
        O12 += d1 * R[r + 6 + k];
        O20 += d2 * R[r + k];
        O21 += d2 * R[r + 3 + k];
      }
      const ox = 0.5 * (O21 - O12);
      const oy = 0.5 * (O02 - O20);
      const oz = 0.5 * (O10 - O01);
      const tx = chain.t[o];
      const ty = chain.t[o + 1];
      const tz = chain.t[o + 2];
      const dtx = (chainP.t[o] - chainM.t[o]) * inv;
      const dty = (chainP.t[o + 1] - chainM.t[o + 1]) * inv;
      const dtz = (chainP.t[o + 2] - chainM.t[o + 2]) * inv;
      xiP[x6] = ox;
      xiP[x6 + 1] = oy;
      xiP[x6 + 2] = oz;
      xiP[x6 + 3] = dtx - (oy * tz - oz * ty);
      xiP[x6 + 4] = dty - (oz * tx - ox * tz);
      xiP[x6 + 5] = dtz - (ox * ty - oy * tx);
    }
  }

  private gatherPoints(): void {
    const { chain, mu, mv, X, sM, cu, cv, Xc, sC } = this;
    for (let i = 0; i < this.nMass; i++) sM[i] = chain.point(mu[i], mv[i], X, 3 * i);
    for (let i = 0; i < this.nCon; i++) sC[i] = chain.point(cu[i], cv[i], Xc, 3 * i);
    if (this.hand) chain.point(this.hand.u, this.hand.v, this.Xh, 0);
  }

  private stiffnessAt(p: number, out: Float64Array): void {
    const { W, H } = this.dims;
    const D = this.params.flexuralRigidity;
    out[0] = 0;
    for (let k = 1; k < this.K; k++) out[k] = hingeStiffness(k, p, W, H, this.delta, D);
  }

  // ------------------------------------------------------------------ constants

  private get handK(): number {
    const h = this.hand;
    const m = this.mSheet / 3;
    return m * this.params.handOmega ** 2 * (h ? h.strength : 1);
  }
  private get handC(): number {
    const h = this.hand;
    const m = this.mSheet / 3;
    return 2 * this.params.handZeta * m * this.params.handOmega * (h ? Math.sqrt(h.strength) : 1);
  }
  private get contactK(): number {
    return (this.mSheet / this.nCon) * this.params.contactOmega ** 2 * 3;
  }
  private get contactC(): number {
    return 2 * this.params.contactZeta * (this.mSheet / this.nCon) * this.params.contactOmega * 3;
  }
  private get frictionC(): number {
    return 2 * this.params.contactFriction * (this.mSheet / this.nCon) * this.params.contactOmega;
  }
  private get pMax(): number {
    return 1.6 / this.dims.H;
  }

  private surfaceFor(x: number): StackSurface {
    return x >= 0 ? this.env.right : this.env.left;
  }

  // ------------------------------------------------------------------ step

  /** Advances the sheet by one implicit Euler step of length h. */
  step(h: number): void {
    const { q, qd, qN, X, Xt, XN, cAir, nN, chain } = this;
    qN.set(q);
    this.kinematics(q, true);
    this.gatherPoints();
    this.stiffnessAt(q[0], this.ckN);

    // per-strip spatial velocity twist (cumulative)
    const nS = this.K;
    const vel = this.Gs; // reuse as scratch: 6 per strip
    let wx = 0;
    let wy = 0;
    let wz = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    const pd = qd[0];
    for (let s = 0; s < nS; s++) {
      const x6 = 6 * s;
      const a = qd[1 + s];
      wx += this.xiH[x6] * a;
      wy += this.xiH[x6 + 1] * a;
      wz += this.xiH[x6 + 2] * a;
      vx += this.xiH[x6 + 3] * a;
      vy += this.xiH[x6 + 4] * a;
      vz += this.xiH[x6 + 5] * a;
      vel[x6] = wx + this.xiP[x6] * pd;
      vel[x6 + 1] = wy + this.xiP[x6 + 1] * pd;
      vel[x6 + 2] = wz + this.xiP[x6 + 2] * pd;
      vel[x6 + 3] = vx + this.xiP[x6 + 3] * pd;
      vel[x6 + 4] = vy + this.xiP[x6 + 4] * pd;
      vel[x6 + 5] = vz + this.xiP[x6 + 5] * pd;
      const r = 9 * s;
      nN[3 * s] = chain.R[r + 2];
      nN[3 * s + 1] = chain.R[r + 5];
      nN[3 * s + 2] = chain.R[r + 8];
    }
    const pa = this.params;
    const air = this.airScale;
    let kin = 0;
    let vmax = 0;
    for (let i = 0; i < this.nMass; i++) {
      const s = this.sM[i];
      const o = 3 * i;
      const x6 = 6 * s;
      const px = X[o];
      const py = X[o + 1];
      const pz = X[o + 2];
      const ux = vel[x6 + 1] * pz - vel[x6 + 2] * py + vel[x6 + 3];
      const uy = vel[x6 + 2] * px - vel[x6] * pz + vel[x6 + 4];
      const uz = vel[x6] * py - vel[x6 + 1] * px + vel[x6 + 5];
      XN[o] = px;
      XN[o + 1] = py;
      XN[o + 2] = pz;
      Xt[o] = px + h * ux;
      Xt[o + 1] = py + h * uy;
      Xt[o + 2] = pz + h * uz;
      const vn = Math.abs(ux * nN[3 * s] + uy * nN[3 * s + 1] + uz * nN[3 * s + 2]);
      cAir[i] = air * this.aPt * (0.5 * pa.airDensity * pa.dragCoefficient * vn + pa.airLinear);
      const sp2 = ux * ux + uy * uy + uz * uz;
      kin += 0.5 * this.mPt * sp2;
      if (sp2 > vmax) vmax = sp2;
    }
    this.stats.kinetic = kin;
    this.stats.maxSpeed = Math.sqrt(vmax);

    let active = 0;
    for (let i = 0; i < this.nCon; i++) {
      const o = 3 * i;
      this.XcN[o] = this.Xc[o];
      this.XcN[o + 1] = this.Xc[o + 1];
      this.XcN[o + 2] = this.Xc[o + 2];
      const phi = this.Xc[o + 2] - surfaceHeight(this.surfaceFor(this.Xc[o]), this.Xc[o]);
      this.phiN[i] = phi;
      this.fricOn[i] = phi < 0.0015 ? 1 : 0;
      if (phi < 0) active++;
    }
    this.stats.activeContacts = active;
    if (this.hand) this.XhN.set(this.Xh);

    // ---- Gauss–Newton on the incremental potential
    let it = 0;
    for (; it < this.maxIterations; it++) {
      if (it > 0) {
        this.kinematics(q, true);
        this.gatherPoints();
      }
      const phi0 = this.assemble(h);
      const ridge = choleskySolve(this.Hm, this.n, this.g, this.dq, this.L);
      if (!Number.isFinite(ridge)) break;
      // dq = −H⁻¹ g
      let slope = 0;
      let maxStep = 0;
      for (let k = 0; k < this.n; k++) {
        this.dq[k] = -this.dq[k];
        slope += this.g[k] * this.dq[k];
        maxStep = Math.max(maxStep, Math.abs(this.dq[k]));
      }
      // limit enormous angular steps (keeps GN in its trust region)
      let alpha = maxStep > 0.6 ? 0.6 / maxStep : 1;
      let accepted = false;
      for (let ls = 0; ls < 8; ls++) {
        for (let k = 0; k < this.n; k++) this.qTry[k] = q[k] + alpha * this.dq[k];
        const phi = this.potential(this.qTry, h);
        if (phi <= phi0 + 1e-4 * alpha * slope || ls === 7) {
          accepted = phi <= phi0 + 1e-12 * Math.abs(phi0);
          break;
        }
        alpha *= 0.5;
      }
      if (accepted) q.set(this.qTry);
      if (!accepted || alpha * maxStep < 1e-9) {
        it++;
        break;
      }
    }
    this.stats.iterations = it;
    for (let k = 0; k < this.n; k++) qd[k] = (q[k] - qN[k]) / h;
    // leave chain consistent with the final state for rendering / queries
    this.chain.update(q[0], q.subarray(1), this.env.pivotZ);
  }

  // ------------------------------------------------------------------ incremental potential

  /** Value of the incremental potential Φ(q) for the current step. */
  private potential(q: Float64Array, h: number): number {
    this.kinematics(q, false);
    this.gatherPoints();
    return this.evalPotential(q, h);
  }

  private evalPotential(q: Float64Array, h: number): number {
    const { X, Xt, XN, cAir, nN, sM } = this;
    const g = this.env.gravity;
    const m = this.mPt;
    const ih2 = m / (2 * h * h);
    let phi = 0;
    for (let i = 0; i < this.nMass; i++) {
      const o = 3 * i;
      const s3 = 3 * sM[i];
      const dx = X[o] - Xt[o];
      const dy = X[o + 1] - Xt[o + 1];
      const dz = X[o + 2] - Xt[o + 2];
      phi += ih2 * (dx * dx + dy * dy + dz * dz);
      phi -= m * (g[0] * X[o] + g[1] * X[o + 1] + g[2] * X[o + 2]);
      const dn =
        (X[o] - XN[o]) * nN[s3] + (X[o + 1] - XN[o + 1]) * nN[s3 + 1] + (X[o + 2] - XN[o + 2]) * nN[s3 + 2];
      phi += (cAir[i] / (2 * h)) * dn * dn;
    }
    phi += this.contactPotential(h);
    phi += this.handPotential(h);
    phi += this.internalPotential(q, h, null, null);
    return phi;
  }

  private contactPotential(h: number): number {
    const kc = this.contactK;
    const cc = this.contactC;
    const cf = this.frictionC;
    let e = 0;
    for (let i = 0; i < this.nCon; i++) {
      const o = 3 * i;
      const x = this.Xc[o];
      const phi = this.Xc[o + 2] - surfaceHeight(this.surfaceFor(x), x);
      const pm = Math.min(phi, 0);
      const pn = Math.min(this.phiN[i], 0);
      e += 0.5 * kc * pm * pm + (cc / (2 * h)) * (pm - pn) * (pm - pn);
      if (this.fricOn[i]) {
        const dx = this.Xc[o] - this.XcN[o];
        const dy = this.Xc[o + 1] - this.XcN[o + 1];
        e += (cf / (2 * h)) * (dx * dx + dy * dy);
      }
    }
    return e;
  }

  private handPotential(h: number): number {
    const hand = this.hand;
    if (!hand) return 0;
    const kh = this.handK;
    const ch = this.handC;
    let e = 0;
    for (let a = 0; a < 3; a++) {
      const d = this.Xh[a] - hand.target[a];
      const w = this.Xh[a] - this.XhN[a] - h * hand.velocity[a];
      e += 0.5 * kh * d * d + (ch / (2 * h)) * w * w;
    }
    return e;
  }

  /**
   * Energy and damping terms that live directly in q-space: bending, spine,
   * fan regularisation and joint limits. Optionally accumulates gradient
   * and (Gauss–Newton) Hessian.
   */
  private internalPotential(
    q: Float64Array,
    h: number,
    grad: Float64Array | null,
    hess: Float64Array | null,
  ): number {
    const pa = this.params;
    const n = this.n;
    const p = q[0];
    const ck = this.ck;
    this.stiffnessAt(p, ck);
    let e = 0;
    // bending + visco-elastic damping
    let dEdp = 0;
    if (grad) {
      // central difference for dc_k/dp
      const eps = 1e-5;
      this.stiffnessAt(p + eps, this.ckPlus);
      this.stiffnessAt(p - eps, this.ckd);
      for (let k = 1; k < this.K; k++) this.ckd[k] = (this.ckPlus[k] - this.ckd[k]) / (2 * eps);
    }
    for (let k = 1; k < this.K; k++) {
      const psi = q[1 + k];
      const dpsi = psi - this.qN[1 + k];
      const cd = (pa.bendDamping * this.ckN[k]) / h;
      e += 0.5 * ck[k] * psi * psi + 0.5 * cd * dpsi * dpsi;
      if (grad && hess) {
        grad[1 + k] += ck[k] * psi + cd * dpsi;
        hess[(1 + k) * n + (1 + k)] += ck[k] + cd;
        dEdp += 0.5 * this.ckd[k] * psi * psi;
      }
      // joint limit
      const lim = 0.95 * Math.PI;
      const over = Math.abs(psi) - lim;
      if (over > 0) {
        const kl = 50 * ck[k] + 1e-6;
        e += 0.5 * kl * over * over;
        if (grad && hess) {
          grad[1 + k] += kl * over * Math.sign(psi);
          hess[(1 + k) * n + (1 + k)] += kl;
        }
      }
    }
    // spine binding
    {
      const psi = q[1];
      const d = psi - pa.spineRestAngle;
      const cd = pa.spineDamping / h;
      const dpsi = psi - this.qN[1];
      e += 0.5 * pa.spineStiffness * d * d + 0.5 * cd * dpsi * dpsi;
      if (grad && hess) {
        grad[1] += pa.spineStiffness * d + cd * dpsi;
        hess[n + 1] += pa.spineStiffness + cd;
      }
      const lo = -0.35;
      const hi = Math.PI + 0.35;
      const over = psi < lo ? psi - lo : psi > hi ? psi - hi : 0;
      if (over !== 0) {
        const kl = 0.05;
        e += 0.5 * kl * over * over;
        if (grad && hess) {
          grad[1] += kl * over;
          hess[n + 1] += kl;
        }
      }
    }
    // fan convergence: weak regularisation, damping and a barrier keeping the apex off the sheet
    {
      const kp = 1e-6;
      const cp = 2e-6 / h;
      const dp = p - this.qN[0];
      e += 0.5 * kp * p * p + 0.5 * cp * dp * dp;
      const over = Math.abs(p) - this.pMax;
      const kb = 2e-2;
      let gb = 0;
      let hb = 0;
      if (over > 0) {
        e += 0.5 * kb * over * over;
        gb = kb * over * Math.sign(p);
        hb = kb;
      }
      if (grad && hess) {
        grad[0] += kp * p + cp * dp + gb + dEdp;
        hess[0] += kp + cp + hb;
      }
    }
    return e;
  }

  // ------------------------------------------------------------------ assembly

  /** Builds the Gauss–Newton Hessian and gradient of Φ at the current kinematics. Returns Φ. */
  private assemble(h: number): number {
    const { G, F, X, Xt, XN, cAir, nN, sM, Hm, g } = this;
    const n = this.n;
    const nS = this.K;
    G.fill(0);
    F.fill(0);
    Hm.fill(0);
    g.fill(0);
    const grav = this.env.gravity;
    const m = this.mPt;
    const a = m / (h * h);
    const ih = 1 / h;
    let phi = 0;

    // inertia, gravity, air drag
    for (let i = 0; i < this.nMass; i++) {
      const o = 3 * i;
      const s = sM[i];
      const s3 = 3 * s;
      const x = X[o];
      const y = X[o + 1];
      const z = X[o + 2];
      const dx = x - Xt[o];
      const dy = y - Xt[o + 1];
      const dz = z - Xt[o + 2];
      phi += 0.5 * a * (dx * dx + dy * dy + dz * dz);
      phi -= m * (grav[0] * x + grav[1] * y + grav[2] * z);
      const nx = nN[s3];
      const ny = nN[s3 + 1];
      const nz = nN[s3 + 2];
      const dn = (x - XN[o]) * nx + (y - XN[o + 1]) * ny + (z - XN[o + 2]) * nz;
      const ca = cAir[i] * ih;
      phi += 0.5 * ca * dn * dn;
      const fx = a * dx - m * grav[0] + ca * dn * nx;
      const fy = a * dy - m * grav[1] + ca * dn * ny;
      const fz = a * dz - m * grav[2] + ca * dn * nz;
      this.addIso(s, x, y, z, a);
      this.addRank1(s, x, y, z, nx, ny, nz, ca);
      this.addForce(s, x, y, z, fx, fy, fz);
    }

    // contacts
    const kc = this.contactK;
    const cc = this.contactC;
    const cf = this.frictionC;
    for (let i = 0; i < this.nCon; i++) {
      const o = 3 * i;
      const x = this.Xc[o];
      const y = this.Xc[o + 1];
      const z = this.Xc[o + 2];
      const surf = this.surfaceFor(x);
      const gap = z - surfaceHeight(surf, x);
      const s = this.sC[i];
      let fx = 0;
      let fy = 0;
      let fz = 0;
      const pn = Math.min(this.phiN[i], 0);
      if (gap < 0) {
        const slope = surfaceSlope(surf, x);
        // ∇gap = (−S', 0, 1)
        const inv = 1 / Math.sqrt(1 + slope * slope);
        const gx = -slope;
        const gz = 1;
        const mag = kc * gap + cc * ih * (gap - pn);
        phi += 0.5 * kc * gap * gap + 0.5 * cc * ih * (gap - pn) * (gap - pn);
        fx += mag * gx;
        fz += mag * gz;
        const w = (kc + cc * ih) * (1 + slope * slope);
        this.addRank1(s, x, y, z, gx * inv, 0, gz * inv, w);
      } else if (pn < 0) {
        phi += 0.5 * cc * ih * pn * pn;
      }
      if (this.fricOn[i]) {
        const dx = x - this.XcN[o];
        const dy = y - this.XcN[o + 1];
        const c = cf * ih;
        phi += 0.5 * c * (dx * dx + dy * dy);
        fx += c * dx;
        fy += c * dy;
        this.addRank1(s, x, y, z, 1, 0, 0, c);
        this.addRank1(s, x, y, z, 0, 1, 0, c);
      }
      if (fx !== 0 || fy !== 0 || fz !== 0) this.addForce(s, x, y, z, fx, fy, fz);
    }

    // hand
    const hand = this.hand;
    if (hand) {
      const kh = this.handK;
      const ch = this.handC * ih;
      const s = this.chain.stripOf(hand.u, hand.v);
      const [x, y, z] = [this.Xh[0], this.Xh[1], this.Xh[2]];
      const f = [0, 0, 0];
      const P = [x, y, z];
      for (let k = 0; k < 3; k++) {
        const d = P[k] - hand.target[k];
        const w = P[k] - this.XhN[k] - h * hand.velocity[k];
        phi += 0.5 * kh * d * d + 0.5 * ch * w * w;
        f[k] = kh * d + ch * w;
      }
      this.addIso(s, x, y, z, kh + ch);
      this.addForce(s, x, y, z, f[0], f[1], f[2]);
    }

    // suffix sums over strips
    const { Gs, Fs, xiH, xiP, Wp, tmp6 } = this;
    for (let s = nS - 1; s >= 0; s--) {
      const o = 36 * s;
      const f6 = 6 * s;
      if (s === nS - 1) {
        for (let k = 0; k < 36; k++) Gs[o + k] = G[o + k];
        for (let k = 0; k < 6; k++) Fs[f6 + k] = F[f6 + k];
      } else {
        for (let k = 0; k < 36; k++) Gs[o + k] = G[o + k] + Gs[o + 36 + k];
        for (let k = 0; k < 6; k++) Fs[f6 + k] = F[f6 + k] + Fs[f6 + 6 + k];
      }
      // G_s·ξ^p_s
      for (let r = 0; r < 6; r++) {
        let acc = 0;
        for (let c = 0; c < 6; c++) acc += G[o + r * 6 + c] * xiP[f6 + c];
        tmp6[r] = acc;
      }
      let hpp = 0;
      let gp = 0;
      for (let r = 0; r < 6; r++) {
        Wp[f6 + r] = tmp6[r] + (s === nS - 1 ? 0 : Wp[f6 + 6 + r]);
        hpp += xiP[f6 + r] * tmp6[r];
        gp += xiP[f6 + r] * F[f6 + r];
      }
      Hm[0] += hpp;
      g[0] += gp;
    }
    // hinge–hinge and hinge–p blocks
    for (let k = 0; k < nS; k++) {
      const o = 36 * k;
      const x6 = 6 * k;
      // y = Ḡ_k ξ_k
      for (let r = 0; r < 6; r++) {
        let acc = 0;
        for (let c = 0; c < 6; c++) acc += Gs[o + r * 6 + c] * xiH[x6 + c];
        tmp6[r] = acc;
      }
      for (let j = 0; j <= k; j++) {
        const j6 = 6 * j;
        let acc = 0;
        for (let r = 0; r < 6; r++) acc += xiH[j6 + r] * tmp6[r];
        Hm[(1 + j) * n + (1 + k)] += acc;
        if (j !== k) Hm[(1 + k) * n + (1 + j)] += acc;
      }
      let gk = 0;
      let hpk = 0;
      for (let r = 0; r < 6; r++) {
        gk += xiH[x6 + r] * Fs[x6 + r];
        hpk += xiH[x6 + r] * Wp[x6 + r];
      }
      g[1 + k] += gk;
      Hm[1 + k] += hpk;
      Hm[(1 + k) * n] += hpk;
    }

    phi += this.internalPotential(this.q, h, g, Hm);
    return phi;
  }

  /** G_s += a·AᵀA with A = [−[X]×, I] (isotropic weight a at point X). */
  private addIso(s: number, x: number, y: number, z: number, a: number): void {
    const G = this.G;
    const o = 36 * s;
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    G[o] += a * (yy + zz);
    G[o + 1] -= a * x * y;
    G[o + 2] -= a * x * z;
    G[o + 6] -= a * x * y;
    G[o + 7] += a * (xx + zz);
    G[o + 8] -= a * y * z;
    G[o + 12] -= a * x * z;
    G[o + 13] -= a * y * z;
    G[o + 14] += a * (xx + yy);
    // top-right: a[X]×
    G[o + 4] -= a * z;
    G[o + 5] += a * y;
    G[o + 9] += a * z;
    G[o + 11] -= a * x;
    G[o + 15] -= a * y;
    G[o + 16] += a * x;
    // bottom-left: −a[X]×
    G[o + 19] += a * z;
    G[o + 20] -= a * y;
    G[o + 24] -= a * z;
    G[o + 26] += a * x;
    G[o + 30] += a * y;
    G[o + 31] -= a * x;
    // bottom-right
    G[o + 21] += a;
    G[o + 28] += a;
    G[o + 35] += a;
  }

  /** G_s += b·w wᵀ with w = Aᵀn = (X × n, n). */
  private addRank1(
    s: number,
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    b: number,
  ): void {
    if (b === 0) return;
    const w = this.tmp6;
    w[0] = y * nz - z * ny;
    w[1] = z * nx - x * nz;
    w[2] = x * ny - y * nx;
    w[3] = nx;
    w[4] = ny;
    w[5] = nz;
    const G = this.G;
    const o = 36 * s;
    for (let r = 0; r < 6; r++) {
      const br = b * w[r];
      for (let c = 0; c < 6; c++) G[o + r * 6 + c] += br * w[c];
    }
  }

  /** F_s += Aᵀ f = (X × f, f). */
  private addForce(s: number, x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    const F = this.F;
    const o = 6 * s;
    F[o] += y * fz - z * fy;
    F[o + 1] += z * fx - x * fz;
    F[o + 2] += x * fy - y * fx;
    F[o + 3] += fx;
    F[o + 4] += fy;
    F[o + 5] += fz;
  }

  // ------------------------------------------------------------------ queries

  /** World position of a material point in the current configuration. */
  positionOf(u: number, v: number, out = new Float64Array(3)): Float64Array {
    this.chain.update(this.q[0], this.q.subarray(1), this.env.pivotZ);
    this.chain.point(u, v, out, 0);
    return out;
  }

  /** Total mechanical energy (kinetic + gravity + bending + spine) — for diagnostics/tests. */
  mechanicalEnergy(): { kinetic: number; potential: number } {
    this.kinematics(this.q, true);
    this.gatherPoints();
    const { X, sM, qd, xiH, xiP } = this;
    // per-strip velocity twists
    const nS = this.K;
    const vel = new Float64Array(6 * nS);
    const acc = new Float64Array(6);
    for (let s = 0; s < nS; s++) {
      for (let r = 0; r < 6; r++) {
        acc[r] += xiH[6 * s + r] * qd[1 + s];
        vel[6 * s + r] = acc[r] + xiP[6 * s + r] * qd[0];
      }
    }
    let kin = 0;
    let pot = 0;
    const gr = this.env.gravity;
    for (let i = 0; i < this.nMass; i++) {
      const o = 3 * i;
      const x6 = 6 * sM[i];
      const px = X[o];
      const py = X[o + 1];
      const pz = X[o + 2];
      const ux = vel[x6 + 1] * pz - vel[x6 + 2] * py + vel[x6 + 3];
      const uy = vel[x6 + 2] * px - vel[x6] * pz + vel[x6 + 4];
      const uz = vel[x6] * py - vel[x6 + 1] * px + vel[x6 + 5];
      kin += 0.5 * this.mPt * (ux * ux + uy * uy + uz * uz);
      pot -= this.mPt * (gr[0] * px + gr[1] * py + gr[2] * pz);
    }
    this.stiffnessAt(this.q[0], this.ck);
    for (let k = 1; k < this.K; k++) pot += 0.5 * this.ck[k] * this.q[1 + k] ** 2;
    const d = this.q[1] - this.params.spineRestAngle;
    pot += 0.5 * this.params.spineStiffness * d * d;
    return { kinetic: kin, potential: pot };
  }

  /** Index of the hand's strip and the analytic Jacobian columns — exposed for tests. */
  debugTwists(): { hinge: Float64Array; p: Float64Array } {
    this.kinematics(this.q, true);
    return { hinge: Float64Array.from(this.xiH), p: Float64Array.from(this.xiP) };
  }

  /** Assembled Gauss–Newton system at the current state — exposed for tests. */
  debugAssemble(h: number): { H: Float64Array; g: Float64Array; phi: number } {
    this.qN.set(this.q);
    this.kinematics(this.q, true);
    this.gatherPoints();
    // zero-velocity prediction: X̃ = X
    this.Xt.set(this.X);
    this.XN.set(this.X);
    this.cAir.fill(0);
    for (let s = 0; s < this.K; s++) {
      const r = 9 * s;
      this.nN[3 * s] = this.chain.R[r + 2];
      this.nN[3 * s + 1] = this.chain.R[r + 5];
      this.nN[3 * s + 2] = this.chain.R[r + 8];
    }
    for (let i = 0; i < this.nCon; i++) {
      this.XcN.set(this.Xc.subarray(3 * i, 3 * i + 3), 3 * i);
      this.phiN[i] = 1;
      this.fricOn[i] = 0;
    }
    if (this.hand) this.XhN.set(this.Xh);
    this.stiffnessAt(this.q[0], this.ckN);
    const phi = this.assemble(h);
    return { H: Float64Array.from(this.Hm), g: Float64Array.from(this.g), phi };
  }

  /** Φ at an arbitrary q using the state captured by the last debugAssemble — for tests. */
  debugPotential(q: Float64Array, h: number): number {
    return this.potential(q, h);
  }
}
