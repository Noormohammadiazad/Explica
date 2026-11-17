import { gutterWidth, type StackSurface } from '../physics/surface';

export type Side = 'L' | 'R';

/**
 * Logical state of the book: which sheets lie on which stack, which are in
 * flight, and the geometry of the two stacks (heights, gutter, pivot).
 *
 * Sheet i carries PDF page 2i on its front (a right-hand page) and page 2i+1
 * on its back (a left-hand page once turned).
 */
export class BookLayout {
  readonly sheetCount: number;
  /** Visual thickness of one sheet [m]. */
  readonly sheetThickness: number;
  /** Height of the binding pivot [m]. */
  readonly pivotZ: number;
  private readonly side: Side[];
  private readonly flying = new Set<number>();

  constructor(
    readonly pageCount: number,
    readonly pageWidth: number,
    opts: { sheetThickness?: number; maxThickness?: number; pivotFraction?: number } = {},
  ) {
    this.sheetCount = Math.max(1, Math.ceil(pageCount / 2));
    const maxT = opts.maxThickness ?? 0.032;
    this.sheetThickness = Math.min(opts.sheetThickness ?? 1e-4, maxT / this.sheetCount);
    this.pivotZ = (opts.pivotFraction ?? 0.28) * this.totalThickness;
    this.side = new Array<Side>(this.sheetCount).fill('R');
  }

  get totalThickness(): number {
    return this.sheetCount * this.sheetThickness;
  }

  sideOf(i: number): Side {
    return this.side[i];
  }

  isFlying(i: number): boolean {
    return this.flying.has(i);
  }

  get flyingSheets(): number[] {
    return [...this.flying].sort((a, b) => a - b);
  }

  /** Topmost resting sheet of the right stack (smallest index), or −1. */
  topRight(): number {
    for (let i = 0; i < this.sheetCount; i++) {
      if (this.side[i] === 'R' && !this.flying.has(i)) return i;
    }
    return -1;
  }

  /** Topmost resting sheet of the left stack (largest index), or −1. */
  topLeft(): number {
    for (let i = this.sheetCount - 1; i >= 0; i--) {
      if (this.side[i] === 'L' && !this.flying.has(i)) return i;
    }
    return -1;
  }

  /** Number of resting sheets on a side. */
  restingCount(side: Side): number {
    let n = 0;
    for (let i = 0; i < this.sheetCount; i++) if (this.side[i] === side && !this.flying.has(i)) n++;
    return n;
  }

  /** Can sheet i be picked up right now? (top of a stack, or already in flight) */
  isGrabbable(i: number): boolean {
    return this.flying.has(i) || i === this.topLeft() || i === this.topRight();
  }

  /** Marks a resting sheet as picked up. */
  liftOff(i: number): void {
    this.flying.add(i);
  }

  /** Commits a flying sheet to a stack. */
  land(i: number, side: Side): void {
    this.flying.delete(i);
    this.side[i] = side;
  }

  /** Height of the stack beneath sheet i when it lies on the given side. */
  stackHeightUnder(i: number, side: Side): number {
    const n = side === 'R' ? this.sheetCount - 1 - i : i;
    return n * this.sheetThickness;
  }

  /** Stack surface sheet i would rest on, on the given side. */
  surfaceFor(i: number, side: Side): StackSurface {
    const top = this.stackHeightUnder(i, side);
    return { base: this.pivotZ, top, gutter: gutterWidth(top - this.pivotZ, this.pageWidth) };
  }

  /**
   * Instantly re-stacks the book so that 0-based PDF page `page` is visible.
   * Clears any flying state. Returns the sheets that changed side.
   */
  jumpToPage(page: number): number[] {
    const p = Math.max(0, Math.min(this.pageCount - 1, Math.round(page)));
    const leftCount = Math.floor((p + 1) / 2);
    const changed: number[] = [];
    this.flying.clear();
    for (let i = 0; i < this.sheetCount; i++) {
      const s: Side = i < leftCount ? 'L' : 'R';
      if (this.side[i] !== s) changed.push(i);
      this.side[i] = s;
    }
    return changed;
  }

  /** Number of sheets on the left, counting flying sheets by the side they came from. */
  get leftCount(): number {
    let n = 0;
    for (let i = 0; i < this.sheetCount; i++) if (this.side[i] === 'L') n++;
    return n;
  }

  /** PDF pages (0-based) currently facing the reader, or null for none. */
  visiblePages(): { left: number | null; right: number | null } {
    const l = this.topLeft();
    const r = this.topRight();
    const left = l >= 0 && 2 * l + 1 < this.pageCount ? 2 * l + 1 : null;
    const right = r >= 0 && 2 * r < this.pageCount ? 2 * r : null;
    return { left, right };
  }

  /**
   * The spread being read, counting sheets in flight on the side they came
   * from (a page held mid-turn has not been turned yet).
   */
  readingSpread(): { left: number | null; right: number | null } {
    let l = -1;
    let r = -1;
    for (let i = 0; i < this.sheetCount; i++) {
      if (this.side[i] === 'L') l = i;
      else if (r < 0) r = i;
    }
    return {
      left: l >= 0 && 2 * l + 1 < this.pageCount ? 2 * l + 1 : null,
      right: r >= 0 && 2 * r < this.pageCount ? 2 * r : null,
    };
  }

  /** Front (even) and back (odd) PDF page indices of a sheet; null if blank. */
  pagesOf(i: number): { front: number | null; back: number | null } {
    const f = 2 * i;
    const b = 2 * i + 1;
    return { front: f < this.pageCount ? f : null, back: b < this.pageCount ? b : null };
  }
}
