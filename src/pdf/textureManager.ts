import * as THREE from 'three';
import type { PageSource, PageRegion } from './pageSource';

export interface PageTexture {
  tex: THREE.Texture;
  /** Where the page content sits inside the sheet (uv offset xy, size zw). */
  rect: THREE.Vector4;
  tier: number;
  bytes: number;
  lastUsed: number;
  /** Out of date (the source re-typeset its pages): still shown until its replacement is ready. */
  stale?: boolean;
}

export interface DetailTile {
  tex: THREE.Texture;
  /** Region of the page content covered by the tile, in content uv (y up): offset xy, size zw. */
  rect: THREE.Vector4;
  bytes: number;
}

interface Want {
  px: number;
  priority: number;
}

interface Job {
  page: number;
  tier: number;
  abort: AbortController;
  detail?: { rect: THREE.Vector4; w: number; h: number };
}

const TIERS = [256, 512, 1024, 2048, 4096];

/**
 * GPU texture cache for page rasters.
 *
 *  - Level of detail: each visible page asks for the smallest tier (long-side
 *    pixels) at or above its on-screen footprint; new pages are first shown
 *    at a fast preview tier, then upgraded.
 *  - Memory: an LRU over a byte budget; pages that are not wanted this frame
 *    are evicted first.
 *  - Scheduling: one raster job at a time (pdf.js serialises anyway), chosen
 *    by priority and deficit, cancelled as soon as it becomes irrelevant.
 *  - Detail tiles: when the camera is closer than the largest tier can serve,
 *    exactly the visible part of the page is rendered at native resolution.
 */
export class TextureManager {
  private readonly entries = new Map<number, PageTexture>();
  private readonly details = new Map<number, DetailTile>();
  private readonly wants = new Map<number, Want>();
  private readonly detailWants = new Map<number, { rect: THREE.Vector4; w: number; h: number }>();
  private job: Job | null = null;
  private readonly canvas = document.createElement('canvas');
  private readonly tiers: number[];
  private readonly budget: number;
  private readonly aniso: number;
  private bytes = 0;
  private disposed = false;
  private frameNo = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly source: PageSource,
    private readonly sheetAspect: number,
    private readonly onReady: () => void,
  ) {
    const caps = renderer.capabilities;
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    const maxTex = Math.min(caps.maxTextureSize, mem <= 4 ? 2048 : 4096);
    this.tiers = TIERS.filter((t) => t <= maxTex);
    this.budget = (mem <= 4 ? 140 : 360) * 1024 * 1024;
    this.aniso = caps.getMaxAnisotropy();
  }

  get maxTier(): number {
    return this.tiers[this.tiers.length - 1];
  }

  get usedBytes(): number {
    return this.bytes;
  }

  beginFrame(): void {
    this.wants.clear();
    this.detailWants.clear();
    this.frameNo++;
  }

  /** Declares that `page` should be available at ≥ `px` long-side pixels. Higher priority wins. */
  want(page: number, px: number, priority: number): void {
    if (page < 0 || page >= this.source.pageCount) return;
    const w = this.wants.get(page);
    if (w) {
      w.px = Math.max(w.px, px);
      w.priority = Math.max(w.priority, priority);
    } else this.wants.set(page, { px, priority });
  }

  /** Requests a detail tile covering `rect` (content uv) at w×h pixels. */
  wantDetail(page: number, rect: THREE.Vector4, w: number, h: number): void {
    this.detailWants.set(page, { rect, w, h });
  }

  get(page: number): PageTexture | undefined {
    const e = this.entries.get(page);
    if (e) e.lastUsed = this.frameNo;
    return e;
  }

  detail(page: number): DetailTile | undefined {
    return this.details.get(page);
  }

  tierFor(px: number): number {
    for (const t of this.tiers) if (t >= px * 0.85) return t;
    return this.maxTier;
  }

  /**
   * The source's pages changed (e.g. the built-in book re-typeset for another
   * reading direction). Every raster is re-rendered; the old ones stay on
   * screen until their replacements are ready, so nothing flashes blank.
   */
  refresh(): void {
    this.job?.abort.abort();
    for (const e of this.entries.values()) e.stale = true;
    for (const d of this.details.values()) {
      this.disposeTex(d.tex);
      this.bytes -= d.bytes;
    }
    this.details.clear();
    this.onReady();
  }

  /** Drops detail tiles that are no longer requested. */
  private pruneDetails(): void {
    for (const [page, d] of this.details) {
      const w = this.detailWants.get(page);
      if (!w || !sameRect(w.rect, d.rect)) {
        // keep a stale tile only while its replacement is being rendered
        if (w && this.job?.detail && this.job.page === page) continue;
        this.disposeTex(d.tex);
        this.bytes -= d.bytes;
        this.details.delete(page);
      }
    }
  }

  endFrame(): void {
    if (this.disposed) return;
    this.pruneDetails();
    // cancel a job that nobody wants any more
    if (this.job) {
      const j = this.job;
      const stillWanted = j.detail
        ? this.detailWants.has(j.page) && sameRect(this.detailWants.get(j.page)!.rect, j.detail.rect)
        : this.wants.has(j.page);
      if (!stillWanted) j.abort.abort();
      return;
    }
    const next = this.pickJob();
    if (next) void this.run(next);
  }

  private pickJob(): Job | null {
    let best: { page: number; tier: number; score: number } | null = null;
    for (const [page, w] of this.wants) {
      const have = this.entries.get(page);
      let target = this.tierFor(w.px);
      if (have && !have.stale && have.tier >= target) continue;
      // first appearance: show a quick preview before the full tier
      if (!have && target > 512) target = 512;
      const score = w.priority * 10 + (have && !have.stale ? 0 : 5) + target / 4096;
      if (!best || score > best.score) best = { page, tier: target, score };
    }
    if (best) return { page: best.page, tier: best.tier, abort: new AbortController() };
    // all base textures satisfied → detail tiles
    for (const [page, d] of this.detailWants) {
      const have = this.details.get(page);
      if (have && sameRect(have.rect, d.rect)) continue;
      return { page, tier: 0, abort: new AbortController(), detail: d };
    }
    return null;
  }

  private async run(job: Job): Promise<void> {
    this.job = job;
    try {
      const size = await this.source.pageSize(job.page);
      if (job.abort.signal.aborted) return;
      let w: number;
      let h: number;
      let region: PageRegion | undefined;
      if (job.detail) {
        w = job.detail.w;
        h = job.detail.h;
        const r = job.detail.rect;
        region = { x0: r.x, x1: r.x + r.z, y0: 1 - (r.y + r.w), y1: 1 - r.y };
      } else {
        const a = size.w / size.h;
        if (a >= 1) {
          w = job.tier;
          h = Math.max(1, Math.round(job.tier / a));
        } else {
          h = job.tier;
          w = Math.max(1, Math.round(job.tier * a));
        }
      }
      await this.source.render(job.page, this.canvas, w, h, region, job.abort.signal);
      if (job.abort.signal.aborted || this.disposed) return;
      const tex = await this.toTexture(this.canvas);
      if (job.abort.signal.aborted || this.disposed) {
        this.disposeTex(tex);
        return;
      }
      this.renderer.initTexture(tex);
      const bytes = Math.round(w * h * 4 * 1.34);
      if (job.detail) {
        const old = this.details.get(job.page);
        if (old) {
          this.disposeTex(old.tex);
          this.bytes -= old.bytes;
        }
        this.details.set(job.page, { tex, rect: job.detail.rect.clone(), bytes });
      } else {
        const old = this.entries.get(job.page);
        if (old) {
          this.disposeTex(old.tex);
          this.bytes -= old.bytes;
        }
        this.entries.set(job.page, {
          tex,
          rect: contentRect(size.w / size.h, this.sheetAspect),
          tier: job.tier,
          bytes,
          lastUsed: this.frameNo,
        });
      }
      this.bytes += bytes;
      this.evict();
      this.onReady();
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') console.warn('[explica] page render failed', job.page, e);
    } finally {
      if (this.job === job) this.job = null;
      // keep the queue moving even when no frame is being drawn
      if (!this.disposed) queueMicrotask(() => this.endFrame());
    }
  }

  private async toTexture(canvas: HTMLCanvasElement): Promise<THREE.Texture> {
    let tex: THREE.Texture;
    try {
      const bmp = await createImageBitmap(canvas, { imageOrientation: 'flipY' });
      tex = new THREE.Texture(bmp);
      tex.flipY = false;
    } catch {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext('2d')!.drawImage(canvas, 0, 0);
      tex = new THREE.CanvasTexture(copy);
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.aniso;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  private evict(): void {
    if (this.bytes <= this.budget) return;
    const victims = [...this.entries.entries()]
      .filter(([page]) => !this.wants.has(page))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [page, e] of victims) {
      if (this.bytes <= this.budget) break;
      this.disposeTex(e.tex);
      this.bytes -= e.bytes;
      this.entries.delete(page);
    }
  }

  private disposeTex(tex: THREE.Texture): void {
    const img = tex.image as ImageBitmap | undefined;
    tex.dispose();
    if (img && typeof (img as ImageBitmap).close === 'function') (img as ImageBitmap).close();
  }

  dispose(): void {
    this.disposed = true;
    this.job?.abort.abort();
    for (const e of this.entries.values()) this.disposeTex(e.tex);
    for (const d of this.details.values()) this.disposeTex(d.tex);
    this.entries.clear();
    this.details.clear();
    this.bytes = 0;
  }
}

/** Letter-boxes a page of aspect `page` (w/h) into a sheet of aspect `sheet`. */
export function contentRect(page: number, sheet: number): THREE.Vector4 {
  if (Math.abs(page - sheet) < 1e-3) return new THREE.Vector4(0, 0, 1, 1);
  if (page > sheet) {
    const h = sheet / page;
    return new THREE.Vector4(0, (1 - h) / 2, 1, h);
  }
  const w = page / sheet;
  return new THREE.Vector4((1 - w) / 2, 0, w, 1);
}

function sameRect(a: THREE.Vector4, b: THREE.Vector4): boolean {
  return (
    Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6 && Math.abs(a.w - b.w) < 1e-6
  );
}
