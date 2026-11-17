import * as THREE from 'three';

/** A surface sampled on a sheet's render grid: cols × rows vertices, u (spine → fore-edge) fastest. */
export interface FaceGrid {
  positions: Float32Array;
  normals: Float32Array;
  cols: number;
  rows: number;
}

/**
 * Clearance between the resting top sheet's underside and the top of the page
 * block beneath it [m]. Because the block top is the sheet's own underside
 * offset along the normal on the same triangulation, this clearance holds
 * everywhere, including at the corners and between grid vertices. 0.12 mm is
 * more than a 16-bit depth buffer resolves at reading distance, and the block
 * top is pushed further back with a polygon offset as well.
 */
export const BLOCK_GAP = 0.00012;

const STRIPE = 0.02; // metres of block height per edge-texture repeat
const EDGE_U = 8; // edge-texture repeats per metre along an edge

/**
 * The page block under a resting top sheet: everything below it in the stack.
 *
 *  - `top`: the sheet's stack-facing face pushed BLOCK_GAP further down
 *    (`stackFace(side, BLOCK_GAP)`), clamped to the board. It is never meant to
 *    be seen; it closes the solid. Null when the stack beneath is too thin to
 *    show.
 *  - `walls`: head, tail and fore-edge walls carrying the page-edge stripes,
 *    rising from the board (z = 0) to the sheet's actual underside edges
 *    (`stackFace(side, 0)`), so the stack meets the sheet without a gap.
 */
export function pageBlockGeometry(
  top: FaceGrid,
  edge: FaceGrid,
  side: 'L' | 'R',
): { top: THREE.BufferGeometry | null; walls: THREE.BufferGeometry } {
  return { top: blockTop(top, side), walls: blockWalls(edge, side) };
}

function blockTop(grid: FaceGrid, side: 'L' | 'R'): THREE.BufferGeometry | null {
  const { cols, rows } = grid;
  const positions = Float32Array.from(grid.positions);
  let maxZ = 0;
  for (let k = 2; k < positions.length; k += 3) {
    if (positions[k] < 0) positions[k] = 0; // never below the board
    maxZ = Math.max(maxZ, positions[k]);
  }
  if (maxZ < 2e-5) return null;
  const idx: number[] = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = a + cols;
      // the grid winds counter-clockwise about the sheet's front normal; the block top faces the
      // sheet: the front normal for a sheet on the right, the opposite one on the left
      if (side === 'R') idx.push(a, b, c, a, c, d);
      else idx.push(a, c, b, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(grid.normals), 3));
  g.setIndex(idx);
  return g;
}

function blockWalls(grid: FaceGrid, side: 'L' | 'R'): THREE.BufferGeometry {
  const { cols, rows, positions: P } = grid;
  const at = (i: number, j: number) => {
    const o = 3 * (j * cols + i);
    return new THREE.Vector3(P[o], P[o + 1], Math.max(0, P[o + 2]));
  };
  const tail: THREE.Vector3[] = [];
  const head: THREE.Vector3[] = [];
  const fore: THREE.Vector3[] = [];
  for (let i = 0; i < cols; i++) {
    tail.push(at(i, 0));
    head.push(at(i, rows - 1));
  }
  for (let j = 0; j < rows; j++) fore.push(at(cols - 1, j));

  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const wall = (line: THREE.Vector3[], outward: THREE.Vector3) => {
    let s = 0;
    const base = pos.length / 3;
    for (let i = 0; i < line.length; i++) {
      const p = line[i];
      if (i > 0) s += Math.hypot(p.x - line[i - 1].x, p.y - line[i - 1].y);
      pos.push(p.x, p.y, p.z, p.x, p.y, 0);
      nor.push(outward.x, outward.y, outward.z, outward.x, outward.y, outward.z);
      uv.push(s * EDGE_U, p.z / STRIPE, s * EDGE_U, 0);
    }
    for (let i = 0; i < line.length - 1; i++) {
      const t0 = base + 2 * i;
      const b0 = t0 + 1;
      const t1 = t0 + 2;
      const b1 = t0 + 3;
      // orient each quad so it faces outwards, whichever way the line runs
      const d = line[i + 1].clone().sub(line[i]);
      const facing = new THREE.Vector3(d.y, -d.x, 0).dot(outward); // (b0 − t0) × (b1 − t0) ∝ (dy, −dx, 0)
      if (facing >= 0) idx.push(t0, b0, b1, t0, b1, t1);
      else idx.push(t0, b1, b0, t0, t1, b1);
    }
  };
  wall(tail, new THREE.Vector3(0, -1, 0));
  wall(head, new THREE.Vector3(0, 1, 0));
  wall(fore, new THREE.Vector3(side === 'R' ? 1 : -1, 0, 0));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
