import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { AbortError, type PageRegion, type PageSource, type TextRun } from './pageSource';
import type { ReadingDirection } from '../book/readingDirection';
import { detectDirection } from '../book/detectDirection';
import { fingerprint } from './fingerprint';

/** Where pdf.js finds its workers and runtime data. Every URL may be relative to the page. */
export interface PdfjsConfig {
  /** pdf.js's worker script (`pdf.worker.min.mjs`). Required before the first PDF opens. */
  workerSrc?: string | URL;
  /**
   * pdf.js's renderer worker (`pdf.renderer.min.mjs`). When set, pages are
   * rasterised in it (OffscreenCanvas), which keeps the main thread, and the
   * physics, free while pages are drawn.
   */
  rendererSrc?: string | URL;
  /**
   * Folder holding pdf.js's `cmaps/`, `standard_fonts/`, `wasm/` and `iccs/`
   * (copies of the folders of the same names in `pdfjs-dist`). Default: `pdfjs/`
   * beside the page. Without them most PDFs still open, but CJK text with
   * predefined CMaps, non-embedded standard fonts and JPEG 2000 / JBIG2 images
   * may not render faithfully.
   */
  assetsUrl?: string | URL;
}

let assetsUrl: string | URL = 'pdfjs/';

/** Points pdf.js at its workers and data. Options left out keep their current value. */
export function configurePdfjs(c: PdfjsConfig): void {
  if (c.workerSrc != null) pdfjs.GlobalWorkerOptions.workerSrc = new URL(c.workerSrc, document.baseURI).href;
  if (c.rendererSrc != null) pdfjs.GlobalWorkerOptions.rendererSrc = new URL(c.rendererSrc, document.baseURI).href;
  if (c.assetsUrl != null) assetsUrl = c.assetsUrl;
}

const asset = (p: string) => {
  const base = new URL(assetsUrl, document.baseURI).href;
  return new URL(p, base.endsWith('/') ? base : `${base}/`).href;
};

/**
 * A local PDF, parsed and rasterised entirely on-device by pdf.js. The bytes
 * come from the File API and never leave the browser.
 */
export class PdfSource implements PageSource {
  private readonly pages = new Map<number, Promise<PDFPageProxy>>();
  private readonly order: number[] = [];
  private readonly sizes = new Map<number, { w: number; h: number }>();

  private constructor(
    private readonly doc: PDFDocumentProxy,
    readonly name: string,
    readonly baseSize: { w: number; h: number },
    readonly key: string,
  ) {}

  direction: ReadingDirection | undefined;
  directionSource: 'declared' | 'detected' | undefined;

  get pageCount(): number {
    return this.doc.numPages;
  }

  static async open(
    data: ArrayBuffer,
    name: string,
    opts: { onProgress?: (f: number) => void; onPassword?: (retry: boolean) => Promise<string | null> } = {},
  ): Promise<PdfSource> {
    // before pdf.js takes the bytes (it transfers them to its worker)
    const key = await fingerprint(data);
    const task = pdfjs.getDocument({
      data: new Uint8Array(data),
      cMapUrl: asset('pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: asset('pdfjs/standard_fonts/'),
      wasmUrl: asset('pdfjs/wasm/'),
      iccUrl: asset('pdfjs/iccs/'),
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
    });
    task.onProgress = (p: { loaded: number; total: number }) => {
      if (p.total) opts.onProgress?.(p.loaded / p.total);
    };
    task.onPassword = (update: (pw: string) => void, reason: number) => {
      const retry = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
      void (opts.onPassword?.(retry) ?? Promise.resolve(null)).then((pw) => {
        if (pw == null) void task.destroy();
        else update(pw);
      });
    };
    const doc = await task.promise;
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    const src = new PdfSource(doc, name, { w: vp.width, h: vp.height }, key);
    src.pages.set(0, Promise.resolve(first));
    src.order.push(0);
    src.sizes.set(0, { w: vp.width, h: vp.height });
    // direction: what the file declares, else what its script says
    const declared = await declaredDirection(doc);
    if (declared) [src.direction, src.directionSource] = [declared, 'declared'];
    else {
      const detected = await src.detectDirection();
      if (detected) [src.direction, src.directionSource] = [detected, 'detected'];
    }
    return src;
  }

  private page(i: number): Promise<PDFPageProxy> {
    let p = this.pages.get(i);
    if (!p) {
      p = this.doc.getPage(i + 1);
      this.pages.set(i, p);
    }
    const at = this.order.indexOf(i);
    if (at >= 0) this.order.splice(at, 1);
    this.order.push(i);
    // keep a bounded working set of parsed pages; free the rest
    while (this.order.length > 24) {
      const old = this.order.shift()!;
      const pr = this.pages.get(old);
      this.pages.delete(old);
      void pr?.then((pg) => pg.cleanup()).catch(() => {});
    }
    return p;
  }

  async pageSize(i: number): Promise<{ w: number; h: number }> {
    const known = this.sizes.get(i);
    if (known) return known;
    const pg = await this.page(i);
    const vp = pg.getViewport({ scale: 1 });
    const s = { w: vp.width, h: vp.height };
    this.sizes.set(i, s);
    return s;
  }

  async render(
    i: number,
    canvas: HTMLCanvasElement,
    w: number,
    h: number,
    region?: PageRegion,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new AbortError();
    const pg = await this.page(i);
    if (signal?.aborted) throw new AbortError();
    const base = pg.getViewport({ scale: 1 });
    this.sizes.set(i, { w: base.width, h: base.height });
    const r = region ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
    const scale = w / ((r.x1 - r.x0) * base.width);
    const viewport = pg.getViewport({
      scale,
      offsetX: -r.x0 * base.width * scale,
      offsetY: -r.y0 * base.height * scale,
    });
    canvas.width = w;
    canvas.height = h;
    const task = pg.render({
      canvas,
      viewport,
      intent: 'display',
      annotationMode: pdfjs.AnnotationMode.ENABLE,
      background: '#ffffff',
    });
    const onAbort = () => task.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await task.promise;
    } catch (e) {
      if (signal?.aborted || (e as Error)?.name === 'RenderingCancelledException') throw new AbortError();
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private readonly text = new Map<number, Promise<TextRun[]>>();

  /** Samples the text of the first pages (until enough letters) and tells its writing direction. */
  private async detectDirection(): Promise<ReadingDirection | undefined> {
    let sample = '';
    for (let i = 0; i < Math.min(8, this.pageCount) && sample.length < 4000; i++) {
      try {
        sample += (await this.textContent(i)).map((r) => r.str).join(' ') + ' ';
      } catch {
        /* an unreadable page says nothing */
      }
    }
    return detectDirection(sample);
  }

  /**
   * The page's text runs (pdf.js `getTextContent`), mapped through the page's
   * own viewport so rotation and /Rotate are already applied. Cached per page.
   */
  textContent(i: number): Promise<TextRun[]> {
    let t = this.text.get(i);
    if (!t) {
      t = this.page(i).then(async (page) => {
        const vp = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const runs: TextRun[] = [];
        for (const item of content.items) {
          if (!('str' in item) || !item.str) {
            if (runs.length && 'hasEOL' in item && item.hasEOL) runs[runs.length - 1].eol = true;
            continue;
          }
          const m = pdfjs.Util.transform(vp.transform, item.transform) as number[];
          const size = Math.hypot(m[2], m[3]);
          if (!(size > 0)) continue;
          runs.push({
            str: item.str,
            x: m[4],
            y: m[5],
            width: item.width * Math.hypot(vp.transform[0], vp.transform[1]),
            size,
            angle: Math.atan2(m[1], m[0]),
            eol: !!item.hasEOL,
          });
        }
        return runs;
      });
      t.catch(() => this.text.delete(i));
      this.text.set(i, t);
      if (this.text.size > 32) this.text.delete(this.text.keys().next().value!);
    }
    return t;
  }

  async destroy(): Promise<void> {
    this.pages.clear();
    await this.doc.loadingTask.destroy();
  }
}

/** /ViewerPreferences /Direction: /R2L marks a right-to-left document (e.g. Persian or Arabic). */
async function declaredDirection(doc: PDFDocumentProxy): Promise<ReadingDirection | undefined> {
  try {
    const dir = (await doc.getViewerPreferences())?.get('Direction');
    return dir === 'R2L' ? 'rtl' : dir === 'L2R' ? 'ltr' : undefined;
  } catch {
    return undefined;
  }
}
