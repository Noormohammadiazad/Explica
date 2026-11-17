import type { TextRun } from '../pdf/pageSource';
import { affineOnto, caretIndex, parallelogramCoords, parallelogramDistance, runBox, wordAround, type Pt2 } from '../pdf/textGeometry';

/** Size the spans are set in before their transform scales them onto the page. */
const FONT_PX = 32;
const FONT = `${FONT_PX}px sans-serif`;
/** How far (CSS px) from a line a drag may stray and still extend the selection to it. */
const REACH_PX = 60;

interface Placed {
  run: TextRun;
  node: Text;
  span: HTMLSpanElement;
  /** Character boundaries at FONT_PX, for carets. */
  edges: number[];
  /** Screen corners of the run's box, once placed. */
  quad: { tl: Pt2; tr: Pt2; bl: Pt2 } | null;
}

interface PageLayer {
  page: number;
  el: HTMLElement;
  runs: Placed[];
}

/** Maps a point on a page (PDF points from its top-left, y down) to the screen, or null. */
export type PageProjection = (x: number, y: number) => Pt2 | null;

/**
 * Transparent, selectable copies of the visible pages' text, laid exactly over
 * the rendered paper. Each run is its own span, mapped by a CSS affine onto the
 * screen positions of three corners projected through the page's actual (curled)
 * resting shape, so the text follows the paper into the gutter.
 *
 * The layer never takes pointer events: the canvas keeps every click and drag
 * for turning pages. Selection is made programmatically (a long press on text
 * selects the word, dragging extends it), and since it is an ordinary DOM
 * selection, ⌘/Ctrl+C copies it natively.
 */
export class TextLayer {
  private pages: PageLayer[] = [];
  private readonly measure: CanvasRenderingContext2D;
  /** Identifies the spread the DOM was built for. */
  key = '';
  private visible = false;
  private word: { node: Text; start: number; end: number } | null = null;

  constructor(readonly root: HTMLElement) {
    this.measure = document.createElement('canvas').getContext('2d')!;
    this.measure.font = FONT;
  }

  /** True while the layer is on screen with text in it (presses on text may select). */
  get active(): boolean {
    return this.visible && this.pages.some((p) => p.runs.some((r) => r.quad));
  }

  /** Rebuilds the layer for these pages, in reading order. Clears any selection. */
  build(key: string, pages: { page: number; runs: TextRun[] }[]): void {
    this.clear();
    this.key = key;
    this.pages = [];
    const frag = document.createDocumentFragment();
    for (const p of pages) {
      const el = document.createElement('div');
      el.className = 'tl-page';
      el.setAttribute('aria-label', `Page ${p.page + 1}`);
      const runs: Placed[] = [];
      for (const run of p.runs) {
        const span = document.createElement('span');
        const node = document.createTextNode(run.str);
        span.append(node);
        el.append(span);
        if (run.eol) el.append(document.createElement('br'));
        const edges = [0];
        for (const ch of run.str) edges.push(edges[edges.length - 1] + this.measure.measureText(ch).width);
        // surrogate pairs take two UTF-16 units but one advance: pad so indices line up
        while (edges.length < run.str.length + 1) edges.push(edges[edges.length - 1]);
        runs.push({ run, node, span, edges, quad: null });
      }
      frag.append(el);
      this.pages.push({ page: p.page, el, runs });
    }
    this.root.replaceChildren(frag);
  }

  /** Lays every run over its page through `projectionFor(page)` (null hides that page). */
  place(projectionFor: (page: number) => PageProjection | null): void {
    for (const p of this.pages) {
      const project = projectionFor(p.page);
      p.el.style.display = project ? '' : 'none';
      for (const r of p.runs) {
        r.quad = null;
        if (!project) continue;
        const box = runBox(r.run);
        const tl = project(box.tl.x, box.tl.y);
        const tr = project(box.tr.x, box.tr.y);
        const bl = project(box.bl.x, box.bl.y);
        const w = r.edges[r.edges.length - 1];
        if (!tl || !tr || !bl || !(w > 0)) {
          r.span.style.display = 'none';
          continue;
        }
        r.span.style.display = '';
        r.span.style.transform = `matrix(${affineOnto(tl, tr, bl, w, FONT_PX).join(',')})`;
        r.quad = { tl, tr, bl };
      }
    }
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('on', on);
  }

  /** Is there text under this screen point? */
  hasTextAt(x: number, y: number): boolean {
    for (const r of this.placed()) {
      const st = parallelogramCoords(r.quad!.tl, r.quad!.tr, r.quad!.bl, { x, y });
      if (st && st.s >= -0.01 && st.s <= 1.01 && st.t >= -0.12 && st.t <= 1.12) return true;
    }
    return false;
  }

  /** Selects the word under a screen point. Returns false if there is no text there. */
  selectWordAt(x: number, y: number): boolean {
    const c = this.caretAt(x, y, 4);
    if (!c) return false;
    const [start, end] = wordAround(c.node.data, c.offset);
    this.word = { node: c.node, start, end };
    window.getSelection()?.setBaseAndExtent(c.node, start, c.node, end);
    return true;
  }

  /** Starts a selection at the caret nearest a screen point (the highlighter: no word snapping). */
  beginAt(x: number, y: number): boolean {
    const c = this.caretAt(x, y, 24);
    if (!c) return false;
    this.word = { node: c.node, start: c.offset, end: c.offset };
    window.getSelection()?.setBaseAndExtent(c.node, c.offset, c.node, c.offset);
    return true;
  }

  /**
   * The selected text as boxes on its pages, in page points: for every run the
   * selection touches, the part of its box between the selected characters.
   */
  selectionBoxes(): { page: number; quads: number[][]; text: string }[] {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.commonAncestorContainer)) return [];
    const out: { page: number; quads: number[][]; text: string }[] = [];
    for (const p of this.pages) {
      const quads: number[][] = [];
      let text = '';
      for (const r of p.runs) {
        if (!range.intersectsNode(r.node)) continue;
        const len = r.node.data.length;
        const s = r.node === range.startContainer ? range.startOffset : 0;
        const e = r.node === range.endContainer ? range.endOffset : len;
        if (e <= s) continue;
        const total = r.edges[r.edges.length - 1] || 1;
        const a = r.edges[Math.min(s, r.edges.length - 1)] / total;
        const b = r.edges[Math.min(e, r.edges.length - 1)] / total;
        const box = runBox(r.run);
        const ux = box.tr.x - box.tl.x;
        const uy = box.tr.y - box.tl.y;
        const vx = box.bl.x - box.tl.x;
        const vy = box.bl.y - box.tl.y;
        const x0 = box.tl.x + ux * a;
        const y0 = box.tl.y + uy * a;
        const x1 = box.tl.x + ux * b;
        const y1 = box.tl.y + uy * b;
        quads.push([x0, y0, x1, y1, x1 + vx, y1 + vy, x0 + vx, y0 + vy]);
        text += r.node.data.slice(s, e) + (r.run.eol ? '\n' : '');
      }
      if (quads.length) out.push({ page: p.page, quads, text: text.trim() });
    }
    return out;
  }

  /** Extends the selection from the word first selected to the caret nearest a screen point. */
  extendTo(x: number, y: number): void {
    const w = this.word;
    const c = this.caretAt(x, y, REACH_PX);
    if (!w || !c) return;
    const sel = window.getSelection();
    if (!sel) return;
    // keep the whole first word, whichever way the drag goes
    const before = compare(c.node, c.offset, w.node, w.start) < 0;
    if (before) sel.setBaseAndExtent(w.node, w.end, c.node, c.offset);
    else sel.setBaseAndExtent(w.node, w.start, c.node, Math.max(c.offset, c.node === w.node ? w.end : 0));
  }

  /** Selects all the text of the visible pages. */
  selectAll(): boolean {
    const nodes = this.pages.filter((p) => p.el.style.display !== 'none').flatMap((p) => p.runs.map((r) => r.node));
    if (!nodes.length) return false;
    const last = nodes[nodes.length - 1];
    window.getSelection()?.setBaseAndExtent(nodes[0], 0, last, last.data.length);
    this.word = null;
    return true;
  }

  /** The selected text, if the selection lies in this layer. */
  get selectedText(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode || !this.root.contains(sel.anchorNode)) return '';
    return sel.toString();
  }

  /** Screen point at the end of the selection (for a copy button), or null. */
  selectionEnd(): Pt2 | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !this.selectedText) return null;
    const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const r = rects[rects.length - 1];
    return { x: r.right, y: r.bottom };
  }

  clear(): void {
    this.word = null;
    const sel = window.getSelection();
    if (sel?.anchorNode && this.root.contains(sel.anchorNode)) sel.removeAllRanges();
  }

  private *placed(): Generator<Placed> {
    for (const p of this.pages) for (const r of p.runs) if (r.quad) yield r;
  }

  /** The caret nearest a screen point, within `reach` CSS px of a line. */
  private caretAt(x: number, y: number, reach: number): { node: Text; offset: number } | null {
    let best: Placed | null = null;
    let bd = reach;
    for (const r of this.placed()) {
      const d = parallelogramDistance(r.quad!.tl, r.quad!.tr, r.quad!.bl, { x, y });
      if (d < bd || (d === 0 && bd === 0)) {
        bd = d;
        best = r;
        if (d === 0) break;
      }
    }
    if (!best) return null;
    const q = best.quad!;
    const st = parallelogramCoords(q.tl, q.tr, q.bl, { x, y });
    const s = Math.min(1, Math.max(0, st?.s ?? 0));
    const w = best.edges[best.edges.length - 1];
    return { node: best.node, offset: Math.min(best.node.data.length, caretIndex(best.edges, s * w)) };
  }
}

/** Document order of two boundary points (negative: a is before b). */
function compare(a: Node, ao: number, b: Node, bo: number): number {
  if (a === b) return ao - bo;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}
