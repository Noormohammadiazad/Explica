import { isAnnotation, type Annotation } from './model';

/** The slice of the Web Storage API the store needs (injectable for tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'explica.annotations.';
const HISTORY = 100;

/**
 * A document's annotations, kept in browser storage under the document's
 * fingerprint. Nothing is written into the PDF and nothing leaves the device.
 * Changes are grouped into undoable steps (`begin` … `end`).
 */
export class AnnotationStore {
  private items: Annotation[] = [];
  private readonly undoStack: Annotation[][] = [];
  private readonly redoStack: Annotation[][] = [];
  private version = 0;
  private open: { version: number } | null = null;
  /** Pages whose annotations changed. */
  onChange: (pages: Set<number>) => void = () => {};
  /** Storage refused a write (full, or unavailable). */
  onError: (e: unknown) => void = () => {};

  constructor(
    readonly key: string,
    private readonly storage: KeyValueStorage | null,
  ) {
    this.load();
  }

  get all(): readonly Annotation[] {
    return this.items;
  }

  forPage(page: number): Annotation[] {
    return this.items.filter((a) => a.page === page);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Starts an undoable step; mutations until `end` undo together. */
  begin(): void {
    if (this.open) return;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.open = { version: this.version };
  }

  /** Ends the step; a step that changed nothing leaves no trace in the history. */
  end(): void {
    if (!this.open) return;
    if (this.version === this.open.version) this.undoStack.pop();
    else this.redoStack.length = 0;
    this.open = null;
  }

  add(a: Annotation): void {
    this.mutate(() => this.items.push(a), [a.page]);
  }

  remove(ids: Iterable<string>): void {
    const set = new Set(ids);
    const gone = this.items.filter((a) => set.has(a.id));
    if (!gone.length) return;
    this.mutate(() => (this.items = this.items.filter((a) => !set.has(a.id))), gone.map((a) => a.page));
  }

  update<T extends Annotation>(id: string, patch: Partial<T>): void {
    const a = this.items.find((x) => x.id === id);
    if (!a) return;
    this.mutate(() => Object.assign(a, patch), [a.page]);
  }

  undo(): boolean {
    return this.swap(this.undoStack, this.redoStack);
  }

  redo(): boolean {
    return this.swap(this.redoStack, this.undoStack);
  }

  private swap(from: Annotation[][], to: Annotation[][]): boolean {
    this.open = null;
    const prev = from.pop();
    if (!prev) return false;
    to.push(this.snapshot());
    const pages = new Set([...this.items, ...prev].map((a) => a.page));
    this.items = prev;
    this.version++;
    this.save();
    this.onChange(pages);
    return true;
  }

  private mutate(fn: () => void, pages: number[]): void {
    const implicit = !this.open;
    if (implicit) this.begin();
    fn();
    this.version++;
    if (implicit) this.end();
    this.save();
    this.onChange(new Set(pages));
  }

  private snapshot(): Annotation[] {
    return structuredClone(this.items);
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(PREFIX + this.key);
      if (!raw) return;
      const data = JSON.parse(raw) as { v?: number; items?: unknown[] };
      if (data?.v === 1 && Array.isArray(data.items)) this.items = data.items.filter(isAnnotation);
    } catch {
      this.items = []; // unreadable: start afresh rather than fail the document
    }
  }

  private save(): void {
    if (!this.storage) return;
    try {
      if (!this.items.length) this.storage.removeItem(PREFIX + this.key);
      else this.storage.setItem(PREFIX + this.key, JSON.stringify({ v: 1, items: this.items.map(compact) }));
    } catch (e) {
      this.onError(e);
    }
  }
}

/** Rounds coordinates for storage (1/100 000 of a page is far below a pixel). */
function compact(a: Annotation): Annotation {
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  if (a.kind === 'stroke') return { ...a, width: r(a.width), points: a.points.map(r) };
  if (a.kind === 'highlight') return { ...a, quads: a.quads.map((q) => q.map(r)) };
  return { ...a, x: r(a.x), y: r(a.y) };
}

/** The browser's localStorage, or null where it is unavailable (private modes, sandboxing). */
export function browserStorage(): KeyValueStorage | null {
  try {
    const s = globalThis.localStorage;
    const probe = '__explica_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
