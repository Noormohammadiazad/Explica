import { SheetSim, type SheetEnvironment } from '../src/physics/sheetSim';
import { DEFAULT_PAPER, type PaperParams } from '../src/physics/params';
import { restConfiguration } from '../src/physics/rest';

export const A5 = { W: 0.148, H: 0.21 };

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bookEnv(pivotZ = 0.002, top = 0.004): SheetEnvironment {
  return {
    gravity: [0, 0, -9.81],
    pivotZ,
    right: { base: pivotZ, top, gutter: 0.015 },
    left: { base: pivotZ, top, gutter: 0.015 },
  };
}

export function freeEnv(): SheetEnvironment {
  return {
    gravity: [0, 0, -9.81],
    pivotZ: 0,
    right: { base: -10, top: -10, gutter: 0 },
    left: { base: -10, top: -10, gutter: 0 },
  };
}

/** A sheet resting on the right-hand stack of a book. */
export function restingSheet(params: PaperParams = DEFAULT_PAPER, K = 24): SheetSim {
  const env = bookEnv();
  const sim = new SheetSim(A5, params, env, K);
  sim.setState(restConfiguration(A5.W, K, env.right, 1, env.pivotZ));
  return sim;
}
