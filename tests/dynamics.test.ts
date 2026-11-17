import { describe, expect, it } from 'vitest';
import { SheetSim } from '../src/physics/sheetSim';
import { DEFAULT_PAPER, type PaperParams } from '../src/physics/params';
import { A5, freeEnv, restingSheet } from './helpers';

const K = 24;
const H_STEP = 1 / 240;

describe('Statics: Euler–Bernoulli cantilever', () => {
  it('tip deflection of a clamped stiff sheet matches ρ_A g W⁴ / 8D', () => {
    const D = 0.05; // stiff card → small-deflection regime (δ/W ≈ 0.7 %)
    const params: PaperParams = {
      ...DEFAULT_PAPER,
      flexuralRigidity: D,
      spineStiffness: 1e4,
      spineRestAngle: 0,
      bendDamping: 0.05,
      airLinear: 0,
      dragCoefficient: 0,
    };
    const sim = new SheetSim(A5, params, freeEnv(), K);
    sim.setState(new Float64Array(K + 1));
    for (let i = 0; i < 1500; i++) sim.step(0.004);
    const tip = sim.positionOf(A5.W, 0);
    const theory = (params.arealDensity * 9.81 * A5.W ** 4) / (8 * D);
    expect(-tip[2]).toBeGreaterThan(0);
    expect(Math.abs(-tip[2] - theory) / theory).toBeLessThan(0.02);
    // symmetric load → parallel rulings
    expect(Math.abs(sim.q[0])).toBeLessThan(1e-6);
  });

  it('a real (soft) paper sheet droops well past the linear regime but never stretches', () => {
    const params: PaperParams = { ...DEFAULT_PAPER, spineStiffness: 1e4, spineRestAngle: 0, bendDamping: 0.05 };
    const sim = new SheetSim(A5, params, freeEnv(), K);
    sim.setState(new Float64Array(K + 1));
    for (let i = 0; i < 1500; i++) sim.step(0.004);
    const tip = sim.positionOf(A5.W, 0);
    // elasto-gravity length ≈ 6.8 cm < W: the tip hangs well below the clamp
    expect(-tip[2]).toBeGreaterThan(0.06);
    expect(Math.hypot(tip[0], tip[2])).toBeLessThanOrEqual(A5.W + 1e-12);
  });
});

describe('Dynamics', () => {
  it('implicit Euler never creates energy, and keeps most of an undamped elastic vibration', () => {
    const params: PaperParams = {
      ...DEFAULT_PAPER,
      bendDamping: 0,
      spineDamping: 0,
      airLinear: 0,
      dragCoefficient: 0,
    };
    const env = freeEnv();
    env.gravity = [0, 0, 0];
    const sim = new SheetSim(A5, params, env, K);
    const q = new Float64Array(K + 1);
    q[1] = Math.PI / 2 + 0.3; // spine spring wound up
    for (let j = 2; j <= K; j++) q[j] = 0.04; // elastic curl
    sim.setState(q);
    sim.maxIterations = 6;
    const e0 = sim.mechanicalEnergy();
    const start = e0.kinetic + e0.potential;
    let prev = start;
    for (let i = 0; i < 120; i++) {
      sim.step(H_STEP);
      const e = sim.mechanicalEnergy();
      const tot = e.kinetic + e.potential;
      expect(tot).toBeLessThanOrEqual(prev + 1e-9 * start);
      prev = tot;
    }
    // numerical dissipation only eats the stiff, high-frequency modes
    expect(prev).toBeGreaterThan(0.3 * start);
  });

  it('a spinning page keeps its angular momentum (the turning motion is not numerically damped)', () => {
    const params: PaperParams = {
      ...DEFAULT_PAPER,
      spineStiffness: 0,
      spineDamping: 0,
      bendDamping: 0,
      airLinear: 0,
      dragCoefficient: 0,
    };
    const env = freeEnv();
    env.gravity = [0, 0, 0];
    const sim = new SheetSim(A5, params, env, K);
    const q = new Float64Array(K + 1);
    const qd = new Float64Array(K + 1);
    q[1] = 0.2;
    qd[1] = 4; // rad/s about the spine
    sim.setState(q, qd);
    const e0 = sim.mechanicalEnergy().kinetic;
    for (let i = 0; i < 120; i++) sim.step(H_STEP);
    expect(sim.mechanicalEnergy().kinetic).toBeGreaterThan(0.97 * e0);
    expect(sim.q[1]).toBeCloseTo(0.2 + 4 * 0.5, 1);
  });

  it('a flicked page flies over and lands on the left stack', () => {
    const sim = restingSheet();
    flick(sim);
    for (let i = 0; i < 240 * 4; i++) sim.step(H_STEP);
    expect(sim.q[1]).toBeGreaterThan(Math.PI - 0.35);
    expect(sim.stats.maxSpeed).toBeLessThan(0.05);
  });

  it('a gently lifted and released corner falls back onto the right stack', () => {
    const sim = restingSheet();
    const corner = sim.positionOf(A5.W, -A5.H / 2);
    sim.hand = {
      u: A5.W,
      v: -A5.H / 2,
      target: [corner[0], corner[1], corner[2]],
      velocity: [0, 0, 0],
      strength: 1,
    };
    for (let i = 0; i < 120; i++) {
      const t = (i + 1) / 120;
      sim.hand.target = [corner[0] - 0.03 * t, corner[1] + 0.01 * t, corner[2] + 0.04 * t];
      sim.step(H_STEP);
    }
    sim.hand = null;
    for (let i = 0; i < 240 * 3; i++) sim.step(H_STEP);
    expect(sim.q[1]).toBeLessThan(0.3);
    expect(sim.stats.activeContacts).toBeGreaterThan(10);
  });

  it('peeling the bottom corner makes a cone with the apex below the page (p > 0), top corner p < 0', () => {
    for (const sideV of [-1, 1]) {
      const sim = restingSheet();
      const v = (sideV * A5.H) / 2;
      const corner = sim.positionOf(A5.W, v);
      sim.hand = { u: A5.W, v, target: [corner[0], corner[1], corner[2]], velocity: [0, 0, 0], strength: 1 };
      for (let i = 0; i < 240; i++) {
        const t = Math.min(1, (i + 1) / 180);
        // pull the corner up and diagonally towards the page centre
        sim.hand.target = [corner[0] - 0.045 * t, corner[1] - sideV * 0.03 * t, corner[2] + 0.05 * t];
        sim.step(H_STEP);
      }
      expect(sideV * -sim.q[0]).toBeGreaterThan(0.5);
      // the opposite corner barely moves compared to the peeled one
      const peeled = sim.positionOf(A5.W, v);
      const other = sim.positionOf(A5.W, -v);
      const base = corner[2];
      expect(other[2] - base).toBeLessThan(0.15 * (peeled[2] - base));
    }
  });

  it('is deterministic: identical inputs give bit-identical trajectories', () => {
    const run = () => {
      const sim = restingSheet();
      flick(sim);
      for (let i = 0; i < 200; i++) sim.step(H_STEP);
      return Array.from(sim.q).concat(Array.from(sim.qd));
    };
    expect(run()).toEqual(run());
  });
});

/** Grabs the lower outer corner of a right-hand page and throws it across the spine. */
function flick(sim: SheetSim): void {
  const u = A5.W * 0.95;
  const v = -A5.H * 0.3;
  const p0 = sim.positionOf(u, v);
  sim.hand = { u, v, target: [p0[0], p0[1], p0[2]], velocity: [0, 0, 0], strength: 1 };
  const steps = 60; // 0.25 s
  const sweep = Math.PI * 0.62;
  const omega = sweep / (steps * H_STEP);
  const r = p0[0] * 0.85;
  for (let i = 0; i < steps; i++) {
    const ang = sweep * ((i + 1) / steps);
    sim.hand.target = [r * Math.cos(ang), p0[1], p0[2] + r * Math.sin(ang)];
    sim.hand.velocity = [-r * Math.sin(ang) * omega, 0, r * Math.cos(ang) * omega];
    sim.step(H_STEP);
  }
  sim.hand = null;
}

describe('Resting pose', () => {
  it('static equilibrium is a fixed point of the dynamics and lies on the stack', async () => {
    const { staticEquilibrium } = await import('../src/physics/equilibrium');
    const { restConfiguration } = await import('../src/physics/rest');
    const { bookEnv } = await import('./helpers');
    for (const side of [1, -1] as const) {
      const env = bookEnv(0.003, 0.009);
      const surf = side === 1 ? env.right : env.left;
      const q0 = restConfiguration(A5.W, K, surf, side, env.pivotZ);
      const t0 = performance.now();
      const q = staticEquilibrium(A5, DEFAULT_PAPER, env, q0, K);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(250);
      // stiff paper bridges the tight gutter curve rather than hugging it, but stays close
      expect(Math.abs(q[1] - q0[1])).toBeLessThan(0.2);
      const sim = new SheetSim(A5, DEFAULT_PAPER, env, K);
      sim.setState(q);
      for (let i = 0; i < 60; i++) sim.step(H_STEP);
      for (let k = 1; k <= K; k++) expect(Math.abs(sim.q[k] - q[k])).toBeLessThan(2e-3);
      // the fore-edge rests on the stack (within contact compliance)
      const edge = sim.positionOf(A5.W, 0);
      expect(Math.abs(edge[2] - 0.009)).toBeLessThan(5e-4);
    }
  });
});
