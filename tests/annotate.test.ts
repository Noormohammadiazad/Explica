import { describe, expect, it } from 'vitest';
import { annotationsAt, inQuad, isAnnotation, quadsOverlap, simplify, type Annotation, type Stroke } from '../src/annotate/model';
import { AnnotationStore, type KeyValueStorage } from '../src/annotate/store';
import { detectDirection, scriptCounts } from '../src/book/detectDirection';
import { fingerprint } from '../src/pdf/fingerprint';
import { reduce, IDLE, type GestureEvent, type GestureState, type Effect } from '../src/input/gestures';

class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  full = false;
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.full) throw new DOMException('full', 'QuotaExceededError');
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const stroke = (page: number, points: number[], id = `s${page}`): Stroke => ({ id, kind: 'stroke', page, color: '#000', width: 0.006, points });
const box = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h];

describe('Annotation geometry', () => {
  it('simplifies a polyline but keeps its shape and ends', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 100; i++) pts.push(i / 100, 0.5 + 1e-5 * Math.sin(i)); // a wobbly straight line
    const s = simplify(pts, 0.0004);
    expect(s).toEqual([0, pts[1], 1, pts[pts.length - 1]]);
    const corner = simplify([0, 0, 0.5, 0, 0.5, 0.0001, 0.5, 0.5], 0.001);
    expect(corner).toEqual([0, 0, 0.5, 0, 0.5, 0.5]);
  });

  it('tests points in quads and quads against quads', () => {
    const q = box(0.1, 0.1, 0.3, 0.05);
    expect(inQuad(q, 0.2, 0.12)).toBe(true);
    expect(inQuad(q, 0.2, 0.2)).toBe(false);
    expect(quadsOverlap(q, box(0.35, 0.12, 0.2, 0.05))).toBe(true);
    expect(quadsOverlap(q, box(0.45, 0.1, 0.2, 0.05))).toBe(false);
    expect(quadsOverlap(q, box(0.1, 0.16, 0.3, 0.05))).toBe(false); // the next line
  });

  it('finds what an eraser touches, isotropically on a tall page', () => {
    const items: Annotation[] = [
      stroke(0, [0.1, 0.5, 0.9, 0.5]),
      { id: 'h', kind: 'highlight', page: 0, color: '#ff0', quads: [box(0.1, 0.2, 0.4, 0.02)], text: 'x' },
      { id: 'n', kind: 'note', page: 0, x: 0.8, y: 0.8, text: '' },
      stroke(1, [0.1, 0.5, 0.9, 0.5], 'other-page'),
    ];
    const aspect = 1.414; // A-series: height / width
    expect(annotationsAt(items, 0, 0.5, 0.505, 0.01, aspect).map((a) => a.id)).toEqual(['s0']);
    expect(annotationsAt(items, 0, 0.3, 0.21, 0.01, aspect).map((a) => a.id)).toEqual(['h']);
    expect(annotationsAt(items, 0, 0.81, 0.81, 0.005, aspect).map((a) => a.id)).toEqual(['n']);
    expect(annotationsAt(items, 0, 0.5, 0.6, 0.01, aspect)).toEqual([]);
    // 0.02 of the page *height* below the stroke is 0.028 page widths: out of a 0.02 reach
    expect(annotationsAt(items, 0, 0.5, 0.52, 0.02 - 0.003, aspect)).toEqual([]);
  });

  it('accepts only well-formed annotations from storage', () => {
    expect(isAnnotation(stroke(0, [0, 0, 1, 1]))).toBe(true);
    expect(isAnnotation({ id: 'a', kind: 'stroke', page: 0, color: '#000', width: 0.01, points: [0, 0, 1] })).toBe(false);
    expect(isAnnotation({ id: 'a', kind: 'note', page: -1, x: 0, y: 0, text: '' })).toBe(false);
    expect(isAnnotation({ id: 'a', kind: 'highlight', page: 2, color: '#ff0', quads: [[0, 0, 1]], text: '' })).toBe(false);
    expect(isAnnotation({ id: 'a', kind: 'virus', page: 0 })).toBe(false);
    expect(isAnnotation(null)).toBe(false);
  });
});

describe('Annotation store', () => {
  it('persists per document key, survives a reload, and leaves other documents alone', () => {
    const mem = new MemoryStorage();
    const a = new AnnotationStore('sha256:aaa', mem);
    a.add(stroke(3, [0.123456789, 0.5, 0.9, 0.5]));
    const b = new AnnotationStore('sha256:bbb', mem);
    expect(b.all).toEqual([]);
    const again = new AnnotationStore('sha256:aaa', mem);
    expect(again.all.length).toBe(1);
    expect((again.all[0] as Stroke).points[0]).toBe(0.12346); // stored rounded to 1e-5
    expect(again.forPage(3).length).toBe(1);
    expect(again.forPage(2).length).toBe(0);
    // empty documents leave no key behind
    again.remove([again.all[0].id]);
    expect([...mem.data.keys()]).toEqual([]);
  });

  it('groups a gesture into one undo step; a step that changed nothing leaves no trace', () => {
    const s = new AnnotationStore('k', new MemoryStorage());
    s.add(stroke(0, [0, 0, 1, 1], 'a'));
    s.add(stroke(0, [0, 0, 1, 1], 'b'));
    s.begin();
    s.remove(['a']);
    s.remove(['b']);
    s.end();
    expect(s.all.length).toBe(0);
    s.undo();
    expect(s.all.map((x) => x.id)).toEqual(['a', 'b']);
    s.redo();
    expect(s.all.length).toBe(0);
    s.undo();
    s.begin(); // an eraser pass that touched nothing
    s.end();
    s.undo();
    expect(s.all.map((x) => x.id)).toEqual(['a']); // undid the add of 'b', not an empty step
  });

  it('reports which pages changed, and storage failures', () => {
    const mem = new MemoryStorage();
    const s = new AnnotationStore('k', mem);
    const pages: number[][] = [];
    let failed = 0;
    s.onChange = (p) => pages.push([...p]);
    s.onError = () => failed++;
    s.add(stroke(4, [0, 0, 1, 1]));
    mem.full = true;
    s.add(stroke(7, [0, 0, 1, 1], 'x'));
    expect(pages).toEqual([[4], [7]]);
    expect(failed).toBe(1);
    expect(s.all.length).toBe(2); // still shown for this visit
  });

  it('starts afresh on corrupt storage, keeping only valid entries', () => {
    const mem = new MemoryStorage();
    mem.setItem('explica.annotations.k', '{not json');
    expect(new AnnotationStore('k', mem).all).toEqual([]);
    mem.setItem('explica.annotations.k', JSON.stringify({ v: 1, items: [stroke(0, [0, 0, 1, 1]), { kind: 'bogus' }] }));
    expect(new AnnotationStore('k', mem).all.length).toBe(1);
  });
});

describe('Reading direction from the text', () => {
  it('counts strong letters of each direction, ignoring digits and punctuation', () => {
    expect(scriptCounts('سلام، دنیا! 123')).toEqual({ rtl: 8, ltr: 0 });
    expect(scriptCounts('Hello, world 42')).toEqual({ rtl: 0, ltr: 10 });
  });

  it('tells Persian, Arabic, Urdu and Hebrew from English, and abstains on too little text', () => {
    expect(detectDirection('این یک کتاب فارسی است که از راست به چپ خوانده می‌شود')).toBe('rtl');
    expect(detectDirection('هذا كتاب عربي يقرأ من اليمين إلى اليسار')).toBe('rtl');
    expect(detectDirection('یہ ایک اردو کتاب ہے جو دائیں سے بائیں پڑھی جاتی ہے')).toBe('rtl');
    expect(detectDirection('זהו ספר בעברית שנקרא מימין לשמאל ובו הרבה מילים')).toBe('rtl');
    expect(detectDirection('This is an English book, read from left to right.')).toBe('ltr');
    // a Persian page quoting a few English terms is still Persian
    expect(detectDirection('مدل کتاب در Explica با WebGL و physics ساخته شده و بسیار زیبا است و خوانا')).toBe('rtl');
    expect(detectDirection('12 34 — 56')).toBeUndefined();
    expect(detectDirection('سلام')).toBeUndefined(); // too few letters to be sure
  });
});

describe('Document fingerprint', () => {
  it('is a stable SHA-256 of the bytes, different for different files', async () => {
    const enc = new TextEncoder();
    const a = enc.encode('%PDF-1.7 hello').buffer as ArrayBuffer;
    const b = enc.encode('%PDF-1.7 hellp').buffer as ArrayBuffer;
    const fa = await fingerprint(a);
    expect(fa).toMatch(/^sha256:[0-9a-f]{64}$/);
    // the FIPS 180-2 test vector
    expect(await fingerprint(enc.encode('abc').buffer as ArrayBuffer)).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await fingerprint(a.slice(0))).toBe(fa);
    expect(await fingerprint(b)).not.toBe(fa);
  });
});

describe('Annotation gestures', () => {
  const noMods = { alt: false, shift: false, ctrl: false, meta: false, space: false };
  const ev = (type: GestureEvent['type'], x: number, y: number, extra: Partial<GestureEvent> = {}): GestureEvent => ({
    type,
    id: 1,
    x,
    y,
    t: 0,
    button: 0,
    pointerType: 'mouse',
    mods: noMods,
    ...extra,
  });
  const run = (events: GestureEvent[], s: GestureState = IDLE) => {
    const effects: Effect[] = [];
    let state = s;
    for (const e of events) {
      const r = reduce(state, e);
      state = r.state;
      effects.push(...r.effects);
    }
    return { state, effects };
  };
  const tool = { kind: 'sheet' as const, sheet: 1, u: 0.05, v: 0, flying: false, annotate: true };

  it('a tool acts from the first point: no threshold, no turn', () => {
    const { state, effects } = run([ev('down', 10, 10, { hit: tool }), ev('move', 11, 10), ev('move', 40, 12), ev('up', 40, 12)]);
    expect(state.mode).toBe('idle');
    expect(effects.map((e) => e.type)).toEqual(['annotateStart', 'annotateTo', 'annotateTo', 'annotateEnd']);
    expect(run([ev('down', 10, 10, { hit: tool }), ev('up', 10, 10)]).effects.map((e) => e.type)).toEqual(['annotateStart', 'annotateEnd']);
  });

  it('with a tool active, the book can still be handled: Alt orbits, Shift / right-drag pan, background orbits', () => {
    expect(run([ev('down', 0, 0, { hit: tool, mods: { ...noMods, alt: true } }), ev('move', 30, 0), ev('up', 30, 0)]).effects[0].type).toBe('orbit');
    expect(run([ev('down', 0, 0, { hit: tool, button: 2 }), ev('move', 5, 0), ev('up', 5, 0)]).effects[0].type).toBe('pan');
    expect(run([ev('down', 0, 0, { hit: { kind: 'background' } }), ev('move', 30, 0), ev('up', 30, 0)]).effects[0].type).toBe('orbit');
  });

  it('a second finger ends the stroke and becomes a pinch', () => {
    const t = { pointerType: 'touch' as const };
    const { state, effects } = run([ev('down', 0, 0, { ...t, hit: tool }), ev('move', 20, 0, t), ev('down', 100, 0, { ...t, id: 2, hit: { kind: 'background' } })]);
    expect(state.mode).toBe('twoFinger');
    expect(effects.map((e) => e.type)).toEqual(['annotateStart', 'annotateTo', 'annotateEnd']);
  });
});
