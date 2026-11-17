import type { ReadingDirection } from '../book/readingDirection';

/** A region of a page in normalised page coordinates (origin top-left, y down). */
export interface PageRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A run of text on a page, for the selectable text layer. Page points from the
 * page's top-left corner, y down (the same frame `pageSize` measures).
 */
export interface TextRun {
  str: string;
  /** Start of the baseline. */
  x: number;
  y: number;
  /** Advance along the baseline [pt]. */
  width: number;
  /** Font size [pt]. */
  size: number;
  /** Direction of the baseline, radians clockwise from +x. */
  angle: number;
  /** A line break follows this run (copied text keeps its lines). */
  eol: boolean;
}

/** Anything that can rasterise pages: a PDF, or the built-in sample document. */
export interface PageSource {
  readonly name: string;
  readonly pageCount: number;
  /**
   * Reading direction of the document, if known: declared (PDF /ViewerPreferences
   * /Direction) or detected from the script of its text.
   */
  readonly direction?: ReadingDirection;
  /** How `direction` was found. */
  readonly directionSource?: 'declared' | 'detected';
  /** Stable identity of the document's content (its annotations are stored under it). */
  readonly key?: string;
  /** Size of the first page in PDF points (1/72 in), used to size the sheets. */
  readonly baseSize: { w: number; h: number };
  /** Size of page i in points (resolves lazily for PDFs). */
  pageSize(i: number): Promise<{ w: number; h: number }>;
  /**
   * Renders page i into `canvas`, which is resized to w×h. If `region` is
   * given, only that part of the page is rendered (filling the canvas).
   */
  render(i: number, canvas: HTMLCanvasElement, w: number, h: number, region?: PageRegion, signal?: AbortSignal): Promise<void>;
  /** The page's text with positions, in reading order, if the source has any. */
  textContent?(i: number): Promise<TextRun[]>;
  /**
   * Typesets the pages for a reading direction, if the source can (the
   * built-in book can; a PDF's pages are fixed). Returns true if pages changed.
   */
  setReadingDirection?(d: ReadingDirection): boolean;
  destroy(): Promise<void>;
}

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}
