import * as THREE from 'three';
import {
  linenTextures,
  endpaperTexture,
  pageEdgeTexture,
  boardInsideTexture,
  coverArt,
  type CoverKind,
  type StampedArt,
} from './proceduralTextures';
import { pageBlockGeometry, type FaceGrid } from './pageBlock';

const BOARD_T = 0.0024;
const OVERHANG = 0.003;
const HINGE_GAP = 0.0035;
/** Weave repeats per metre of cloth (64 threads per repeat ≈ 0.26 mm thread pitch). */
const CLOTH_TILES_PER_M = 60;

interface Cover {
  kind: CoverKind;
  width: number;
  height: number;
  material: THREE.MeshStandardMaterial;
  art: StampedArt | null;
}

/**
 * Static parts of the book: cloth-covered boards with stamped exteriors (the
 * same Explica binding for every document), the spine, and the two page blocks
 * under the resting top sheets.
 *
 * The board of the left (verso) stack is the front cover in both reading
 * directions: an RTL book is drawn mirrored, so it then shows on the right,
 * as an RTL front cover should.
 */
export class BookBody {
  readonly group = new THREE.Group();
  private readonly edgeMat: THREE.MeshStandardMaterial;
  private readonly blockTopMat: THREE.MeshStandardMaterial;
  private readonly blocks: Record<'L' | 'R', { top: THREE.Mesh | null; walls: THREE.Mesh } | null> = { L: null, R: null };
  /** Boards and spine: solid parts that hide whatever lies behind them from the pointer. */
  private readonly solids: THREE.Mesh[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly covers: Cover[] = [];
  private readonly cloth: THREE.Color;
  private rtl = false;

  constructor(
    readonly W: number,
    readonly H: number,
    totalThickness: number,
    opts: { clothColor?: string; rtl?: boolean } = {},
  ) {
    const clothColor = opts.clothColor ?? '#21404e';
    this.cloth = new THREE.Color(clothColor);
    this.rtl = !!opts.rtl;
    const linen = linenTextures(this.cloth);
    // the thin board edges: plain cloth, UVs in weave repeats (see clothUVs)
    const cloth = new THREE.MeshStandardMaterial({
      map: linen.map,
      normalMap: linen.normalMap,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.86,
      metalness: 0,
    });
    this.weave = linen.normalMap;
    const endpaper = endpaperTexture();
    const edge = pageEdgeTexture();
    edge.repeat.set(1, 1);
    this.edgeMat = new THREE.MeshStandardMaterial({ map: edge, roughness: 0.92, color: 0xfffaf0 });
    // The block's top is never meant to be seen: it is a copy of the resting top sheet's underside,
    // BLOCK_GAP further down, and is pushed well back in depth too (the slope factor covers grazing
    // views, the units cover face-on views where the slope term vanishes).
    this.blockTopMat = new THREE.MeshStandardMaterial({
      color: 0xf3ede1,
      roughness: 0.95,
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 32,
    });
    this.disposables.push(linen.map, linen.normalMap, cloth, endpaper, edge, this.edgeMat, this.blockTopMat);

    const bw = W + OVERHANG + HINGE_GAP * 0.5;
    const bh = H + 2 * OVERHANG;
    const boardGeo = new THREE.BoxGeometry(bw, bh, BOARD_T);
    clothUVs(boardGeo, bw, bh, BOARD_T);
    this.disposables.push(boardGeo);
    for (const side of [1, -1]) {
      const insideTex = boardInsideTexture(bw, bh, side > 0, this.cloth, endpaper);
      const inside = new THREE.MeshStandardMaterial({ map: insideTex, roughness: 0.88 });
      this.disposables.push(insideTex, inside);
      // the right (recto-side) board is the back cover, the left one the front cover
      const outside = this.addCover(side > 0 ? 'back' : 'front', bw, bh);
      // BoxGeometry material order: +x, −x, +y, −y, +z (inside), −z (outside)
      const board = new THREE.Mesh(boardGeo, [cloth, cloth, cloth, cloth, inside, outside]);
      board.position.set(side * (HINGE_GAP * 0.5 + bw / 2), 0, -BOARD_T / 2);
      board.receiveShadow = true;
      board.castShadow = true;
      this.group.add(board);
      this.solids.push(board);
    }
    // spine: a rounded cloth band beneath the binding
    const r = Math.max(totalThickness * 0.5, 0.004);
    const spineGeo = new THREE.CylinderGeometry(r, r, bh, 24, 1, true, Math.PI / 2, Math.PI);
    this.disposables.push(spineGeo);
    // arc length of the half-ellipse it is squashed into (semi-axes r and r/2)
    const spineWidth = 2.42 * r;
    const spine = new THREE.Mesh(spineGeo, this.addCover('spine', spineWidth, bh));
    spine.rotation.set(0, 0, 0);
    spine.scale.set(1, 1, 0.5);
    spine.position.set(0, 0, -BOARD_T * 0.6);
    spine.castShadow = true;
    this.group.add(spine);
    this.solids.push(spine);
  }

  private readonly weave: THREE.Texture;

  /** A stamped exterior face (cover or spine) with its weave tiled at true size. */
  private addCover(kind: CoverKind, width: number, height: number): THREE.MeshStandardMaterial {
    const weave = this.weave.clone();
    weave.repeat.set(width * CLOTH_TILES_PER_M, height * CLOTH_TILES_PER_M);
    weave.needsUpdate = true;
    const material = new THREE.MeshStandardMaterial({
      normalMap: weave,
      normalScale: new THREE.Vector2(0.35, 0.35),
      roughness: 1, // scaled by the art's roughness map
      metalness: 1, // scaled by the art's metalness map: only the gilt is metal
    });
    this.disposables.push(weave, material);
    const cover: Cover = { kind, width, height, material, art: null };
    this.covers.push(cover);
    this.paintCover(cover);
    return material;
  }

  private paintCover(c: Cover): void {
    // seen from outside, the front cover's spine edge is on the left, the back cover's on the
    // right; an RTL book is drawn mirrored with its print flipped back, so they swap
    const spineLeft = (c.kind === 'front') !== this.rtl;
    const art = coverArt({
      width: c.width,
      height: c.height,
      cloth: this.cloth,
      kind: c.kind,
      spineSide: spineLeft ? 'left' : 'right',
    });
    for (const t of [art.map, art.orm]) {
      // un-mirror the print of a mirrored (RTL) book
      t.repeat.x = this.rtl ? -1 : 1;
      t.offset.x = this.rtl ? 1 : 0;
    }
    c.art?.map.dispose();
    c.art?.orm.dispose();
    c.art = art;
    c.material.map = art.map;
    c.material.roughnessMap = art.orm;
    c.material.metalnessMap = art.orm;
    c.material.needsUpdate = true;
  }

  /** Redraws the exterior for a reading direction (RTL books are drawn through a mirror). */
  setPrintFlipped(rtl: boolean): void {
    if (rtl === this.rtl) return;
    this.rtl = rtl;
    for (const c of this.covers) this.paintCover(c);
  }

  /**
   * Meshes that block the pointer: boards, spine and the page blocks' walls. A ray
   * that meets one of these before a page must not reach the page (a book seen
   * from behind is turned by its cover, not through it).
   */
  get occluders(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [...this.solids];
    for (const b of Object.values(this.blocks)) if (b) out.push(b.walls);
    return out;
  }

  /**
   * Rebuilds the page block under the resting top sheet of one side, from that
   * sheet's stack-facing face: `top` = `stackFace(side, BLOCK_GAP)`,
   * `edge` = `stackFace(side, 0)` (see pageBlock.ts). Null removes the block.
   */
  setBlock(side: 'L' | 'R', top: FaceGrid | null, edge: FaceGrid | null): void {
    const old = this.blocks[side];
    if (old) {
      for (const m of [old.top, old.walls]) {
        if (!m) continue;
        this.group.remove(m);
        m.geometry.dispose();
      }
      this.blocks[side] = null;
    }
    if (!top || !edge) return;
    const geo = pageBlockGeometry(top, edge, side);
    let topMesh: THREE.Mesh | null = null;
    if (geo.top) {
      topMesh = new THREE.Mesh(geo.top, this.blockTopMat);
      topMesh.receiveShadow = true;
      topMesh.castShadow = true;
      // always under the sheet it copies: never the first thing a pointer ray meets
      topMesh.raycast = () => {};
      this.group.add(topMesh);
    }
    const walls = new THREE.Mesh(geo.walls, this.edgeMat);
    walls.receiveShadow = true;
    walls.castShadow = true;
    this.group.add(walls);
    this.blocks[side] = { top: topMesh, walls };
  }

  dispose(): void {
    for (const s of ['L', 'R'] as const) this.setBlock(s, null, null);
    for (const c of this.covers) {
      c.art?.map.dispose();
      c.art?.orm.dispose();
    }
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * Gives the board's thin edge faces (BoxGeometry faces 0–3: ±x, ±y) UVs measured
 * in weave repeats, so the cloth keeps its true scale on a 2.4 mm edge as on the
 * cover. Faces 4–5 (inside and outside) keep 0–1 for their artwork.
 */
function clothUVs(geo: THREE.BoxGeometry, w: number, h: number, d: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry builds ±x faces spanning (depth, height) and ±y faces spanning (width, depth), 4 vertices each
  const spans: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
  ];
  spans.forEach(([su, sv], f) => {
    for (let k = 4 * f; k < 4 * f + 4; k++) {
      uv.setXY(k, uv.getX(k) * su * CLOTH_TILES_PER_M, uv.getY(k) * sv * CLOTH_TILES_PER_M);
    }
  });
  uv.needsUpdate = true;
}
