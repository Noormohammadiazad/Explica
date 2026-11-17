import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SheetMesh } from '../src/render/sheetMesh';
import { createPaperMaterial } from '../src/render/paperMaterial';
import { BLOCK_GAP, pageBlockGeometry } from '../src/render/pageBlock';
import { restConfiguration } from '../src/physics/rest';
import { staticEquilibrium } from '../src/physics/equilibrium';
import { DEFAULT_PAPER, PHYSICS_STRIPS } from '../src/physics/params';
import { gutterWidth, type StackSurface } from '../src/physics/surface';
import type { SheetEnvironment } from '../src/physics/sheetSim';
import { A5 } from './helpers';

const K = PHYSICS_STRIPS;
const THICKNESS = 0.00011;

function sheetMesh(): SheetMesh {
  const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const mk = (mirror: boolean) => createPaperMaterial({ blank, fibre: new THREE.Texture(), mirror, pageWidth: A5.W });
  return new SheetMesh(A5, K, THICKNESS, mk(false), mk(true));
}

/** A stack of `under` sheets (0.1 mm each) beneath the resting sheet, pivot at 28 % of a 24-sheet book. */
function stack(under: number): { surface: StackSurface; pivotZ: number } {
  const pivotZ = 0.28 * 24 * 1e-4;
  const top = under * 1e-4;
  return { surface: { base: pivotZ, top, gutter: gutterWidth(top - pivotZ, A5.W) }, pivotZ };
}

/** The resting pose the app uses: static equilibrium from the analytic guess. */
function restingPose(side: 'L' | 'R', under: number): { q: Float64Array; pivotZ: number } {
  const { surface, pivotZ } = stack(under);
  const env: SheetEnvironment = { gravity: [0, 0, -9.81], pivotZ, right: surface, left: surface };
  const guess = restConfiguration(A5.W, K, surface, side === 'R' ? 1 : -1, pivotZ);
  return { q: staticEquilibrium(A5, DEFAULT_PAPER, env, guess, K), pivotZ };
}

/** Height of the first surface met by a vertical ray from above at (x, y), or null. */
function heightAt(mesh: THREE.Mesh, x: number, y: number): number | null {
  const rc = new THREE.Raycaster(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
  const hit = rc.intersectObject(mesh, false)[0];
  return hit ? hit.point.z : null;
}

function surfaceMesh(geo: THREE.BufferGeometry): THREE.Mesh {
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
}

/** The sheet's stack-facing face as a mesh (same grid as the rendered sheet). */
function underside(m: SheetMesh, side: 'L' | 'R'): THREE.Mesh {
  const f = m.stackFace(side, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(f.positions, 3));
  const idx: number[] = [];
  for (let j = 0; j < f.rows - 1; j++)
    for (let i = 0; i < f.cols - 1; i++) {
      const a = j * f.cols + i;
      idx.push(a, a + 1, a + f.cols + 1, a, a + f.cols + 1, a + f.cols);
    }
  g.setIndex(idx);
  return surfaceMesh(g);
}

/** Smallest vertical clearance between the sheet's underside and the block top, over a dense grid of rays. */
function clearance(side: 'L' | 'R', q: ArrayLike<number>, pivotZ: number): { min: number; minUnclamped: number; rays: number } {
  const m = sheetMesh();
  m.update(q, pivotZ);
  const block = pageBlockGeometry(m.stackFace(side, BLOCK_GAP), m.stackFace(side, 0), side);
  expect(block.top).not.toBeNull();
  const top = surfaceMesh(block.top!);
  const sheet = underside(m, side);
  const sx = side === 'R' ? 1 : -1;
  let min = Infinity;
  let minUnclamped = Infinity;
  let rays = 0;
  for (let i = 0; i <= 60; i++) {
    for (let j = 0; j <= 24; j++) {
      // off-grid sample positions, denser towards the spine, right up to the corners
      const x = sx * (0.0005 + (A5.W - 0.002) * (i / 60) ** 1.3);
      const y = (j / 24 - 0.5) * A5.H * 0.9995;
      const zs = heightAt(sheet, x, y);
      const zb = heightAt(top, x, y);
      if (zs == null || zb == null) continue;
      rays++;
      min = Math.min(min, zs - zb);
      if (zb > 1e-7) minUnclamped = Math.min(minUnclamped, zs - zb);
    }
  }
  return { min, minUnclamped, rays };
}

describe('Page block under a resting sheet', () => {
  for (const side of ['R', 'L'] as const) {
    it(`stays below the ${side === 'R' ? 'right' : 'left'} sheet everywhere, by the full gap where it is not resting on the board`, () => {
      const { q, pivotZ } = restingPose(side, 12);
      const c = clearance(side, q, pivotZ);
      expect(c.rays).toBeGreaterThan(1400);
      // measured vertically; the gap is along the normal, and the sheet is never steeper than ~25° here
      expect(c.minUnclamped).toBeGreaterThan(0.9 * BLOCK_GAP);
      expect(c.min).toBeGreaterThan(0);
    });
  }

  it('never rises above a sheet on a very thin stack (the old 0.2 mm floor did)', () => {
    for (const under of [1, 2, 3]) {
      const { q, pivotZ } = restingPose('L', under);
      const m = sheetMesh();
      m.update(q, pivotZ);
      const block = pageBlockGeometry(m.stackFace('L', BLOCK_GAP), m.stackFace('L', 0), 'L');
      const sheet = underside(m, 'L');
      if (!block.top) continue; // too thin to need a top at all
      const top = surfaceMesh(block.top);
      for (let i = 0; i <= 40; i++) {
        for (const y of [-0.104, -0.05, 0, 0.05, 0.104]) {
          const x = -(0.001 + (A5.W - 0.003) * (i / 40));
          const zs = heightAt(sheet, x, y);
          const zb = heightAt(top, x, y);
          if (zs != null && zb != null) expect(zs - zb).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('follows a conical sheet into its corners (no corner pokes out)', () => {
    const { q, pivotZ } = restingPose('R', 12);
    const cone = Float64Array.from(q);
    cone[0] = 2.5; // a strong fan: head and tail corners curl differently
    const c = clearance('R', cone, pivotZ);
    expect(c.minUnclamped).toBeGreaterThan(0.85 * BLOCK_GAP);
    expect(c.min).toBeGreaterThan(0);
  });

  it('walls rise from the board to exactly the sheet underside edges, facing outwards', () => {
    const { q, pivotZ } = restingPose('R', 12);
    const m = sheetMesh();
    m.update(q, pivotZ);
    const edge = m.stackFace('R', 0);
    const walls = pageBlockGeometry(m.stackFace('R', BLOCK_GAP), edge, 'R').walls;
    const p = walls.attributes.position;
    const n = walls.attributes.normal;
    // every top vertex of a wall is a boundary vertex of the underside
    let tops = 0;
    for (let k = 0; k < p.count; k += 2) {
      const z = p.getZ(k);
      expect(p.getZ(k + 1)).toBe(0);
      let best = Infinity;
      for (let v = 0; v < edge.positions.length / 3; v++) {
        const d = Math.hypot(edge.positions[3 * v] - p.getX(k), edge.positions[3 * v + 1] - p.getY(k), edge.positions[3 * v + 2] - z);
        best = Math.min(best, d);
      }
      expect(best).toBeLessThan(1e-9);
      tops++;
    }
    expect(tops).toBe(2 * edge.cols + edge.rows);
    // triangle winding agrees with the outward normals
    const idx = walls.index!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const out = new THREE.Vector3();
    let checked = 0;
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(p, idx.getX(t));
      b.fromBufferAttribute(p, idx.getX(t + 1));
      c.fromBufferAttribute(p, idx.getX(t + 2));
      const geo = b.clone().sub(a).cross(c.clone().sub(a));
      if (geo.lengthSq() < 1e-16) continue; // zero-height sliver at the spine
      out.fromBufferAttribute(n, idx.getX(t));
      expect(geo.dot(out)).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });
});
