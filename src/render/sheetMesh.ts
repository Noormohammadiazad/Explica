import * as THREE from 'three';
import { HingeChain } from '../physics/hingeChain';
import type { SheetDims } from '../physics/params';
import type { PaperMaterial } from './paperMaterial';
import type { FaceGrid } from './pageBlock';

/** Each physics hinge is spread over this many render sub-hinges. */
export const RENDER_REFINE = 4;

/**
 * GPU mesh of one sheet (both faces), deformed on the CPU from the physics
 * configuration.
 *
 * Every physical hinge angle ψ_k is distributed uniformly over R sub-hinges
 * across its dual cell: the rendered surface is still an exact isometry of the
 * page, but its curvature is smooth. Normals come analytically from the
 * sub-strip rotations and are blended between neighbouring sub-strips.
 */
export class SheetMesh {
  readonly mesh: THREE.Mesh;
  readonly front: PaperMaterial;
  readonly back: PaperMaterial;
  /** Index of the sheet currently displayed (−1 = none). */
  sheet = -1;

  private readonly chain: HingeChain;
  private readonly angles: Float64Array;
  private readonly us: Float64Array;
  private readonly vs: Float64Array;
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly nv: number;
  private readonly half: number;
  /** Render grid size: vertices along u (spine → fore-edge) and along v (tail → head). */
  readonly cols: number;
  readonly rows: number;

  constructor(
    readonly dims: SheetDims,
    readonly K: number,
    thickness: number,
    front: PaperMaterial,
    back: PaperMaterial,
    segU = 72,
    segV = 48,
  ) {
    this.front = front;
    this.back = back;
    this.half = thickness / 2;
    const { W, H } = dims;
    const delta = W / (K - 1);
    this.chain = new HingeChain(W, H, (K - 1) * RENDER_REFINE, delta / RENDER_REFINE);
    this.angles = new Float64Array(this.chain.nStrips);

    const cols = segU + 1;
    const rows = segV + 1;
    this.cols = cols;
    this.rows = rows;
    this.nv = cols * rows;
    this.us = new Float64Array(this.nv);
    this.vs = new Float64Array(this.nv);
    const uv = new Float32Array(this.nv * 2 * 2);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        // slightly denser sampling near the spine, where the gutter curls hardest
        const a = i / segU;
        const u = W * (0.35 * a * a + 0.65 * a);
        const v = -H / 2 + (H * j) / segV;
        this.us[k] = u;
        this.vs[k] = v;
        uv[2 * k] = u / W;
        uv[2 * k + 1] = j / segV;
        uv[2 * (k + this.nv)] = 1 - u / W;
        uv[2 * (k + this.nv) + 1] = j / segV;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < segV; j++) {
      for (let i = 0; i < segU; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols + 1;
        const d = a + cols;
        idx.push(a, b, c, a, c, d);
      }
    }
    const nIdx = idx.length;
    for (let t = 0; t < nIdx; t += 3) {
      // back face: same grid, reversed winding
      idx.push(idx[t] + this.nv, idx[t + 2] + this.nv, idx[t + 1] + this.nv);
    }
    this.pos = new Float32Array(this.nv * 2 * 3);
    this.nor = new Float32Array(this.nv * 2 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.addGroup(0, nIdx, 0);
    g.addGroup(nIdx, nIdx, 1);
    // A fixed bound, set eagerly: the spine is fixed and paper cannot stretch, so every point stays
    // within hypot(W, H/2) of the spine's centre. If it were left null, three.js would compute one
    // lazily from whatever the vertices hold at that moment — for a sheet that is still hidden and
    // never posed, a zero-radius sphere it then keeps for ever: every raycast misses the sheet and it
    // is culled whenever the spine leaves the screen.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Math.hypot(W, H / 2) + 0.01);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, [front, back]);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData.sheetMesh = this;
  }

  /** Number of front-face triangles (raycast faceIndex below this → front). */
  get frontFaceCount(): number {
    return (this.geometry.index!.count / 2 / 3) | 0;
  }

  /** Deforms the mesh to configuration q = (p, ψ_0, …, ψ_{K−1}). */
  update(q: ArrayLike<number>, pivotZ: number): void {
    const R = RENDER_REFINE;
    const ang = this.angles;
    ang[0] = q[1];
    for (let k = 1; k < this.K; k++) {
      const a = q[1 + k] / R;
      for (let r = 0; r < R; r++) ang[1 + (k - 1) * R + r] = a;
    }
    const chain = this.chain;
    const p = q[0];
    chain.update(p, ang, pivotZ);
    const Rm = chain.R;
    const t = chain.t;
    const dr = chain.delta;
    const last = chain.nStrips - 1;
    const { pos, nor, us, vs, nv, half } = this;
    for (let k = 0; k < nv; k++) {
      const u = us[k];
      const v = vs[k];
      const x = u / (1 + p * v) / dr;
      let s = Math.floor(x + 0.5);
      s = s < 0 ? 0 : s > last ? last : s;
      const r = 9 * s;
      const X = Rm[r] * u + Rm[r + 1] * v + t[3 * s];
      const Y = Rm[r + 3] * u + Rm[r + 4] * v + t[3 * s + 1];
      const Z = Rm[r + 6] * u + Rm[r + 7] * v + t[3 * s + 2];
      // blended normal between neighbouring sub-strip centres
      let j0 = Math.floor(x);
      let w = x - j0;
      if (j0 < 0) {
        j0 = 0;
        w = 0;
      } else if (j0 >= last) {
        j0 = last;
        w = 0;
      }
      const a = 9 * j0;
      const b = 9 * Math.min(j0 + 1, last);
      let nx = (1 - w) * Rm[a + 2] + w * Rm[b + 2];
      let ny = (1 - w) * Rm[a + 5] + w * Rm[b + 5];
      let nz = (1 - w) * Rm[a + 8] + w * Rm[b + 8];
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const o = 3 * k;
      const ob = 3 * (k + nv);
      pos[o] = X + nx * half;
      pos[o + 1] = Y + ny * half;
      pos[o + 2] = Z + nz * half;
      nor[o] = nx;
      nor[o + 1] = ny;
      nor[o + 2] = nz;
      pos[ob] = X - nx * half;
      pos[ob + 1] = Y - ny * half;
      pos[ob + 2] = Z - nz * half;
      nor[ob] = -nx;
      nor[ob + 1] = -ny;
      nor[ob + 2] = -nz;
    }
    const g = this.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.boundingSphere!.center.set(0, 0, pivotZ);
  }

  /**
   * The face of this sheet that lies against its stack (the back face of a sheet
   * resting on the right, the front face of one on the left), moved a further
   * `gap` away from the sheet along the normal. It uses the same grid, and so the
   * same triangulation, as the rendered faces: the result is exactly parallel to
   * the sheet triangle by triangle, so no chord of one surface can cross a chord
   * of the other however the sheet curls (the sagitta cancels). Book coordinates;
   * `normals` point back towards the sheet. Call after `update`.
   */
  stackFace(side: 'L' | 'R', gap: number): FaceGrid {
    const { pos, nor, nv } = this;
    const positions = new Float32Array(nv * 3);
    const normals = new Float32Array(nv * 3);
    const s = side === 'R' ? -1 : 1; // from the sheet towards its stack, along the front normal
    const base = side === 'R' ? nv : 0; // back-face vertices follow the front-face ones
    for (let k = 0; k < nv; k++) {
      const o = 3 * k;
      const b = 3 * (k + base);
      for (let c = 0; c < 3; c++) {
        positions[o + c] = pos[b + c] + s * nor[o + c] * gap;
        normals[o + c] = -s * nor[o + c];
      }
    }
    return { positions, normals, cols: this.cols, rows: this.rows };
  }

  /** Mirrors the print on both faces (for books drawn through a mirror, i.e. right-to-left). */
  setPrintFlipped(flip: boolean): void {
    this.front.userData.paper.uFlipPrint.value = flip ? 1 : 0;
    this.back.userData.paper.uFlipPrint.value = flip ? 1 : 0;
  }

  /** Material coordinates (u, v) of a raycast hit on this mesh. */
  materialCoords(hit: THREE.Intersection): { u: number; v: number } | null {
    if (!hit.uv) return null;
    const isFront = (hit.faceIndex ?? 0) < this.frontFaceCount;
    const s = isFront ? hit.uv.x : 1 - hit.uv.x;
    return { u: s * this.dims.W, v: (hit.uv.y - 0.5) * this.dims.H };
  }

  dispose(): void {
    this.geometry.dispose();
    this.front.dispose();
    this.back.dispose();
  }
}
