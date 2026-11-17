import * as THREE from 'three';
import { paintPage } from './paint';
import type { AnnotationStore } from './store';
import type { Stroke } from './model';

interface Entry {
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  aspect: number;
  dirty: boolean;
  used: number;
}

const MAX_PAGES = 12;

/**
 * One texture per annotated page, holding its highlights, ink and note marks
 * at the page's aspect ratio. The paper shader samples it in the page's own
 * content coordinates, so every mark sits on the paper itself. Redrawn only
 * when the page's annotations change; least-recently used pages are dropped.
 */
export class AnnotationTextures {
  private readonly pages = new Map<number, Entry>();
  private frame = 0;
  /** A stroke being drawn, shown before it is committed. */
  draft: { page: number; stroke: Stroke } | null = null;

  constructor(
    private readonly store: AnnotationStore,
    /** Page width / height, once known (null: not yet). */
    private readonly aspectOf: (page: number) => number | null,
    private readonly maxSide: number,
    private readonly anisotropy: number,
  ) {}

  beginFrame(): void {
    this.frame++;
  }

  /** The page's annotation texture, or null when it has none. */
  get(page: number): THREE.Texture | null {
    const items = this.store.forPage(page);
    const draft = this.draft?.page === page ? this.draft.stroke : null;
    if (!items.length && !draft) {
      this.drop(page);
      return null;
    }
    const aspect = this.aspectOf(page);
    if (aspect == null) return null;
    let e = this.pages.get(page);
    if (!e || Math.abs(e.aspect - aspect) > 1e-6) {
      if (e) this.drop(page);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(aspect >= 1 ? this.maxSide : this.maxSide * aspect);
      canvas.height = Math.round(aspect >= 1 ? this.maxSide / aspect : this.maxSide);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.anisotropy;
      e = { canvas, tex, aspect, dirty: true, used: this.frame };
      this.pages.set(page, e);
      this.evict(page);
    }
    if (e.dirty) {
      paintPage(e.canvas.getContext('2d')!, items, e.canvas.width, e.canvas.height, draft);
      e.tex.needsUpdate = true;
      e.dirty = false;
    }
    e.used = this.frame;
    return e.tex;
  }

  invalidate(pages: Iterable<number>): void {
    for (const p of pages) {
      const e = this.pages.get(p);
      if (e) e.dirty = true;
    }
  }

  dispose(): void {
    for (const p of [...this.pages.keys()]) this.drop(p);
  }

  private drop(page: number): void {
    const e = this.pages.get(page);
    if (!e) return;
    e.tex.dispose();
    this.pages.delete(page);
  }

  private evict(keep: number): void {
    if (this.pages.size <= MAX_PAGES) return;
    const old = [...this.pages.entries()].filter(([p]) => p !== keep).sort((a, b) => a[1].used - b[1].used);
    for (const [p] of old.slice(0, this.pages.size - MAX_PAGES)) this.drop(p);
  }
}
