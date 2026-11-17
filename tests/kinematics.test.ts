import { describe, expect, it } from 'vitest';
import { HingeChain } from '../src/physics/hingeChain';
import { hingeStiffness, logIntegral } from '../src/physics/bending';
import { restConfiguration } from '../src/physics/rest';
import { surfaceHeight } from '../src/physics/surface';
import { SheetSim } from '../src/physics/sheetSim';
import { DEFAULT_PAPER } from '../src/physics/params';
import { A5, rng, bookEnv } from './helpers';

const K = 24;
const delta = A5.W / (K - 1);

function randomConfig(r: () => number): { p: number; angles: Float64Array } {
  const p = (r() * 2 - 1) * (1.5 / A5.H);
  const angles = new Float64Array(K);
  angles[0] = r() * Math.PI;
  for (let j = 1; j < K; j++) angles[j] = (r() * 2 - 1) * 0.6;
  return { p, angles };
}

describe('HingeChain kinematics (discrete developable)', () => {
  it('keeps the spine on the binding axis for any configuration', () => {
    const r = rng(1);
    const chain = new HingeChain(A5.W, A5.H, K - 1, delta);
    const out = new Float64Array(3);
    for (let trial = 0; trial < 50; trial++) {
      const { p, angles } = randomConfig(r);
      chain.update(p, angles, 0.003);
      for (const v of [-A5.H / 2, -0.03, 0, 0.07, A5.H / 2]) {
        chain.point(0, v, out);
        expect(out[0]).toBeCloseTo(0, 12);
        expect(out[1]).toBeCloseTo(v, 12);
        expect(out[2]).toBeCloseTo(0.003, 12);
      }
    }
  });

  it('is continuous across every hinge line (adjacent strips agree on their shared ruling)', () => {
    const r = rng(2);
    const chain = new HingeChain(A5.W, A5.H, K - 1, delta);
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    for (let trial = 0; trial < 50; trial++) {
      const { p, angles } = randomConfig(r);
      chain.update(p, angles, 0);
      for (let j = 1; j < K; j++) {
        const s = chain.hingeSigma(j);
        for (const v of [-A5.H / 2, -0.05, 0, 0.04, A5.H / 2]) {
          const u = s * (1 + p * v); // a point on ruling j
          if (u > A5.W) continue;
          chain.pointInStrip(j - 1, u, v, a);
          chain.pointInStrip(j, u, v, b);
          expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-13);
        }
      }
    }
  });

  it('is an isometry: geodesic polylines keep their material length, chords never stretch', () => {
    const r = rng(3);
    const chain = new HingeChain(A5.W, A5.H, K - 1, delta);
    const xa = new Float64Array(3);
    const xb = new Float64Array(3);
    for (let trial = 0; trial < 30; trial++) {
      const { p, angles } = randomConfig(r);
      chain.update(p, angles, 0);
      // a straight material segment, finely sampled: its image length equals its material length
      const u0 = r() * A5.W;
      const v0 = (r() - 0.5) * A5.H;
      const u1 = r() * A5.W;
      const v1 = (r() - 0.5) * A5.H;
      const N = 4000;
      let len = 0;
      chain.point(u0, v0, xa);
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        chain.point(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t, xb);
        len += Math.hypot(xb[0] - xa[0], xb[1] - xa[1], xb[2] - xa[2]);
        xa.set(xb);
      }
      const mat = Math.hypot(u1 - u0, v1 - v0);
      // sampling a fold-crossing segment can only shorten it, by O(1/N)
      expect(len).toBeLessThanOrEqual(mat + 1e-12);
      expect(len).toBeGreaterThan(mat * (1 - 2e-3));
      // endpoints: chord ≤ material distance
      chain.point(u0, v0, xa);
      chain.point(u1, v1, xb);
      expect(Math.hypot(xb[0] - xa[0], xb[1] - xa[1], xb[2] - xa[2])).toBeLessThanOrEqual(mat + 1e-12);
    }
  });

  it('places strips with orthonormal rotations', () => {
    const r = rng(4);
    const chain = new HingeChain(A5.W, A5.H, K - 1, delta);
    const { p, angles } = randomConfig(r);
    chain.update(p, angles, 0);
    for (let s = 0; s < K; s++) {
      const R = chain.R.subarray(9 * s, 9 * s + 9);
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          let d = 0;
          for (let k = 0; k < 3; k++) d += R[i * 3 + k] * R[j * 3 + k];
          expect(d).toBeCloseTo(i === j ? 1 : 0, 12);
        }
    }
  });
});

describe('Jacobians', () => {
  it('analytic hinge and fan twists match finite differences of point positions', () => {
    const r = rng(5);
    const env = bookEnv();
    const sim = new SheetSim(A5, DEFAULT_PAPER, env, K);
    const q = new Float64Array(K + 1);
    q[0] = 2.1;
    q[1] = 0.9;
    for (let j = 2; j <= K; j++) q[j] = (r() - 0.5) * 0.5;
    sim.setState(q);
    const { hinge, p: xiP } = sim.debugTwists();
    const chain = sim.chain;
    const X = new Float64Array(3);
    const Xp = new Float64Array(3);
    const Xm = new Float64Array(3);
    for (let trial = 0; trial < 40; trial++) {
      const u = r() * A5.W;
      const v = (r() - 0.5) * A5.H;
      chain.update(q[0], q.subarray(1), env.pivotZ);
      const s = chain.stripOf(u, v);
      // stay away from strip boundaries so the FD stencil stays in one strip
      const sig = u / (1 + q[0] * v) / delta + 0.5;
      if (Math.abs(sig - Math.round(sig)) < 0.05) continue;
      chain.pointInStrip(s, u, v, X);
      const eps = 1e-7;
      for (let c = 0; c <= K; c++) {
        const qp = Float64Array.from(q);
        const qm = Float64Array.from(q);
        qp[c] += eps;
        qm[c] -= eps;
        chain.update(qp[0], qp.subarray(1), env.pivotZ);
        chain.pointInStrip(s, u, v, Xp);
        chain.update(qm[0], qm.subarray(1), env.pivotZ);
        chain.pointInStrip(s, u, v, Xm);
        const fd = [0, 1, 2].map((k) => (Xp[k] - Xm[k]) / (2 * eps));
        let xi: Float64Array;
        if (c === 0) xi = xiP.subarray(6 * s, 6 * s + 6);
        else if (c - 1 <= s) xi = hinge.subarray(6 * (c - 1), 6 * (c - 1) + 6);
        else xi = new Float64Array(6);
        const an = [
          xi[1] * X[2] - xi[2] * X[1] + xi[3],
          xi[2] * X[0] - xi[0] * X[2] + xi[4],
          xi[0] * X[1] - xi[1] * X[0] + xi[5],
        ];
        for (let k = 0; k < 3; k++) expect(an[k]).toBeCloseTo(fd[k], 6);
      }
    }
  });

  it('assembled gradient equals the finite-difference gradient of the incremental potential', () => {
    const r = rng(6);
    const env = bookEnv();
    const sim = new SheetSim(A5, DEFAULT_PAPER, env, K);
    const q = new Float64Array(K + 1);
    q[0] = 1.3;
    q[1] = 1.1;
    for (let j = 2; j <= K; j++) q[j] = (r() - 0.5) * 0.3;
    sim.setState(q);
    sim.hand = { u: A5.W * 0.93, v: -A5.H * 0.37, target: [0.02, -0.06, 0.09], velocity: [0, 0, 0], strength: 1 };
    const h = 1 / 240;
    const { H, g } = sim.debugAssemble(h);
    const n = K + 1;
    for (let c = 0; c < n; c++) {
      const eps = 1e-6;
      const qp = Float64Array.from(q);
      const qm = Float64Array.from(q);
      qp[c] += eps;
      qm[c] -= eps;
      const fd = (sim.debugPotential(qp, h) - sim.debugPotential(qm, h)) / (2 * eps);
      expect(g[c]).toBeCloseTo(fd, Math.max(3, -Math.round(Math.log10(Math.abs(fd) + 1e-9)) + 4));
      expect(Math.abs(g[c] - fd)).toBeLessThan(1e-5 * Math.max(1, Math.abs(fd)) + 1e-7);
    }
    // GN Hessian is symmetric with a positive diagonal
    for (let i = 0; i < n; i++) {
      expect(H[i * n + i]).toBeGreaterThan(0);
      for (let j = 0; j < n; j++) expect(H[i * n + j]).toBeCloseTo(H[j * n + i], 9);
    }
  });
});

describe('Bending stiffness', () => {
  const D = 2.5e-4;
  it('reduces to D·H/δ for a cylinder', () => {
    for (let k = 1; k < K; k++) {
      expect(hingeStiffness(k, 0, A5.W, A5.H, delta, D)).toBeCloseTo((D * A5.H) / delta, 12);
    }
  });

  it('matches direct quadrature of ∫ ds / h(s) for a cone', () => {
    const p = 5;
    for (const k of [1, 7, 15, 22]) {
      const sk = (k - 0.5) * delta;
      const b0 = (k - 1) * delta;
      const b1 = k * delta;
      const dist = (u: number, v: number, b: number) =>
        Math.abs(u - b * (1 + p * v)) / Math.sqrt(1 + (b * p) ** 2);
      // integrate along the ruling, clipped to the sheet
      const N = 20000;
      let acc = 0;
      const ds = Math.sqrt(1 + (sk * p) ** 2);
      for (let i = 0; i < N; i++) {
        const v = -A5.H / 2 + ((i + 0.5) / N) * A5.H;
        const u = sk * (1 + p * v);
        if (u > A5.W) continue;
        const hgt = dist(u, v, b0) + dist(u, v, b1);
        acc += (ds * (A5.H / N)) / hgt;
      }
      const exact = hingeStiffness(k, p, A5.W, A5.H, delta, D);
      expect(Math.abs(exact - D * acc) / exact).toBeLessThan(1e-4);
    }
  });

  it('log integral is smooth through p = 0', () => {
    expect(logIntegral(1e-12, -0.1, 0.1)).toBeCloseTo(0.2, 12);
    expect(logIntegral(1e-6, -0.1, 0.1)).toBeCloseTo(0.2, 9);
  });
});

describe('Rest configuration', () => {
  it('puts every hinge line exactly on the gutter-curved stack surface', () => {
    const env = bookEnv(0.001, 0.012);
    for (const side of [1, -1] as const) {
      const surf = side === 1 ? env.right : env.left;
      const q = restConfiguration(A5.W, K, surf, side, env.pivotZ);
      const chain = new HingeChain(A5.W, A5.H, K - 1, delta);
      chain.update(q[0], q.subarray(1), env.pivotZ);
      const X = new Float64Array(3);
      for (let j = 1; j < K; j++) {
        chain.pointInStrip(j, chain.hingeSigma(j), 0, X);
        expect(X[2]).toBeCloseTo(surfaceHeight(surf, X[0]), 9);
        expect(Math.sign(X[0])).toBe(side);
      }
    }
  });

  it('unwraps left-hand angles when the stack dips below the pivot', () => {
    const dip = { base: 0.0004, top: 0, gutter: 0.01 };
    const q = restConfiguration(A5.W, K, dip, -1, 0.0004);
    expect(q[1]).toBeGreaterThan(Math.PI);
    expect(q[1]).toBeLessThan(Math.PI + 0.2);
  });

  it('is flat on a flat stack and mirrored on the left', () => {
    const flat = { base: 0, top: 0, gutter: 0 };
    const qr = restConfiguration(A5.W, K, flat, 1, 0);
    const ql = restConfiguration(A5.W, K, flat, -1, 0);
    for (let j = 0; j <= K; j++) expect(qr[j]).toBeCloseTo(0, 9);
    expect(ql[1]).toBeCloseTo(Math.PI, 9);
    for (let j = 2; j <= K; j++) expect(ql[j]).toBeCloseTo(0, 9);
  });
});

describe('Stack surface with the sheet beneath (sheet-on-sheet contact)', () => {
  it('takes the higher of the idealised stack and the resting sheet profile, on both sides', async () => {
    const { surfaceHeight, surfaceSlope } = await import('../src/physics/surface');
    const s = {
      base: 0,
      top: 0.001,
      gutter: 0.01,
      profileX: Float64Array.from([0, 0.02, 0.05, 0.1]),
      profileZ: Float64Array.from([0, 0.004, 0.003, 0.0005]),
    };
    expect(surfaceHeight(s, 0.02)).toBeCloseTo(0.004, 12);
    expect(surfaceHeight(s, -0.02)).toBeCloseTo(0.004, 12);
    expect(surfaceHeight(s, 0.035)).toBeCloseTo(0.0035, 12);
    expect(surfaceHeight(s, 0.2)).toBeCloseTo(0.001, 12); // beyond the profile: plain stack
    expect(surfaceSlope(s, 0.03)).toBeCloseTo(-0.001 / 0.03, 9);
    expect(surfaceSlope(s, -0.03)).toBeCloseTo(0.001 / 0.03, 9);
    // numerically consistent slope where the profile dominates
    const h = 1e-7;
    expect((surfaceHeight(s, 0.01 + h) - surfaceHeight(s, 0.01 - h)) / (2 * h)).toBeCloseTo(surfaceSlope(s, 0.01), 5);
  });
});
