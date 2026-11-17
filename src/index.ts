/**
 * Explica as a library: the 3D book (`ExplicaApp`) and the page sources it reads
 * (`PdfSource` for PDFs, `WelcomeSource` for the built-in sample document).
 *
 * The app at the root of the repository is one consumer of this API; its
 * toolbar, dialogs and annotation chrome are not part of the package.
 */
import { configurePdfjs } from './pdf/pdfSource';

// pdf.js's workers ship beside this module. Bundlers (Vite, webpack 5, Parcel,
// Rollup with an asset plugin) see these `new URL(…, import.meta.url)` and emit
// the files with the bundle; an unbundled import resolves them in place.
// `configurePdfjs` overrides them, for example to serve the workers elsewhere.
// (The markers keep the library build from resolving them; it removes them.)
configurePdfjs({
  workerSrc: new URL(/* @vite-ignore */ './pdf.worker.min.mjs', import.meta.url),
  rendererSrc: new URL(/* @vite-ignore */ './pdf.renderer.min.mjs', import.meta.url),
});

export { ExplicaApp, type ExplicaOptions, type SpreadInfo, type FrameStats } from './app';
export { PdfSource, configurePdfjs, type PdfjsConfig } from './pdf/pdfSource';
export { WelcomeSource } from './pdf/welcomeSource';
export { AbortError, type PageSource, type PageRegion, type TextRun } from './pdf/pageSource';
export type { ReadingDirection } from './book/readingDirection';
export type { Theme } from './ui/theme';
export {
  HIGHLIGHT_COLORS,
  PEN_COLORS,
  PEN_WIDTHS,
  type Tool,
  type Annotation,
  type Highlight,
  type Stroke,
  type Note,
} from './annotate/model';
export { DEFAULT_PAPER, paperForGrammage, type PaperParams } from './physics/params';
