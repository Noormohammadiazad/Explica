import * as THREE from 'three';
import { Stage } from './render/stage';
import { SheetMesh } from './render/sheetMesh';
import { BookBody } from './render/bookBody';
import { createPaperMaterial, type PaperMaterial } from './render/paperMaterial';
import { blankPageTexture, paperFibreNormalMap } from './render/proceduralTextures';
import { ViewController } from './view/viewController';
import { InputController } from './input/inputController';
import type { Effect, Hit } from './input/gestures';
import { pickSheet, type RayHit } from './input/pick';
import { BLOCK_GAP } from './render/pageBlock';
import { ArcDragSurface, PlaneDragSurface, clampReach, type DragSurface, type Vec3 } from './input/dragSurface';
import { BookLayout, type Side } from './book/bookLayout';
import { AutoTurn, AUTO_GRAB } from './book/autoTurn';
import { mirrorSign, toBookFrame, turnForKey, type ReadingDirection } from './book/readingDirection';
import type { Theme } from './ui/theme';
import { SheetSim, type SheetEnvironment } from './physics/sheetSim';
import { restConfiguration } from './physics/rest';
import { staticEquilibrium } from './physics/equilibrium';
import { HingeChain } from './physics/hingeChain';
import { DEFAULT_PAPER, PHYSICS_STRIPS, type PaperParams, type SheetDims } from './physics/params';
import type { StackSurface } from './physics/surface';
import type { PageSource } from './pdf/pageSource';
import { TextureManager, contentRect, type PageTexture } from './pdf/textureManager';
import type { TextRun } from './pdf/pageSource';
import { TextLayer, type PageProjection } from './ui/textLayer';
import { AnnotationStore, browserStorage } from './annotate/store';
import { AnnotationTextures } from './annotate/textures';
import {
  HIGHLIGHT_COLORS,
  PEN_COLORS,
  PEN_WIDTHS,
  annotationsAt,
  newId,
  quadsOverlap,
  simplify,
  type Note,
  type Stroke,
  type Tool,
} from './annotate/model';

const H_STEP = 1 / 240;
const MAX_SUBSTEPS = 10;
const MAX_FLYING = 12;
const SHEET_THICKNESS_RENDER = 0.00011;
const PT_TO_M = 0.0254 / 72;

interface HandCtl {
  u: number;
  v: number;
  surface: DragSurface;
  reach: number;
  y0: number;
  pointer: { x: number; y: number } | null;
  auto: AutoTurn | null;
  target: Vec3;
  prev: Vec3;
  vel: Vec3;
}

interface FlyingSheet {
  sheet: number;
  from: Side;
  sim: SheetSim;
  mesh: SheetMesh;
  hand: HandCtl | null;
  calm: number;
  stuck: number;
  blend: { t: number; from: Float64Array; to: Float64Array; side: Side } | null;
}

interface Doc {
  source: PageSource;
  layout: BookLayout;
  dims: SheetDims;
  body: BookBody;
  textures: TextureManager;
  resting: Record<Side, SheetMesh>;
  restCache: Map<string, Float64Array>;
  profileCache: Map<string, { xs: Float64Array; zs: Float64Array }>;
  detailCommit: Map<string, { rect: THREE.Vector4; w: number; h: number }>;
  /** Text runs and page size per page, for the text layer (loaded on demand). */
  text: Map<number, Promise<{ runs: TextRun[]; w: number; h: number }>>;
  /** Page sizes [pt] learned while loading text. */
  sizes: Map<number, { w: number; h: number }>;
  /** The reader's annotations of this document, and their page textures. */
  notes: AnnotationStore;
  marks: AnnotationTextures;
}

export interface SpreadInfo {
  /** First page of the spread in reading order (0-based), or null. */
  verso: number | null;
  /** Second page of the spread in reading order — the one turned next — or null. */
  recto: number | null;
  pageCount: number;
  name: string;
  direction: ReadingDirection;
}

export interface ExplicaOptions {
  /**
   * Element that holds the selectable copy of the page text (style it with
   * `.text-layer`, as `explica/style.css` does). Default: the element with id
   * `textLayer`, else a new `div.text-layer` placed right after the canvas.
   */
  textLayer?: HTMLElement;
}

export interface FrameStats {
  flying: number;
  stepMs: number;
  iterations: number;
  textureMB: number;
}

/** Wires physics, rendering, input and page rasterisation together. */
export class ExplicaApp {
  readonly stage: Stage;
  readonly view = new ViewController();
  readonly input: InputController;
  private doc: Doc | null = null;
  private readonly flying = new Map<number, FlyingSheet>();
  private readonly pool: SheetMesh[] = [];
  private readonly blank = blankPageTexture();
  private readonly fibre = paperFibreNormalMap();
  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpChain = { chain: null as HingeChain | null };
  private paper: PaperParams = DEFAULT_PAPER;
  private airScale = 1;
  private dir: ReadingDirection = 'ltr';
  gravityFollowsBook = true;
  private dirty = true;
  private last = 0;
  private acc = 0;
  private pendingTurns = 0;
  private turnCooldown = 0;
  private lastClick = { t: -1, x: 0, y: 0 };
  private stableFor = 0;
  private readonly gravity: [number, number, number] = [0, 0, -9.81];
  readonly stats: FrameStats = { flying: 0, stepMs: 0, iterations: 0, textureMB: 0 };

  onSpread: (s: SpreadInfo) => void = () => {};
  onKeyCommand: (cmd: string) => void = () => {};
  /** The text selection changed: its text ('' when cleared) and where it ends on screen. */
  onTextSelection: (text: string, at: { x: number; y: number } | null) => void = () => {};
  readonly textLayer: TextLayer;
  /** Pose the text layer was last placed for ('' = needs placing). */
  private textPose = '';
  private textLoading = '';

  // ---- annotation
  /** Active tool. In 'read' every gesture keeps its reading meaning. */
  tool: Tool = 'read';
  highlightColor: string = HIGHLIGHT_COLORS[0].value;
  penColor: string = PEN_COLORS[0].value;
  penWidth: number = PEN_WIDTHS[1].value;
  onToolChange: (t: Tool) => void = () => {};
  /** Undo/redo availability changed. */
  onHistory: (canUndo: boolean, canRedo: boolean) => void = () => {};
  /** A note's editor opens (note) or closes (null). */
  onNoteOpen: (note: Note | null, at: { x: number; y: number } | null) => void = () => {};
  /** The open note's anchor moved on screen (null: not visible). */
  onNoteMove: (at: { x: number; y: number } | null) => void = () => {};
  /** The pointer rests on a note's mark (null: on none). */
  onNotePeek: (note: Note | null, at: { x: number; y: number } | null) => void = () => {};
  onStorageError: () => void = () => {};
  private openNote: string | null = null;
  private noteAt = '';
  private pen: { page: number; stroke: Stroke } | null = null;
  private erasing = false;

  /** Listeners on the window and canvas, detached together by dispose(). */
  private readonly listening = new AbortController();
  private raf = 0;
  private disposed = false;
  /** The text layer element, when this app created it (dispose removes it). */
  private readonly ownTextLayer: HTMLElement | null = null;

  constructor(canvas: HTMLCanvasElement, opts: ExplicaOptions = {}) {
    this.stage = new Stage(canvas);
    let tl = opts.textLayer ?? document.getElementById('textLayer');
    if (!tl) {
      tl = document.createElement('div');
      tl.className = 'text-layer';
      tl.setAttribute('aria-label', 'Text of the open pages');
      canvas.after(tl);
      this.ownTextLayer = tl;
    }
    this.textLayer = new TextLayer(tl);
    this.fibre.repeat.set(5, 7);
    this.stage.resize();
    this.input = new InputController(canvas, {
      hitTest: (x, y) => this.hitTest(x, y),
      effect: (e, t) => this.onEffect(e, t),
      zoom: (f, x, y) => this.zoomAt(f, x, y),
      pan: (dx, dy) => {
        this.view.panBy(dx, dy, this.stage.camera, this.cssHeight);
        this.dirty = true;
      },
      hover: (x, y) => {
        const h = this.hitTest(x, y);
        this.peekNote(x, y);
        if (h.kind === 'sheet' && h.annotate) return TOOL_CURSOR[this.tool];
        return h.kind === 'sheet' ? 'grab' : 'default';
      },
      key: (e) => this.onKey(e),
    });
    const signal = this.listening.signal;
    window.addEventListener('resize', () => (this.dirty = true), { signal });
    canvas.addEventListener(
      'webglcontextlost',
      (e) => {
        e.preventDefault();
        this.onKeyCommand('context-lost');
      },
      { signal },
    );
    this.raf = requestAnimationFrame(this.frame);
  }

  /**
   * Stops the app for good: ends the frame loop, detaches every listener, closes
   * the document (destroying its source) and frees the GPU resources and the
   * WebGL context. The canvas is left blank; a new ExplicaApp needs a new canvas.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.restTimer);
    this.listening.abort();
    this.input.dispose();
    this.unload();
    this.textLayer.build('', []);
    this.ownTextLayer?.remove();
    this.blank.dispose();
    this.fibre.dispose();
    this.stage.dispose();
  }

  private get cssHeight(): number {
    return Math.max(1, this.stage.canvas.clientHeight);
  }

  // ================================================================== documents

  /**
   * Opens a document as the book, replacing (and destroying) the one before.
   * The app owns `source` from here on and destroys it in turn.
   */
  async load(source: PageSource): Promise<void> {
    if (this.disposed) throw new Error('Explica: this ExplicaApp has been disposed');
    this.unload();
    // nothing in progress may outlive the document it referred to
    this.input.reset();
    this.lastClick = { t: -1, x: 0, y: 0 };
    source.setReadingDirection?.(this.dir);
    const ptToM = PT_TO_M;
    let W = source.baseSize.w * ptToM;
    let H = source.baseSize.h * ptToM;
    // keep posters and postage stamps in a hand-holdable range
    const scale = Math.min(Math.max(H, 0.11), 0.36) / H;
    W *= scale;
    H *= scale;
    const width = Math.min(Math.max(W, 0.06), 0.42);
    const dims = { W: width, H };
    const layout = new BookLayout(source.pageCount, dims.W);
    const body = new BookBody(dims.W, dims.H, layout.totalThickness, { rtl: this.dir === 'rtl' });
    this.stage.bookRoot.add(body.group);
    const textures = new TextureManager(this.stage.renderer, source, dims.W / dims.H, () => (this.dirty = true));
    const doc: Doc = {
      source,
      layout,
      dims,
      body,
      textures,
      resting: { L: this.createMesh(dims), R: this.createMesh(dims) },
      restCache: new Map(),
      profileCache: new Map(),
      detailCommit: new Map(),
      text: new Map(),
      sizes: new Map(),
      notes: new AnnotationStore(source.key ?? `name:${source.name}`, browserStorage()),
      marks: null as unknown as AnnotationTextures,
    };
    const caps = this.stage.renderer.capabilities;
    doc.marks = new AnnotationTextures(
      doc.notes,
      (p) => this.pageAspect(p),
      caps.maxTextureSize >= 4096 ? 2048 : 1024,
      caps.getMaxAnisotropy(),
    );
    doc.notes.onChange = (pages) => {
      doc.marks.invalidate(pages);
      this.dirty = true;
      this.onHistory(doc.notes.canUndo, doc.notes.canRedo);
    };
    doc.notes.onError = () => this.onStorageError();
    this.doc = doc;
    this.setTool('read');
    this.onHistory(false, false);
    for (const s of ['L', 'R'] as const) {
      this.setResting(doc.resting[s], true);
      this.stage.bookRoot.add(doc.resting[s].mesh);
    }
    this.tmpChain.chain = new HingeChain(dims.W, dims.H, PHYSICS_STRIPS - 1, dims.W / (PHYSICS_STRIPS - 1));
    this.stage.resize();
    this.frameBook(false);
    this.refreshResting();
    this.dirty = true;
  }

  private wasPortrait = false;

  private frameBook(animate: boolean): void {
    const d = this.doc!.dims;
    this.wasPortrait = this.stage.camera.aspect < 0.8;
    this.view.frame(2 * d.W + 0.012, d.H + 0.012, this.stage.camera, animate, mirrorSign(this.dir));
  }

  private unload(): void {
    const doc = this.doc;
    if (!doc) return;
    for (const f of this.flying.values()) this.releaseMesh(f.mesh);
    this.flying.clear();
    for (const m of [...this.pool, doc.resting.L, doc.resting.R]) {
      this.stage.bookRoot.remove(m.mesh);
      m.dispose();
    }
    this.pool.length = 0;
    this.stage.bookRoot.remove(doc.body.group);
    doc.body.dispose();
    doc.textures.dispose();
    doc.marks.dispose();
    this.pen = null;
    this.closeNote();
    void doc.source.destroy();
    this.pendingTurns = 0;
    this.doc = null;
  }

  get documentName(): string {
    return this.doc?.source.name ?? '';
  }

  // ================================================================== reading direction & theme

  get direction(): ReadingDirection {
    return this.dir;
  }

  /**
   * Switches between left-to-right and right-to-left books. The book frame,
   * layout and physics are shared; an RTL book is the same book drawn through
   * the mirror x ↦ −x with its print flipped back (see readingDirection.ts).
   * The reading position and any page in flight carry over.
   */
  setDirection(d: ReadingDirection): void {
    if (d === this.dir) return;
    this.dir = d;
    this.stage.bookRoot.scale.x = mirrorSign(d);
    for (const m of this.allMeshes()) m.setPrintFlipped(d === 'rtl');
    const doc = this.doc;
    if (doc) {
      doc.detailCommit.clear();
      doc.body.setPrintFlipped(d === 'rtl');
      if (doc.source.setReadingDirection?.(d)) doc.textures.refresh();
      // portrait framing shows the page read next, which has changed sides
      if (this.stage.camera.aspect < 0.8) this.frameBook(true);
      this.emitSpread();
    }
    this.dirty = true;
  }

  /** Blends the scene's backdrop lighting and shadows to a colour theme. */
  setTheme(t: Theme, animate = true): void {
    this.stage.setTheme(t, animate);
    this.dirty = true;
  }

  // ================================================================== meshes

  private createMesh(dims: SheetDims): SheetMesh {
    const flipPrint = this.dir === 'rtl';
    const mk = (mirror: boolean): PaperMaterial =>
      createPaperMaterial({ blank: this.blank, fibre: this.fibre, mirror, pageWidth: dims.W, flipPrint });
    return new SheetMesh(dims, PHYSICS_STRIPS, SHEET_THICKNESS_RENDER, mk(false), mk(true));
  }

  private acquireMesh(): SheetMesh {
    const doc = this.doc!;
    const m = this.pool.pop() ?? this.createMesh(doc.dims);
    this.setResting(m, false);
    m.mesh.visible = true;
    if (!m.mesh.parent) this.stage.bookRoot.add(m.mesh);
    return m;
  }

  private allMeshes(): SheetMesh[] {
    const out = [...this.pool];
    for (const f of this.flying.values()) out.push(f.mesh);
    if (this.doc) out.push(this.doc.resting.L, this.doc.resting.R);
    return out;
  }

  private releaseMesh(m: SheetMesh): void {
    m.mesh.visible = false;
    m.sheet = -1;
    this.pool.push(m);
  }

  /**
   * Resting sheets get a tiny constant depth bias (units only — a slope factor would
   * exceed the 0.1 mm sheet spacing at grazing angles) so a sheet lifting off wins near the spine.
   */
  private setResting(m: SheetMesh, resting: boolean): void {
    for (const mat of [m.front, m.back]) {
      mat.polygonOffset = resting;
      mat.polygonOffsetFactor = 0;
      mat.polygonOffsetUnits = resting ? 3 : 0;
    }
  }

  // ================================================================== geometry helpers

  /** Resting pose of a sheet on a stack: the simulator's own static equilibrium (cached). */
  private rest(sheet: number, side: Side): Float64Array {
    const doc = this.doc!;
    const key = `${sheet}:${side}`;
    let q = doc.restCache.get(key);
    if (!q) {
      const surf = doc.layout.surfaceFor(sheet, side);
      const guess = restConfiguration(doc.dims.W, PHYSICS_STRIPS, surf, side === 'R' ? 1 : -1, doc.layout.pivotZ);
      const env = { ...this.envFor(sheet, false), gravity: [0, 0, -9.81] as [number, number, number] };
      q = staticEquilibrium(doc.dims, this.paper, env, guess, PHYSICS_STRIPS);
      doc.restCache.set(key, q);
    }
    return q;
  }

  /**
   * Environment of a sheet: both stack surfaces, and — for sheets in flight —
   * the actual resting shape of the sheet directly beneath on each side
   * (sheet-on-sheet contact).
   */
  private envFor(sheet: number, withProfiles = true): SheetEnvironment {
    const l = this.doc!.layout;
    const right = l.surfaceFor(sheet, 'R');
    const left = l.surfaceFor(sheet, 'L');
    if (withProfiles) {
      if (sheet + 1 < l.sheetCount && l.sideOf(sheet + 1) === 'R') this.attachProfile(right, sheet + 1, 'R');
      if (sheet - 1 >= 0 && l.sideOf(sheet - 1) === 'L') this.attachProfile(left, sheet - 1, 'L');
    }
    return { gravity: this.gravity, pivotZ: l.pivotZ, right, left };
  }

  /** Adds the cross-section of resting sheet `below` (raised by one sheet thickness) to a surface. */
  private attachProfile(surf: StackSurface, below: number, side: Side): void {
    const doc = this.doc!;
    const key = `${below}:${side}`;
    let prof = doc.profileCache.get(key);
    if (!prof) {
      const q = this.rest(below, side);
      const chain = this.tmpChain.chain!;
      chain.update(q[0], q.subarray(1), doc.layout.pivotZ);
      const K = PHYSICS_STRIPS;
      const xs = new Float64Array(K + 1);
      const zs = new Float64Array(K + 1);
      const P = new Float64Array(3);
      const lift = doc.layout.sheetThickness + 0.00004;
      for (let j = 0; j <= K; j++) {
        const u = j === K ? doc.dims.W : chain.hingeSigma(j);
        chain.point(u, 0, P);
        xs[j] = Math.abs(P[0]);
        zs[j] = P[2] + lift;
      }
      for (let j = 1; j <= K; j++) xs[j] = Math.max(xs[j], xs[j - 1]);
      prof = { xs, zs };
      doc.profileCache.set(key, prof);
    }
    surf.profileX = prof.xs;
    surf.profileZ = prof.zs;
  }

  private refreshResting(): void {
    const doc = this.doc;
    if (!doc) return;
    const { layout } = doc;
    for (const side of ['L', 'R'] as const) {
      const i = side === 'L' ? layout.topLeft() : layout.topRight();
      const m = doc.resting[side];
      if (i < 0) {
        m.mesh.visible = false;
        m.sheet = -1;
        doc.body.setBlock(side, null, null);
        continue;
      }
      const q = this.rest(i, side);
      m.sheet = i;
      m.update(q, layout.pivotZ);
      m.mesh.visible = true;
      // the block beneath is built from this sheet's own rendered underside (see pageBlock.ts)
      if (layout.stackHeightUnder(i, side) > 0) doc.body.setBlock(side, m.stackFace(side, BLOCK_GAP), m.stackFace(side, 0));
      else doc.body.setBlock(side, null, null);
    }
    this.dirty = true;
    this.emitSpread();
  }

  private emitSpread(): void {
    const doc = this.doc;
    if (!doc) return;
    // book-frame left is always the verso: the mirror only moves it on screen
    const v = doc.layout.readingSpread();
    this.onSpread({
      verso: v.left,
      recto: v.right,
      pageCount: doc.layout.pageCount,
      name: doc.source.name,
      direction: this.dir,
    });
  }

  // ================================================================== picking

  private ndc(x: number, y: number): THREE.Vector2 {
    const c = this.stage.canvas;
    return new THREE.Vector2((x / c.clientWidth) * 2 - 1, -(y / c.clientHeight) * 2 + 1);
  }

  private sheetMeshes(): SheetMesh[] {
    const doc = this.doc;
    if (!doc) return [];
    const out: SheetMesh[] = [];
    for (const f of this.flying.values()) out.push(f.mesh);
    for (const s of ['L', 'R'] as const) if (doc.resting[s].mesh.visible) out.push(doc.resting[s]);
    return out;
  }

  private hitTest(x: number, y: number): Hit {
    const doc = this.doc;
    if (!doc) return { kind: 'background' };
    this.raycaster.setFromCamera(this.ndc(x, y), this.stage.camera);
    // pages, and everything solid that can stand in front of them
    const targets = [...this.sheetMeshes().map((m) => m.mesh), ...doc.body.occluders];
    const hits = this.raycaster.intersectObjects(targets, false);
    const dir = this.raycaster.ray.direction;
    const toWorld = new THREE.Matrix3();
    const rayHits: RayHit[] = hits.map((h) => {
      // the face's outward normal in the world (the normal matrix keeps it outward for the mirrored RTL book)
      const n = h.face?.normal.clone().applyNormalMatrix(toWorld.getNormalMatrix(h.object.matrixWorld));
      const facesRay = !n || n.dot(dir) < 0;
      const sm = h.object.userData.sheetMesh as SheetMesh | undefined;
      if (!sm) return { kind: 'occluder', facesRay };
      const face = (h.faceIndex ?? 0) < sm.frontFaceCount ? 'front' : 'back';
      const resting = sm.sheet >= 0 && !doc.layout.isFlying(sm.sheet) ? doc.layout.sideOf(sm.sheet) : null;
      return { kind: 'sheet', sheet: sm.sheet, face, facesRay, resting };
    });
    const k = pickSheet(rayHits, (sheet) => sheet >= 0 && doc.layout.isGrabbable(sheet));
    if (k < 0) return { kind: 'background' };
    const sm = hits[k].object.userData.sheetMesh as SheetMesh;
    const mc = sm.materialCoords(hits[k]);
    if (!mc) return { kind: 'background' };
    const flying = doc.layout.isFlying(sm.sheet);
    const text = !flying && this.textLayer.active && this.textLayer.hasTextAt(x, y);
    // annotation tools work on resting pages, once nothing is in flight
    const annotate = this.tool !== 'read' && !flying && this.flying.size === 0 && this.pendingTurns === 0;
    return { kind: 'sheet', sheet: sm.sheet, u: mc.u, v: mc.v, flying, text, annotate };
  }

  /** Pointer ray in the book frame. */
  private bookRay(x: number, y: number): { o: Vec3; d: Vec3 } {
    this.raycaster.setFromCamera(this.ndc(x, y), this.stage.camera);
    const inv = this.stage.bookRoot.matrixWorld.clone().invert();
    const o = this.raycaster.ray.origin.clone().applyMatrix4(inv);
    const d = this.raycaster.ray.direction.clone().transformDirection(inv);
    return { o: [o.x, o.y, o.z], d: [d.x, d.y, d.z] };
  }

  private zoomAt(factor: number, x: number, y: number): void {
    this.raycaster.setFromCamera(this.ndc(x, y), this.stage.camera);
    let anchor: THREE.Vector3 | null = null;
    // raycasts ignore `visible`: skip pooled sheets and hidden stacks, which hold stale geometry
    const hits = this.raycaster.intersectObject(this.stage.bookRoot, true).filter((h) => shown(h.object));
    if (hits.length) anchor = hits[0].point.clone();
    else {
      const n = new THREE.Vector3(0, 0, 1).transformDirection(this.stage.bookRoot.matrixWorld);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.stage.bookRoot.position);
      const p = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, p)) anchor = p;
    }
    this.view.zoomAt(factor, anchor);
    this.dirty = true;
  }

  // ================================================================== gestures

  private onEffect(e: Effect, now: number): void {
    const doc = this.doc;
    switch (e.type) {
      case 'grab':
        this.clearSelection();
        if (doc) this.grab(e.sheet, e.u, e.v, e.x, e.y);
        break;
      case 'dragTo':
        for (const f of this.flying.values()) if (f.hand && f.hand.pointer) f.hand.pointer = { x: e.x, y: e.y };
        break;
      case 'release':
        for (const f of this.flying.values()) if (f.hand && f.hand.pointer) f.hand = null;
        break;
      case 'tap':
        this.clearSelection();
        if (doc && !doc.layout.isFlying(e.sheet)) this.turn(doc.layout.sideOf(e.sheet) === 'R' ? 1 : -1);
        break;
      case 'selectStart':
        this.textLayer.selectWordAt(e.x, e.y);
        break;
      case 'selectTo':
        this.textLayer.extendTo(e.x, e.y);
        break;
      case 'selectEnd':
        this.onTextSelection(this.textLayer.selectedText, this.textLayer.selectionEnd());
        break;
      case 'annotateStart':
        this.annotateStart(e.x, e.y);
        break;
      case 'annotateTo':
        this.annotateTo(e.x, e.y);
        break;
      case 'annotateEnd':
        this.annotateEnd(e.x, e.y);
        break;
      case 'click': {
        const dbl = e.t - this.lastClick.t < 0.33 && Math.hypot(e.x - this.lastClick.x, e.y - this.lastClick.y) < 8;
        this.lastClick = { t: dbl ? -1 : e.t, x: e.x, y: e.y };
        if (dbl) this.view.reset(true);
        break;
      }
      case 'orbit':
        this.view.orbit(e.dx, e.dy, now);
        break;
      case 'orbitEnd':
        this.view.endOrbit(now);
        break;
      case 'pan':
        this.view.pan(e.dx, e.dy, this.stage.camera, this.cssHeight, now);
        break;
      case 'panEnd':
        this.view.endPan(now);
        break;
      case 'pinch':
        this.zoomAt(e.scale, e.cx, e.cy);
        this.view.roll(e.twist);
        this.view.panBy(e.dx, e.dy, this.stage.camera, this.cssHeight);
        break;
      case 'pinchEnd':
        break;
    }
    this.dirty = true;
  }

  private onKey(e: KeyboardEvent): boolean {
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && (k === 'z' || k === 'Z' || k === 'y' || k === 'Y')) {
      if (k === 'y' || k === 'Y' || e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if ((e.metaKey || e.ctrlKey) && (k === 'a' || k === 'A') && this.textLayer.active) {
      // select the text of the visible spread (⌘/Ctrl+C then copies it)
      if (this.textLayer.selectAll()) this.onTextSelection(this.textLayer.selectedText, this.textLayer.selectionEnd());
      return true;
    }
    if (e.metaKey || e.ctrlKey) return false; // ⌘/Ctrl+C and friends keep their browser meaning
    if (k === 'Escape' && this.textLayer.selectedText) {
      this.clearSelection();
      return false;
    }
    if (k === 'Escape' && this.tool !== 'read') {
      this.setTool('read');
      return false;
    }
    if (!e.altKey && !e.shiftKey && TOOL_KEYS[k.toLowerCase()]) return this.setTool(TOOL_KEYS[k.toLowerCase()]), true;
    const dir = turnForKey(k, this.dir);
    if (dir !== 0) return this.turn(dir), true;
    if (k === 'Home') return this.jumpTo(0), true;
    if (k === 'End') return this.jumpTo((this.doc?.layout.pageCount ?? 1) - 1), true;
    if (k === '+' || k === '=') return this.zoomCenter(1.3), true;
    if (k === '-' || k === '_') return this.zoomCenter(1 / 1.3), true;
    if (k === '0') return this.view.reset(true), (this.dirty = true), true;
    if (k === 'f' || k === 'F') return this.onKeyCommand('fullscreen'), true;
    if (k === '?') return this.onKeyCommand('help'), true;
    if (k === 'o' || k === 'O') return this.onKeyCommand('open'), true;
    return false;
  }

  private zoomCenter(f: number): void {
    const c = this.stage.canvas;
    this.zoomAt(f, c.clientWidth / 2, c.clientHeight / 2);
  }

  /** Picks up sheet `sheet` at material point (u, v). */
  private grab(sheet: number, u: number, v: number, x: number, y: number): void {
    const doc = this.doc!;
    let f = this.flying.get(sheet);
    let midAir = true;
    if (!f) {
      if (this.flying.size >= MAX_FLYING) return;
      f = this.liftOff(sheet);
      midAir = false;
    }
    if (f.blend) {
      // caught while settling: continue from the blended pose, at rest
      f.sim.setState(lerpQ(f.blend.from, f.blend.to, smooth(f.blend.t)));
      f.blend = null;
    }
    const gp = f.sim.positionOf(u, v);
    let surface: DragSurface;
    if (!midAir) {
      const other: Side = f.from === 'R' ? 'L' : 'R';
      const zFar = doc.layout.surfaceFor(sheet, other).top;
      surface = ArcDragSurface.forGrab(gp[0], gp[2], zFar);
    } else {
      // camera-facing plane through the grabbed point
      const { d } = this.bookRay(x, y);
      surface = new PlaneDragSurface([gp[0], gp[1], gp[2]], [-d[0], -d[1], -d[2]]);
    }
    const p0: Vec3 = [gp[0], gp[1], gp[2]];
    f.hand = {
      u,
      v,
      surface,
      reach: u,
      y0: gp[1],
      pointer: { x, y },
      auto: null,
      target: p0,
      prev: [...p0],
      vel: [0, 0, 0],
    };
    f.calm = 0;
  }

  /**
   * Turns a page automatically: forward (dir > 0, the top of the book-frame
   * right stack) or back (dir < 0). Forward is the same in both reading
   * directions; only the screen sides are mirrored.
   */
  turn(dir: number): boolean {
    const doc = this.doc;
    if (!doc) return false;
    const sheet = dir > 0 ? doc.layout.topRight() : doc.layout.topLeft();
    if (sheet < 0 || this.flying.size >= MAX_FLYING) return false;
    const f = this.liftOff(sheet);
    const u = AUTO_GRAB.uFrac * doc.dims.W;
    const v = AUTO_GRAB.vFrac * doc.dims.H;
    const gp = f.sim.positionOf(u, v);
    const other: Side = f.from === 'R' ? 'L' : 'R';
    const zFar = doc.layout.surfaceFor(sheet, other).top;
    const busy = [...this.flying.values()].filter((o) => o.hand?.auto).length;
    const auto = new AutoTurn([gp[0], gp[1], gp[2]], zFar, busy > 0 ? 0.5 : 0.68);
    const p0: Vec3 = [gp[0], gp[1], gp[2]];
    f.hand = { u, v, surface: auto.surface, reach: u, y0: gp[1], pointer: null, auto, target: p0, prev: [...p0], vel: [0, 0, 0] };
    this.dirty = true;
    return true;
  }

  private liftOff(sheet: number): FlyingSheet {
    const doc = this.doc!;
    const from = doc.layout.sideOf(sheet);
    const sim = new SheetSim(doc.dims, this.paper, this.envFor(sheet), PHYSICS_STRIPS);
    sim.airScale = this.airScale;
    sim.setState(this.rest(sheet, from));
    const mesh = this.acquireMesh();
    mesh.sheet = sheet;
    mesh.update(sim.q, doc.layout.pivotZ);
    doc.layout.liftOff(sheet);
    const f: FlyingSheet = { sheet, from, sim, mesh, hand: null, calm: 0, stuck: 0, blend: null };
    this.flying.set(sheet, f);
    this.refreshResting();
    return f;
  }

  /** Jumps to a page: nearby pages are riffled through, distant ones re-stacked instantly. */
  jumpTo(page: number): void {
    const doc = this.doc;
    if (!doc) return;
    const target = Math.floor((Math.max(0, Math.min(doc.layout.pageCount - 1, page)) + 1) / 2);
    const delta = target - doc.layout.leftCount;
    if (delta === 0) return;
    if (Math.abs(delta) <= 4 && this.flying.size === 0) {
      this.pendingTurns = delta;
      return;
    }
    for (const f of this.flying.values()) this.releaseMesh(f.mesh);
    this.flying.clear();
    this.pendingTurns = 0;
    doc.layout.jumpToPage(page);
    this.refreshResting();
  }

  // ================================================================== settings

  setPaper(p: PaperParams, airScale: number): void {
    this.paper = p;
    this.airScale = airScale;
    for (const f of this.flying.values()) {
      f.sim.setParams(p);
      f.sim.airScale = airScale;
    }
    // resting poses depend on the paper: recompute once the slider settles
    clearTimeout(this.restTimer);
    this.restTimer = window.setTimeout(() => {
      if (!this.doc) return;
      this.doc.restCache.clear();
      this.doc.profileCache.clear();
      this.refreshResting();
    }, 160);
  }
  private restTimer = 0;

  // ================================================================== frame loop

  /** When set, the animation loop stops advancing (tests drive `tick` themselves). */
  paused = false;

  private frame = (tMs: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.paused || document.hidden) {
      this.last = 0;
      return;
    }
    this.tick(tMs / 1000);
  };

  /** Advances the whole app to time `now` (seconds) and draws if anything changed. */
  tick(now: number): void {
    const dt = this.last ? Math.min(0.05, Math.max(0, now - this.last)) : 1 / 60;
    this.last = now;

    if (this.stage.resize()) {
      this.dirty = true;
      // re-frame when the screen flips between portrait and landscape
      const portrait = this.stage.camera.aspect < 0.8;
      if (this.doc && portrait !== this.wasPortrait) this.frameBook(true);
      this.wasPortrait = portrait;
    }
    const moving = this.view.update(dt);
    this.view.apply(this.stage.camera, this.stage.bookRoot);
    if (this.stage.updateTheme(dt)) this.dirty = true;
    this.stableFor = moving ? 0 : this.stableFor + dt;
    if (moving) this.dirty = true;

    if (this.doc) {
      this.processTurnQueue(dt);
      if (this.flying.size) this.stepPhysics(dt);
      this.updateTextures();
    }
    this.updateTextLayer();
    this.trackNote();
    this.stats.flying = this.flying.size;
    if (this.dirty) {
      this.stage.render();
      this.dirty = false;
    }
  }

  // ================================================================== annotation

  setTool(t: Tool): void {
    if (t !== 'note') this.closeNote();
    this.tool = t;
    this.input.reset();
    this.onToolChange(t);
  }

  undo(): void {
    if (this.doc?.notes.undo()) this.forgetMissingNote();
  }

  redo(): void {
    if (this.doc?.notes.redo()) this.forgetMissingNote();
  }

  /** Width / height of a page, from its raster or its size (null until known). */
  private pageAspect(page: number): number | null {
    const rect = this.contentRectOf(page);
    if (!rect) return null;
    const { W, H } = this.doc!.dims;
    return (rect.z * W) / (rect.w * H);
  }

  /** Where a page's content sits on its sheet (uv), once its raster or size is known. */
  private contentRectOf(page: number): THREE.Vector4 | null {
    const doc = this.doc!;
    const t = doc.textures.get(page);
    if (t) return t.rect;
    const s = doc.sizes.get(page);
    return s ? contentRect(s.w / s.h, doc.dims.W / doc.dims.H) : null;
  }

  /**
   * The page point under a screen point: the resting top sheet's reading face is
   * raycast, and its material coordinates are taken back through the RTL print
   * flip and the page's letter-box rectangle. Page fractions, y down.
   */
  screenToPage(x: number, y: number): { page: number; x: number; y: number } | null {
    const doc = this.doc;
    if (!doc) return null;
    this.raycaster.setFromCamera(this.ndc(x, y), this.stage.camera);
    const resting = (['L', 'R'] as const).map((s) => doc.resting[s]).filter((m) => m.mesh.visible && m.sheet >= 0);
    for (const h of this.raycaster.intersectObjects(
      resting.map((m) => m.mesh),
      false,
    )) {
      const sm = h.object.userData.sheetMesh as SheetMesh;
      const front = (h.faceIndex ?? 0) < sm.frontFaceCount;
      if (front !== (doc.layout.sideOf(sm.sheet) === 'R')) continue; // only the reading face
      const page = front ? doc.layout.pagesOf(sm.sheet).front : doc.layout.pagesOf(sm.sheet).back;
      if (page == null || !h.uv) return null;
      const rect = this.contentRectOf(page);
      if (!rect) return null;
      const sx = this.dir === 'rtl' ? 1 - h.uv.x : h.uv.x;
      const cx = (sx - rect.x) / rect.z;
      const cy = (h.uv.y - rect.y) / rect.w;
      if (cx < 0 || cx > 1 || cy < 0 || cy > 1) return null; // in the letter-box margin
      return { page, x: cx, y: 1 - cy };
    }
    return null;
  }

  /** Screen position of a page point (page fractions), if the page is open and facing the eye. */
  pageToScreen(page: number, x: number, y: number): { x: number; y: number } | null {
    const doc = this.doc;
    if (!doc) return null;
    const s = doc.sizes.get(page);
    const project = this.pageProjection(page);
    return project ? project(x * (s?.w ?? 1), y * (s?.h ?? 1)) : null;
  }

  private annotateStart(x: number, y: number): void {
    const doc = this.doc;
    if (!doc) return;
    this.clearSelection();
    switch (this.tool) {
      case 'pen': {
        const p = this.screenToPage(x, y);
        if (!p) return;
        this.startStroke(p);
        break;
      }
      case 'highlight':
        this.textLayer.beginAt(x, y);
        break;
      case 'note': {
        const p = this.screenToPage(x, y);
        if (!p) return;
        const aspect = this.pageAspect(p.page) ?? 1;
        const hit = annotationsAt(doc.notes.all, p.page, p.x, p.y, 0.004, 1 / aspect).find((a) => a.kind === 'note');
        if (hit) {
          this.showNote(hit.id);
          return;
        }
        const note: Note = { id: newId(), kind: 'note', page: p.page, x: p.x, y: p.y, text: '' };
        doc.notes.add(note);
        this.showNote(note.id);
        break;
      }
      case 'eraser':
        doc.notes.begin();
        this.erasing = true;
        this.eraseAt(x, y);
        break;
    }
  }

  private annotateTo(x: number, y: number): void {
    switch (this.tool) {
      case 'pen': {
        const p = this.screenToPage(x, y);
        if (!p) return;
        const pen = this.pen;
        if (!pen || pen.page !== p.page) {
          // crossed onto the other page: finish this stroke, start one there
          this.finishStroke();
          this.startStroke(p);
          return;
        }
        const pts = pen.stroke.points;
        const aspect = 1 / (this.pageAspect(p.page) ?? 1);
        if (Math.hypot(p.x - pts[pts.length - 2], (p.y - pts[pts.length - 1]) * aspect) < 0.0012) return;
        pts.push(p.x, p.y);
        this.doc!.marks.invalidate([p.page]);
        this.dirty = true;
        break;
      }
      case 'highlight':
        this.textLayer.extendTo(x, y);
        break;
      case 'eraser':
        this.eraseAt(x, y);
        break;
    }
  }

  private annotateEnd(x: number, y: number): void {
    switch (this.tool) {
      case 'pen':
        this.finishStroke();
        break;
      case 'highlight':
        // a tap highlights the word under it
        if (!this.textLayer.selectedText) this.textLayer.selectWordAt(x, y);
        this.highlightSelection(this.highlightColor);
        break;
      case 'eraser':
        if (this.erasing) this.doc?.notes.end();
        this.erasing = false;
        break;
    }
  }

  private startStroke(p: { page: number; x: number; y: number }): void {
    const stroke: Stroke = { id: newId(), kind: 'stroke', page: p.page, color: this.penColor, width: this.penWidth, points: [p.x, p.y] };
    this.pen = { page: p.page, stroke };
    this.doc!.marks.draft = this.pen;
    this.doc!.marks.invalidate([p.page]);
    this.dirty = true;
  }

  private finishStroke(): void {
    const doc = this.doc;
    const pen = this.pen;
    this.pen = null;
    if (!doc || !pen) return;
    doc.marks.draft = null;
    const s = pen.stroke;
    s.points = simplify(s.points, 0.0004);
    doc.notes.add(s);
  }

  private eraseAt(x: number, y: number): void {
    const doc = this.doc!;
    const p = this.screenToPage(x, y);
    if (!p) return;
    const aspect = 1 / (this.pageAspect(p.page) ?? 1);
    const hit = annotationsAt(doc.notes.all, p.page, p.x, p.y, 0.012, aspect);
    if (hit.length) {
      if (hit.some((a) => a.id === this.openNote)) this.closeNote();
      doc.notes.remove(hit.map((a) => a.id));
    }
  }

  /** Highlights the selected text, one highlight per page, and clears the selection. */
  highlightSelection(color: string): void {
    const doc = this.doc;
    if (!doc) return;
    const boxes = this.textLayer.selectionBoxes();
    doc.notes.begin();
    for (const b of boxes) {
      const s = doc.sizes.get(b.page);
      if (!s) continue;
      const quads = b.quads.map((q) => q.map((v, i) => (i % 2 ? v / s.h : v / s.w)));
      doc.notes.add({ id: newId(), kind: 'highlight', page: b.page, color, quads, text: b.text });
    }
    doc.notes.end();
    this.clearSelection();
    this.textLayer.clear();
  }

  /** Does the current text selection touch an existing highlight? */
  selectionOverlapsHighlight(): boolean {
    return this.highlightsInSelection().length > 0;
  }

  /** Removes every highlight the current selection touches. */
  removeSelectedHighlights(): void {
    const ids = this.highlightsInSelection();
    if (ids.length) this.doc?.notes.remove(ids);
    this.clearSelection();
  }

  private highlightsInSelection(): string[] {
    const doc = this.doc;
    if (!doc) return [];
    const ids: string[] = [];
    for (const b of this.textLayer.selectionBoxes()) {
      const s = doc.sizes.get(b.page);
      if (!s) continue;
      const sel = b.quads.map((q) => q.map((v, i) => (i % 2 ? v / s.h : v / s.w)));
      for (const a of doc.notes.forPage(b.page)) {
        if (a.kind === 'highlight' && a.quads.some((q) => sel.some((t) => quadsOverlap(q, t)))) ids.push(a.id);
      }
    }
    return ids;
  }

  // ---- notes

  setNoteText(id: string, text: string): void {
    const doc = this.doc;
    const n = doc?.notes.all.find((a) => a.id === id);
    if (doc && n && n.kind === 'note' && n.text !== text) doc.notes.update<Note>(id, { text });
  }

  deleteNote(id: string): void {
    if (this.openNote === id) this.closeNote();
    this.doc?.notes.remove([id]);
  }

  /** Closes the note editor; a note left empty is removed. */
  closeNote(): void {
    const id = this.openNote;
    if (!id) return;
    this.openNote = null;
    this.noteAt = '';
    const n = this.doc?.notes.all.find((a) => a.id === id);
    if (n && n.kind === 'note' && !n.text.trim()) this.doc!.notes.remove([id]);
    this.onNoteOpen(null, null);
  }

  private showNote(id: string): void {
    const n = this.doc?.notes.all.find((a) => a.id === id);
    if (!n || n.kind !== 'note') return;
    if (this.openNote && this.openNote !== id) this.closeNote();
    this.openNote = id;
    this.noteAt = '';
    this.onNotePeek(null, null);
    this.onNoteOpen(n, this.pageToScreen(n.page, n.x, n.y));
  }

  private forgetMissingNote(): void {
    if (this.openNote && !this.doc?.notes.all.some((a) => a.id === this.openNote)) {
      this.openNote = null;
      this.onNoteOpen(null, null);
    }
  }

  /** Keeps the open note's editor on its anchor while the view moves. */
  private trackNote(): void {
    const id = this.openNote;
    if (!id) return;
    const n = this.doc?.notes.all.find((a) => a.id === id);
    if (!n || n.kind !== 'note') return;
    const settled = this.flying.size === 0 && this.pendingTurns === 0;
    const at = settled ? this.pageToScreen(n.page, n.x, n.y) : null;
    const key = at ? `${at.x.toFixed(1)},${at.y.toFixed(1)}` : 'none';
    if (key === this.noteAt) return;
    this.noteAt = key;
    this.onNoteMove(at);
  }

  /** Shows a note's text while the pointer rests on its mark. */
  private peekNote(x: number, y: number): void {
    const doc = this.doc;
    if (!doc || this.openNote || this.flying.size || !doc.notes.all.some((a) => a.kind === 'note')) {
      this.onNotePeek(null, null);
      return;
    }
    const p = this.screenToPage(x, y);
    const n = p
      ? annotationsAt(doc.notes.all, p.page, p.x, p.y, 0, 1 / (this.pageAspect(p.page) ?? 1)).find((a): a is Note => a.kind === 'note')
      : undefined;
    this.onNotePeek(n && n.text.trim() ? n : null, n ? this.pageToScreen(n.page, n.x, n.y) : null);
  }

  // ================================================================== text layer

  clearSelection(): void {
    if (!this.textLayer.selectedText) return;
    this.textLayer.clear();
    this.onTextSelection('', null);
  }

  /**
   * Shows the selectable text of the visible spread once the book has settled:
   * nothing in flight, no turns queued, the view at rest. It is (re)placed
   * whenever the pose or the viewport changes, and hidden while anything moves
   * (a selection survives that and reappears in place).
   */
  private updateTextLayer(): void {
    const doc = this.doc;
    const tl = this.textLayer;
    const mode = this.input.state.mode;
    const selecting = mode === 'selectText' || mode === 'annotate'; // a selection or the highlighter at work
    const settled =
      !!doc &&
      this.flying.size === 0 &&
      this.pendingTurns === 0 &&
      (selecting || (this.stableFor > 0.12 && (mode === 'idle' || mode === 'pressPage')));
    if (!doc || !settled) {
      if (!selecting) tl.setVisible(false);
      this.textPose = '';
      return;
    }
    const spread = doc.layout.readingSpread(); // book frame: left = verso, right = recto
    const key = `${doc.source.name}|${spread.left}|${spread.right}`;
    if (tl.key !== key) {
      tl.setVisible(false);
      this.loadText(key, [spread.left, spread.right].filter((p): p is number => p != null));
      return;
    }
    const c = this.stage.canvas;
    const v = this.view;
    const at = c.getBoundingClientRect(); // the layer is laid out in viewport pixels: follow the canvas when the page scrolls
    const pose = [v.rot.x, v.rot.y, v.rot.z, v.rot.w, v.target.x, v.target.y, v.target.z, v.dist, at.left, at.top, at.width, at.height, this.dir]
      .map((n) => (typeof n === 'number' ? n.toFixed(6) : n))
      .join(',');
    if (pose !== this.textPose) {
      this.textPose = pose;
      tl.place((page) => this.pageProjection(page));
    }
    tl.setVisible(true);
  }

  private loadText(key: string, pages: number[]): void {
    const doc = this.doc!;
    if (this.textLoading === key) return;
    this.textLoading = key;
    const load = (p: number) => {
      let t = doc.text.get(p);
      if (!t) {
        t = Promise.all([doc.source.textContent?.(p) ?? Promise.resolve([] as TextRun[]), doc.source.pageSize(p)]).then(
          ([runs, size]) => {
            doc.sizes.set(p, size);
            return { runs, w: size.w, h: size.h };
          },
        );
        t.catch(() => doc.text.delete(p));
        doc.text.set(p, t);
      }
      return t.then((r) => ({ page: p, runs: r.runs })).catch(() => ({ page: p, runs: [] as TextRun[] }));
    };
    void Promise.all(pages.map(load)).then((loaded) => {
      if (this.doc !== doc || this.textLoading !== key) return;
      this.textLoading = '';
      this.textLayer.build(key, loaded);
      this.textPose = '';
    });
  }

  /**
   * Projects points of a visible page (PDF points from its top-left) to the
   * screen, through the page's letter-box rectangle, the print flip of RTL books,
   * the resting sheet's curled shape and the camera. Null when the page is not
   * on a resting top sheet or is turned too far from the eye to read.
   */
  private pageProjection(page: number): PageProjection | null {
    const doc = this.doc!;
    const { layout, dims } = doc;
    const tl = layout.topLeft();
    const tr = layout.topRight();
    let sheet: number;
    let side: Side;
    if (tl >= 0 && layout.pagesOf(tl).back === page) [sheet, side] = [tl, 'L'];
    else if (tr >= 0 && layout.pagesOf(tr).front === page) [sheet, side] = [tr, 'R'];
    else return null;
    const front = side === 'R';
    const size = doc.textures.get(page);
    const info = doc.sizes.get(page);
    const rect = size?.rect ?? (info ? contentRect(info.w / info.h, dims.W / dims.H) : FULL);
    const pw = info?.w ?? 1;
    const ph = info?.h ?? 1;
    const q = this.rest(sheet, side);
    const chain = new HingeChain(dims.W, dims.H, PHYSICS_STRIPS - 1, dims.W / (PHYSICS_STRIPS - 1));
    chain.update(q[0], q.subarray(1), layout.pivotZ);
    const toWorld = this.stage.bookRoot.matrixWorld;
    const cam = this.stage.camera;
    const P = new Float64Array(3);
    const tmp = new THREE.Vector3();
    const book = (u: number, v: number) => {
      chain.point(u, v, P);
      return new THREE.Vector3(P[0], P[1], P[2]);
    };
    // material coordinates (u from the spine, v from the middle) of a page point
    const material = (x: number, y: number): [number, number] => {
      const sx = rect.x + (x / pw) * rect.z;
      const sy = rect.y + (1 - y / ph) * rect.w;
      const geo = this.dir === 'rtl' ? 1 - sx : sx; // the shader flips the print of RTL books
      return [front ? dims.W * geo : dims.W * (1 - geo), -dims.H / 2 + dims.H * sy];
    };
    // is the reading face turned towards the eye?
    const c0 = book(dims.W * 0.5, 0);
    const du = book(dims.W * 0.5 + 0.01, 0).sub(c0);
    const dv = book(dims.W * 0.5, 0.01).sub(c0);
    const n = du.cross(dv).multiplyScalar(front ? 1 : -1);
    n.applyMatrix3(new THREE.Matrix3().getNormalMatrix(toWorld)).normalize();
    const centre = c0.applyMatrix4(toWorld);
    if (n.dot(tmp.copy(cam.position).sub(centre).normalize()) < 0.25) return null;
    const cw = this.stage.canvas.clientWidth;
    const ch = this.stage.canvas.clientHeight;
    const r = this.stage.canvas.getBoundingClientRect();
    return (x, y) => {
      const [u, v] = material(x, y);
      if (u < -1e-4 || u > dims.W + 1e-4 || v < -dims.H / 2 - 1e-4 || v > dims.H / 2 + 1e-4) return null;
      const p = book(u, v).applyMatrix4(toWorld).project(cam);
      if (p.z < -1 || p.z > 1) return null;
      return { x: r.left + ((p.x + 1) / 2) * cw, y: r.top + ((1 - p.y) / 2) * ch };
    };
  }

  private processTurnQueue(dt: number): void {
    this.turnCooldown -= dt;
    if (this.pendingTurns !== 0 && this.turnCooldown <= 0) {
      const dir = Math.sign(this.pendingTurns);
      if (this.turn(dir)) {
        this.pendingTurns -= dir;
        this.turnCooldown = 0.12;
      } else this.pendingTurns = 0;
    }
  }

  private stepPhysics(dt: number): void {
    const doc = this.doc!;
    if (this.gravityFollowsBook) this.view.gravityInBook(this.gravity);
    else this.gravity.splice(0, 3, 0, 0, -9.81);
    // the book frame of an RTL book is mirrored in x
    toBookFrame(this.gravity, this.dir);

    // environments: the sheet beneath may have landed since this one took off
    for (const f of this.flying.values()) {
      const env = this.envFor(f.sheet);
      f.sim.env.right = env.right;
      f.sim.env.left = env.left;
    }
    // hand targets for this frame
    for (const f of this.flying.values()) {
      const hand = f.hand;
      if (!hand) continue;
      hand.prev = hand.target;
      if (hand.auto) {
        const r = hand.auto.advance(dt);
        hand.target = r.target;
        hand.vel = r.velocity;
        continue;
      }
      if (!hand.pointer) continue;
      const { o, d } = this.bookRay(hand.pointer.x, hand.pointer.y);
      let p = hand.surface.intersect(o, d);
      if (!p) p = new PlaneDragSurface(hand.prev, [-d[0], -d[1], -d[2]]).intersect(o, d) ?? hand.prev;
      hand.target = clampReach(p, doc.layout.pivotZ, hand.reach, hand.y0);
      const inst: Vec3 = [
        (hand.target[0] - hand.prev[0]) / Math.max(dt, 1e-3),
        (hand.target[1] - hand.prev[1]) / Math.max(dt, 1e-3),
        (hand.target[2] - hand.prev[2]) / Math.max(dt, 1e-3),
      ];
      for (let k = 0; k < 3; k++) hand.vel[k] += (inst[k] - hand.vel[k]) * 0.5;
    }

    // fixed-step integration
    this.acc += dt;
    let n = Math.floor(this.acc / H_STEP);
    if (n > MAX_SUBSTEPS) {
      n = MAX_SUBSTEPS;
      this.acc = 0;
    } else this.acc -= n * H_STEP;
    const t0 = performance.now();
    let iters = 0;
    for (let s = 0; s < n; s++) {
      const a = (s + 1) / n;
      for (const f of this.flying.values()) {
        if (f.blend) continue;
        const hand = f.hand;
        if (hand) {
          f.sim.hand = {
            u: hand.u,
            v: hand.v,
            target: [
              hand.prev[0] + (hand.target[0] - hand.prev[0]) * a,
              hand.prev[1] + (hand.target[1] - hand.prev[1]) * a,
              hand.prev[2] + (hand.target[2] - hand.prev[2]) * a,
            ],
            velocity: hand.vel,
            strength: hand.auto ? 1.4 : 1,
          };
        } else f.sim.hand = null;
        f.sim.step(H_STEP);
        iters += f.sim.stats.iterations;
        if (!f.sim.q.every(Number.isFinite)) {
          // never let a numerical failure reach the screen
          const side: Side = f.from;
          f.sim.setState(this.rest(f.sheet, side));
          f.hand = null;
        }
      }
    }
    this.stats.stepMs = performance.now() - t0;
    this.stats.iterations = n ? iters / n : 0;

    // auto-turn release, landing, meshes
    const landed: FlyingSheet[] = [];
    for (const f of this.flying.values()) {
      if (f.hand?.auto?.done) f.hand = null;
      if (f.blend) {
        f.blend.t = Math.min(1, f.blend.t + dt / 0.16);
        f.mesh.update(lerpQ(f.blend.from, f.blend.to, smooth(f.blend.t)), doc.layout.pivotZ);
        if (f.blend.t >= 1) landed.push(f);
        continue;
      }
      if (!f.hand) this.checkLanding(f, dt);
      f.mesh.update(f.sim.q, doc.layout.pivotZ);
    }
    for (const f of landed) {
      doc.layout.land(f.sheet, f.blend!.side);
      this.flying.delete(f.sheet);
      this.releaseMesh(f.mesh);
    }
    if (landed.length) this.refreshResting();
    this.stats.flying = this.flying.size;
    this.dirty = true;
  }

  private checkLanding(f: FlyingSheet, dt: number): void {
    const psi0 = f.sim.q[1];
    const side: Side = psi0 > Math.PI / 2 ? 'L' : 'R';
    const rest = this.rest(f.sheet, side);
    const near = Math.abs(psi0 - rest[1]) < 0.25;
    const slow = f.sim.stats.maxSpeed < 0.02;
    f.calm = near && slow ? f.calm + dt : 0;
    if (f.calm > 0.16) {
      f.blend = { t: 0, from: Float64Array.from(f.sim.q), to: rest, side };
      return;
    }
    f.stuck = !near && f.sim.stats.maxSpeed < 0.01 ? f.stuck + dt : 0;
    if (f.stuck > 0.9) {
      // balanced upright on a stiff binding: a breath of air decides
      f.sim.qd[1] += psi0 > Math.PI / 2 ? 0.8 : -0.8;
      f.stuck = 0;
    }
  }

  // ================================================================== textures

  private pagePx(m: SheetMesh, cx: number, cz: number): number {
    const world = new THREE.Vector3(cx, 0, cz).applyMatrix4(this.stage.bookRoot.matrixWorld);
    const d = Math.max(0.01, world.distanceTo(this.stage.camera.position));
    const f = Math.tan(THREE.MathUtils.degToRad(this.stage.camera.fov) / 2);
    const ppm = this.stage.viewportHeightPx / (2 * d * f);
    return Math.max(m.dims.W, m.dims.H) * ppm;
  }

  private updateTextures(): void {
    const doc = this.doc!;
    const { layout, textures, dims } = doc;
    textures.beginFrame();
    doc.marks.beginFrame();
    const visible: { m: SheetMesh; px: number; faces: ('front' | 'back')[] }[] = [];
    const rl = doc.resting.L;
    const rr = doc.resting.R;
    if (rr.mesh.visible) visible.push({ m: rr, px: this.pagePx(rr, dims.W / 2, 0), faces: ['front'] });
    if (rl.mesh.visible) visible.push({ m: rl, px: this.pagePx(rl, -dims.W / 2, 0), faces: ['back'] });
    for (const f of this.flying.values()) {
      const c = f.sim.positionOf(dims.W / 2, 0);
      visible.push({ m: f.mesh, px: this.pagePx(f.mesh, c[0], c[2]), faces: ['front', 'back'] });
    }
    for (const { m, px, faces } of visible) {
      const pg = layout.pagesOf(m.sheet);
      for (const face of ['front', 'back'] as const) {
        const page = pg[face];
        if (page == null) continue;
        const shown = faces.includes(face);
        // hidden faces still matter: they show through, and are the next thing seen when the sheet turns
        textures.want(page, shown ? px : Math.min(px, 1024), shown ? 3 : 2);
      }
    }
    // prefetch the next sheets on both stacks
    const pxBase = visible.length ? visible[0].px : 1024;
    const tr = layout.topRight();
    const tl = layout.topLeft();
    for (let k = 1; k <= 2; k++) {
      if (tr >= 0 && tr + k < layout.sheetCount) {
        const p = layout.pagesOf(tr + k);
        if (p.front != null) textures.want(p.front, Math.min(pxBase, 1024), 1);
        if (p.back != null) textures.want(p.back, 512, 0);
      }
      if (tl - k >= 0) {
        const p = layout.pagesOf(tl - k);
        if (p.back != null) textures.want(p.back, Math.min(pxBase, 1024), 1);
        if (p.front != null) textures.want(p.front, 512, 0);
      }
    }
    // detail tiles for close-ups of resting pages
    for (const { m, px, faces } of visible) {
      if (m !== rl && m !== rr) continue;
      const face = faces[0];
      const page = layout.pagesOf(m.sheet)[face];
      if (page == null) continue;
      this.updateDetail(m, face, page, px);
    }
    textures.endFrame();

    for (const { m } of visible) this.applyTextures(m);
    this.stats.textureMB = textures.usedBytes / (1024 * 1024);
  }

  private updateDetail(m: SheetMesh, face: 'front' | 'back', page: number, px: number): void {
    const doc = this.doc!;
    const key = `${page}`;
    const base = doc.textures.get(page);
    if (!base || px < doc.textures.maxTier * 1.12) {
      doc.detailCommit.delete(key);
      return;
    }
    let commit = doc.detailCommit.get(key);
    if (!commit || this.stableFor > 0.14) {
      const rect = this.visibleContentRect(m, face, base);
      if (rect) {
        const { W, H } = m.dims;
        const cr = base.rect;
        const aspect = (cr.z * W) / (cr.w * H);
        // on-screen pixels of the whole page content
        const contentPx = (px * Math.max(cr.z * W, cr.w * H)) / Math.max(W, H);
        const fullW = aspect >= 1 ? contentPx : contentPx * aspect;
        const fullH = aspect >= 1 ? contentPx / aspect : contentPx;
        const cw = rect.z * fullW;
        const ch = rect.w * fullH;
        const k = Math.min(1, 2048 / Math.max(cw, ch));
        const w = Math.max(64, Math.round(cw * k));
        const h = Math.max(64, Math.round(ch * k));
        // the tile only pays off when it is markedly sharper than the base texture
        const baseW = aspect >= 1 ? base.tier : base.tier * aspect;
        const gainVsBase = w / rect.z / baseW;
        if (gainVsBase > 1.15 && (!commit || !nearRect(commit.rect, rect))) {
          commit = { rect, w, h };
          doc.detailCommit.set(key, commit);
        }
      }
    }
    if (commit) doc.textures.wantDetail(page, commit.rect, commit.w, commit.h);
  }

  /** Bounding box (content uv, y up) of the part of a resting page inside the viewport. */
  private visibleContentRect(m: SheetMesh, face: 'front' | 'back', base: PageTexture): THREE.Vector4 | null {
    const { W, H } = m.dims;
    const q = this.rest(m.sheet, face === 'front' ? 'R' : 'L');
    const chain = this.tmpChain.chain!;
    chain.update(q[0], q.subarray(1), this.doc!.layout.pivotZ);
    const mvp = new THREE.Matrix4()
      .multiplyMatrices(this.stage.camera.projectionMatrix, this.stage.camera.matrixWorldInverse)
      .multiply(this.stage.bookRoot.matrixWorld);
    const P = new Float64Array(3);
    const v4 = new THREE.Vector4();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const N = 24;
    let inside = 0;
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const u = (i / N) * W;
        const v = (j / N - 0.5) * H;
        chain.point(u, v, P);
        v4.set(P[0], P[1], P[2], 1).applyMatrix4(mvp);
        if (v4.w <= 0) continue;
        const nx = v4.x / v4.w;
        const ny = v4.y / v4.w;
        if (Math.abs(nx) > 1.08 || Math.abs(ny) > 1.08) continue;
        inside++;
        const s = face === 'front' ? u / W : 1 - u / W;
        const su = this.dir === 'rtl' ? 1 - s : s;
        const sv = j / N;
        const cu = (su - base.rect.x) / base.rect.z;
        const cv = (sv - base.rect.y) / base.rect.w;
        x0 = Math.min(x0, cu);
        x1 = Math.max(x1, cu);
        y0 = Math.min(y0, cv);
        y1 = Math.max(y1, cv);
      }
    }
    if (!inside) return null;
    const pad = 1.5 / N;
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(1, x1 + pad);
    y1 = Math.min(1, y1 + pad);
    if (x1 <= x0 || y1 <= y0) return null;
    return new THREE.Vector4(x0, y0, x1 - x0, y1 - y0);
  }

  private applyTextures(m: SheetMesh): void {
    const doc = this.doc!;
    const pg = doc.layout.pagesOf(m.sheet);
    const tf = pg.front != null ? doc.textures.get(pg.front) : undefined;
    const tb = pg.back != null ? doc.textures.get(pg.back) : undefined;
    const df = pg.front != null ? doc.textures.detail(pg.front) : undefined;
    const db = pg.back != null ? doc.textures.detail(pg.back) : undefined;
    this.setFace(m.front, tf, tb, df, pg.front != null ? doc.marks.get(pg.front) : null);
    this.setFace(m.back, tb, tf, db, pg.back != null ? doc.marks.get(pg.back) : null);
    const lift = this.flying.has(m.sheet) ? this.flying.get(m.sheet)! : null;
    const ao = lift ? Math.max(0, 1 - Math.abs(Math.sin(lift.sim.q[1])) * 2.5) : 1;
    m.front.userData.paper.uGutterAO.value = ao;
    m.back.userData.paper.uGutterAO.value = ao;
  }

  private setFace(
    mat: PaperMaterial,
    own: PageTexture | undefined,
    other: PageTexture | undefined,
    detail: { tex: THREE.Texture; rect: THREE.Vector4 } | undefined,
    marks: THREE.Texture | null,
  ): void {
    const u = mat.userData.paper;
    u.uAnnoMap.value = marks ?? this.blank;
    u.uAnnoOn.value = marks ? 1 : 0;
    mat.map = own?.tex ?? this.blank;
    u.uContentRect.value.copy(own?.rect ?? FULL);
    u.uBackMap.value = other?.tex ?? this.blank;
    u.uBackRect.value.copy(other?.rect ?? FULL);
    if (detail) {
      u.uDetailMap.value = detail.tex;
      u.uDetailRect.value.copy(detail.rect);
      u.uDetailOn.value = 1;
    } else {
      u.uDetailMap.value = this.blank;
      u.uDetailOn.value = 0;
    }
  }
}

const FULL = new THREE.Vector4(0, 0, 1, 1);

const TOOL_KEYS: Record<string, Tool> = { r: 'read', h: 'highlight', p: 'pen', n: 'note', e: 'eraser' };

/** Pointer over a page with each tool. */
const TOOL_CURSOR: Record<Tool, string> = {
  read: 'grab',
  highlight: 'text',
  pen: 'crosshair',
  note: 'copy',
  eraser:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22'%3E%3Ccircle cx='11' cy='11' r='8' fill='white' fill-opacity='.35' stroke='%23333' stroke-width='1.5'/%3E%3C/svg%3E\") 11 11, cell",
};

/** True if the object and all its ancestors are visible. */
function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerpQ(a: Float64Array, b: Float64Array, t: number): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

function nearRect(a: THREE.Vector4, b: THREE.Vector4): boolean {
  const tol = 0.04 * Math.max(a.z, a.w);
  return (
    Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol && Math.abs(a.z - b.z) < tol && Math.abs(a.w - b.w) < tol
  );
}
