import { describe, expect, it } from 'vitest';
import { IDLE, reduce, classifyWheel, type GestureEvent, type GestureState, type Effect, type Hit } from '../src/input/gestures';
import { ArcDragSurface, PlaneDragSurface, clampReach } from '../src/input/dragSurface';
import { BookLayout } from '../src/book/bookLayout';
import { AutoTurn } from '../src/book/autoTurn';
import { pickSheet, type RayHit } from '../src/input/pick';

const noMods = { alt: false, shift: false, ctrl: false, meta: false, space: false };
const sheetHit: Hit = { kind: 'sheet', sheet: 0, u: 0.1, v: -0.05, flying: false };

function ev(type: GestureEvent['type'], x: number, y: number, extra: Partial<GestureEvent> = {}): GestureEvent {
  return { type, id: 1, x, y, t: 0, button: 0, pointerType: 'mouse', mods: noMods, ...extra };
}

function run(events: GestureEvent[], s: GestureState = IDLE): { state: GestureState; effects: Effect[] } {
  const effects: Effect[] = [];
  let state = s;
  for (const e of events) {
    const r = reduce(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

describe('Gesture state machine', () => {
  it('a drag that starts on a page grabs it at the down point, follows, and releases', () => {
    const { state, effects } = run([
      ev('down', 100, 100, { hit: sheetHit }),
      ev('move', 102, 101),
      ev('move', 120, 90),
      ev('move', 140, 80),
      ev('up', 140, 80),
    ]);
    expect(state.mode).toBe('idle');
    expect(effects.map((e) => e.type)).toEqual(['grab', 'dragTo', 'dragTo', 'release']);
    expect(effects[0]).toMatchObject({ sheet: 0, u: 0.1, v: -0.05, x: 100, y: 100 });
  });

  it('a click on a page without movement is a tap (auto-turn)', () => {
    const { effects } = run([ev('down', 50, 50, { hit: sheetHit }), ev('move', 51, 51), ev('up', 51, 51)]);
    expect(effects.map((e) => e.type)).toEqual(['tap']);
  });

  it('a drag on the background orbits the book, never touching pages', () => {
    const { effects } = run([
      ev('down', 10, 10, { hit: { kind: 'background' } }),
      ev('move', 30, 10),
      ev('move', 40, 15),
      ev('up', 40, 15),
    ]);
    expect(effects.map((e) => e.type)).toEqual(['orbit', 'orbit', 'orbitEnd']);
    expect(effects[0]).toMatchObject({ dx: 20, dy: 0 });
    expect(effects[1]).toMatchObject({ dx: 10, dy: 5 });
  });

  it('Alt-drag on a page orbits instead of turning (escape hatch when zoomed in)', () => {
    const { effects } = run([
      ev('down', 10, 10, { hit: sheetHit, mods: { ...noMods, alt: true } }),
      ev('move', 30, 10),
      ev('up', 30, 10),
    ]);
    expect(effects.map((e) => e.type)).toEqual(['orbit', 'orbitEnd']);
  });

  it('right button, middle button, Shift and Space pan', () => {
    for (const extra of [{ button: 2 }, { button: 1 }, { mods: { ...noMods, shift: true } }, { mods: { ...noMods, space: true } }]) {
      const { effects } = run([
        ev('down', 0, 0, { hit: sheetHit, ...extra }),
        ev('move', 5, 7, extra),
        ev('up', 5, 7, extra),
      ]);
      expect(effects.map((e) => e.type)).toEqual(['pan', 'panEnd']);
    }
  });

  it('a second finger during a page drag releases the page and starts a pinch', () => {
    const t = { pointerType: 'touch' as const };
    const { state, effects } = run([
      ev('down', 100, 100, { ...t, hit: sheetHit }),
      ev('move', 130, 100, t),
      ev('down', 200, 100, { ...t, id: 2, hit: { kind: 'background' } }),
      ev('move', 250, 100, { ...t, id: 2 }),
    ]);
    expect(state.mode).toBe('twoFinger');
    const types = effects.map((e) => e.type);
    expect(types).toEqual(['grab', 'dragTo', 'release', 'pinch']);
    const pinch = effects[3] as Extract<Effect, { type: 'pinch' }>;
    expect(pinch.scale).toBeCloseTo(120 / 70, 9);
    expect(pinch.twist).toBeCloseTo(0, 9);
  });

  it('pinch twist, then lifting fingers settles back to idle without stray gestures', () => {
    const t = { pointerType: 'touch' as const };
    const { state, effects } = run([
      ev('down', 0, 0, { ...t, hit: { kind: 'background' } }),
      ev('down', 100, 0, { ...t, id: 2, hit: { kind: 'background' } }),
      ev('move', 100, 100, { ...t, id: 2 }), // rotate 45°
      ev('up', 100, 100, { ...t, id: 2 }),
      ev('move', 50, 50, t), // ignored
      ev('up', 50, 50, t),
    ]);
    expect(state.mode).toBe('idle');
    expect(effects.map((e) => e.type)).toEqual(['pinch', 'pinchEnd']);
    expect((effects[0] as Extract<Effect, { type: 'pinch' }>).twist).toBeCloseTo(Math.PI / 4, 9);
  });

  it('ignores events from unrelated pointers mid-gesture', () => {
    const { effects } = run([
      ev('down', 0, 0, { hit: sheetHit }),
      ev('move', 20, 0),
      ev('move', 500, 500, { id: 9 }),
      ev('up', 500, 500, { id: 9 }),
      ev('up', 20, 0),
    ]);
    expect(effects.map((e) => e.type)).toEqual(['grab', 'dragTo', 'release']);
  });

  it('classifies wheel input', () => {
    expect(classifyWheel({ deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false })).toBe('zoom');
    expect(classifyWheel({ deltaX: 0, deltaY: -2.5, deltaMode: 0, ctrlKey: true })).toBe('zoom');
    expect(classifyWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false })).toBe('zoom');
    expect(classifyWheel({ deltaX: 3, deltaY: 12, deltaMode: 0, ctrlKey: false })).toBe('pan');
  });
});

describe('Drag surface', () => {
  const s = ArcDragSurface.forGrab(0.14, 0.01, 0.002);
  it('is flat with zero slope at the grab and rises to its peak over the spine', () => {
    expect(s.height(0.14)).toBeCloseTo(0.01, 12);
    expect(s.height(0.2)).toBeCloseTo(0.01, 12);
    expect((s.height(0.14 - 1e-5) - s.height(0.14)) / 1e-5).toBeLessThan(1e-3);
    expect(s.height(0)).toBeGreaterThan(0.07);
    expect(s.height(-0.14)).toBeCloseTo(0.002, 12);
  });

  it('a top-down ray lands exactly on the height field', () => {
    for (const x of [0.12, 0.05, 0, -0.07]) {
      const p = s.intersect([x, 0.03, 1], [0, 0, -1]);
      expect(p).not.toBeNull();
      expect(p![0]).toBeCloseTo(x, 9);
      expect(p![2]).toBeCloseTo(s.height(x), 9);
    }
  });

  it('an oblique ray finds the first crossing', () => {
    const o: [number, number, number] = [0.3, -0.4, 0.5];
    const d = [-0.4, 0.6, -0.69];
    const n = Math.hypot(...d);
    const p = s.intersect(o, [d[0] / n, d[1] / n, d[2] / n]);
    expect(p).not.toBeNull();
    expect(p![2]).toBeCloseTo(s.height(p![0]), 7);
  });

  it('plane surface intersects and clamp keeps targets within reach', () => {
    const pl = new PlaneDragSurface([0, 0, 0.05], [0, 0, 1]);
    const hit = pl.intersect([0.1, 0.1, 1], [0, 0, -1])!;
    [0.1, 0.1, 0.05].forEach((v, i) => expect(hit[i]).toBeCloseTo(v, 12));
    const c = clampReach([1, 0, 1], 0, 0.1, 0);
    expect(Math.hypot(c[0], c[2])).toBeLessThanOrEqual(0.1 * 1.08 + 0.01 + 1e-12);
  });
});

describe('Book layout', () => {
  it('pairs pages onto sheets and tracks the visible spread', () => {
    const b = new BookLayout(7, 0.15);
    expect(b.sheetCount).toBe(4);
    expect(b.visiblePages()).toEqual({ left: null, right: 0 });
    expect(b.pagesOf(3)).toEqual({ front: 6, back: null });
    b.liftOff(0);
    expect(b.topRight()).toBe(1);
    expect(b.isGrabbable(0)).toBe(true);
    expect(b.isGrabbable(2)).toBe(false);
    b.land(0, 'L');
    expect(b.visiblePages()).toEqual({ left: 1, right: 2 });
  });

  it('jumps to any page and stacks heights consistently', () => {
    const b = new BookLayout(100, 0.15);
    b.jumpToPage(41);
    expect(b.visiblePages()).toEqual({ left: 41, right: 42 });
    b.jumpToPage(40);
    expect(b.visiblePages()).toEqual({ left: 39, right: 40 });
    const t = b.sheetThickness;
    expect(b.stackHeightUnder(b.topRight(), 'R')).toBeCloseTo((b.sheetCount - 1 - b.topRight()) * t, 12);
    expect(b.stackHeightUnder(b.topLeft(), 'L')).toBeCloseTo(b.topLeft() * t, 12);
  });

  it('caps the visual thickness of huge documents', () => {
    const b = new BookLayout(5000, 0.15);
    expect(b.totalThickness).toBeLessThanOrEqual(0.032 + 1e-12);
  });
});

describe('Automatic turn', () => {
  it('sweeps the hand from the grab point over the spine to the other stack', () => {
    const a = new AutoTurn([0.13, -0.07, 0.006], 0.004, 0.6);
    const xs: number[] = [];
    let maxZ = 0;
    while (!a.done) {
      const { target } = a.advance(1 / 60);
      xs.push(target[0]);
      maxZ = Math.max(maxZ, target[2]);
    }
    expect(xs[0]).toBeGreaterThan(0.12);
    expect(xs[xs.length - 1]).toBeLessThan(-0.12);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThanOrEqual(xs[i - 1] + 1e-12);
    expect(maxZ).toBeGreaterThan(0.06);
  });
});

describe('Reading spread', () => {
  it('a page held mid-turn still counts as unturned', () => {
    const b = new BookLayout(10, 0.15);
    b.liftOff(0);
    expect(b.readingSpread()).toEqual({ left: null, right: 0 });
    b.land(0, 'L');
    expect(b.readingSpread()).toEqual({ left: 1, right: 2 });
  });
});

describe('Picking a page with the pointer', () => {
  const all = () => true;
  const sheet = (s: number, face: 'front' | 'back', resting: 'L' | 'R' | null, facesRay = true): RayHit => ({
    kind: 'sheet',
    sheet: s,
    face,
    facesRay,
    resting,
  });
  const cover: RayHit = { kind: 'occluder', facesRay: true };

  it('takes a resting page by its reading face only', () => {
    expect(pickSheet([sheet(3, 'front', 'R')], all)).toBe(0);
    expect(pickSheet([sheet(2, 'back', 'L')], all)).toBe(0);
    // the underside of a resting page: you are behind the book
    expect(pickSheet([sheet(3, 'back', 'R')], all)).toBe(-1);
    expect(pickSheet([sheet(2, 'front', 'L')], all)).toBe(-1);
  });

  it('a cover, the spine or a page block in front hides the pages behind it', () => {
    expect(pickSheet([cover, sheet(3, 'front', 'R')], all)).toBe(-1);
    expect(pickSheet([cover, sheet(5, 'back', null)], all)).toBe(-1);
    // a page in front of the board is fine
    expect(pickSheet([sheet(3, 'front', 'R'), cover], all)).toBe(0);
  });

  it('catches pages in flight from either side', () => {
    expect(pickSheet([sheet(4, 'front', null)], all)).toBe(0);
    expect(pickSheet([sheet(4, 'back', null), sheet(5, 'front', 'R')], all)).toBe(0);
  });

  it('ignores faces turned away from the eye and pages that cannot be picked up', () => {
    expect(pickSheet([sheet(4, 'front', null, false), sheet(5, 'front', 'R')], all)).toBe(1);
    expect(pickSheet([cover], all)).toBe(-1);
    expect(pickSheet([sheet(7, 'front', 'R'), sheet(5, 'front', 'R')], (s) => s === 5)).toBe(1);
    expect(pickSheet([], all)).toBe(-1);
  });
});

describe('Text selection and robustness of the gesture machine', () => {
  const onText: Hit = { kind: 'sheet', sheet: 1, u: 0.05, v: 0, flying: false, text: true };

  it('a press held still on text selects it; dragging extends; release ends — no page turn', () => {
    const { state, effects } = run([
      ev('down', 100, 100, { hit: onText }),
      ev('hold', 100, 100),
      ev('move', 140, 104),
      ev('move', 180, 130),
      ev('up', 180, 130),
    ]);
    expect(state.mode).toBe('idle');
    expect(effects.map((e) => e.type)).toEqual(['selectStart', 'selectTo', 'selectTo', 'selectEnd']);
    expect(effects[0]).toMatchObject({ x: 100, y: 100 });
  });

  it('clicks and drags that start on text still turn pages', () => {
    expect(run([ev('down', 50, 50, { hit: onText }), ev('up', 50, 50)]).effects.map((e) => e.type)).toEqual(['tap']);
    const drag = run([ev('down', 50, 50, { hit: onText }), ev('move', 80, 50), ev('hold', 80, 50), ev('up', 80, 50)]);
    expect(drag.effects.map((e) => e.type)).toEqual(['grab', 'dragTo', 'release']);
  });

  it('holding where there is no text keeps the press a page press', () => {
    const { effects } = run([ev('down', 50, 50, { hit: sheetHit }), ev('hold', 50, 50), ev('up', 50, 50)]);
    expect(effects.map((e) => e.type)).toEqual(['tap']);
  });

  it('a press from a pointer whose release went missing ends that gesture and starts afresh', () => {
    // a page drag whose "up" never arrived (a dialog opened, a file was dropped)
    const stuck = run([ev('down', 10, 10, { hit: sheetHit }), ev('move', 40, 10)]);
    expect(stuck.state.mode).toBe('pageDrag');
    const next = run([ev('down', 300, 300, { hit: { kind: 'background' } }), ev('move', 330, 300), ev('up', 330, 300)], stuck.state);
    expect(next.effects.map((e) => e.type)).toEqual(['release', 'orbit', 'orbitEnd']);
    expect(next.state.mode).toBe('idle');
    // the same for a stuck selection and a stuck orbit
    const sel = run([ev('down', 10, 10, { hit: onText }), ev('hold', 10, 10)]);
    expect(run([ev('down', 5, 5, { hit: sheetHit }), ev('up', 5, 5)], sel.state).effects.map((e) => e.type)).toEqual(['selectEnd', 'tap']);
  });
});
