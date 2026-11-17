/**
 * Interaction state machine. A pure reducer: (state, event) → (state, effects).
 *
 * Every gesture's meaning is decided once, at pointer-down, from the hit test
 * supplied with the event, and stays locked until the gesture ends. That is
 * what lets page turning and 6-DoF handling share one pointer without
 * conflicts.
 */

export type Hit =
  | {
      kind: 'sheet';
      sheet: number;
      u: number;
      v: number;
      flying: boolean;
      /** The press is on selectable text (resting page, book settled): a long press selects it. */
      text?: boolean;
      /** An annotation tool is active and this is a resting page's reading face: the press annotates. */
      annotate?: boolean;
    }
  | { kind: 'background' };

export interface Modifiers {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  /** Space bar held (pan mode, as in design tools). */
  space: boolean;
}

export type PointerType = 'mouse' | 'pen' | 'touch';

export interface GestureEvent {
  /** `hold`: the pointer has been pressed without moving for HOLD_SECONDS (sent by the adapter). */
  type: 'down' | 'move' | 'up' | 'cancel' | 'hold';
  id: number;
  x: number;
  y: number;
  t: number;
  button: number;
  pointerType: PointerType;
  mods: Modifiers;
  /** Required on 'down'. */
  hit?: Hit;
}

interface Pt {
  id: number;
  x: number;
  y: number;
}

export type GestureState =
  | { mode: 'idle' }
  | { mode: 'pressPage'; p: Pt; x0: number; y0: number; t0: number; hit: Extract<Hit, { kind: 'sheet' }>; touch: boolean }
  | { mode: 'pageDrag'; p: Pt; sheet: number }
  | { mode: 'selectText'; p: Pt }
  | { mode: 'annotate'; p: Pt }
  | { mode: 'pressSpace'; p: Pt; x0: number; y0: number; t0: number; touch: boolean }
  | { mode: 'orbit'; p: Pt }
  | { mode: 'pan'; p: Pt }
  | { mode: 'twoFinger'; a: Pt; b: Pt }
  | { mode: 'settle'; pts: Pt[] };

export type Effect =
  | { type: 'grab'; sheet: number; u: number; v: number; x: number; y: number }
  | { type: 'dragTo'; x: number; y: number }
  | { type: 'release' }
  | { type: 'tap'; sheet: number; u: number; v: number; x: number; y: number }
  | { type: 'click'; x: number; y: number; t: number }
  | { type: 'orbit'; dx: number; dy: number }
  | { type: 'orbitEnd' }
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'panEnd' }
  | { type: 'pinch'; scale: number; twist: number; dx: number; dy: number; cx: number; cy: number }
  | { type: 'pinchEnd' }
  | { type: 'selectStart'; x: number; y: number }
  | { type: 'selectTo'; x: number; y: number }
  | { type: 'selectEnd'; x: number; y: number }
  | { type: 'annotateStart'; x: number; y: number }
  | { type: 'annotateTo'; x: number; y: number }
  | { type: 'annotateEnd'; x: number; y: number };

export const DRAG_THRESHOLD = { mouse: 4, touch: 9 };

/**
 * A press held this long without moving, on text, selects it (the word under
 * the pointer; dragging then extends the selection). Shorter presses keep their
 * meaning: a click turns the page, a drag peels it.
 */
export const HOLD_SECONDS = 0.42;

export const IDLE: GestureState = { mode: 'idle' };

export function reduce(state: GestureState, e: GestureEvent): { state: GestureState; effects: Effect[] } {
  const fx: Effect[] = [];
  const touch = e.pointerType === 'touch';

  // ---- a new press from the pointer that is already pressed: its release never arrived (focus loss,
  // a dialog, a dropped file). End that gesture and start afresh rather than swallowing the press.
  if (e.type === 'down') {
    const held = singlePointer(state);
    if (held && held.id === e.id) {
      const restart = reduce(IDLE, e);
      return { state: restart.state, effects: [...endOf(state), ...restart.effects] };
    }
  }

  // ---- a second touch converts any single-pointer gesture into a two-finger manipulation
  if (e.type === 'down' && touch) {
    const first = singlePointer(state);
    if (first && first.id !== e.id) {
      fx.push(...endOf(state));
      return { state: { mode: 'twoFinger', a: { ...first }, b: { id: e.id, x: e.x, y: e.y } }, effects: fx };
    }
    if (state.mode === 'settle' && state.pts.length === 1 && state.pts[0].id !== e.id) {
      // a finger stayed down after a pinch: a new one resumes the two-finger manipulation
      return { state: { mode: 'twoFinger', a: { ...state.pts[0] }, b: { id: e.id, x: e.x, y: e.y } }, effects: fx };
    }
  }

  switch (state.mode) {
    case 'idle': {
      if (e.type !== 'down') return { state, effects: fx };
      const p = { id: e.id, x: e.x, y: e.y };
      const panIntent = e.button === 1 || e.button === 2 || e.mods.shift || e.mods.space;
      if (panIntent) return { state: { mode: 'pan', p }, effects: fx };
      if (e.button !== 0) return { state, effects: fx };
      const hit = e.hit ?? { kind: 'background' };
      if (hit.kind === 'sheet' && hit.annotate && !e.mods.alt) {
        // annotation tools act from the very first point: no threshold, no tap/drag distinction
        fx.push({ type: 'annotateStart', x: e.x, y: e.y });
        return { state: { mode: 'annotate', p }, effects: fx };
      }
      if (hit.kind === 'sheet' && !e.mods.alt) {
        return { state: { mode: 'pressPage', p, x0: e.x, y0: e.y, t0: e.t, hit, touch }, effects: fx };
      }
      return { state: { mode: 'pressSpace', p, x0: e.x, y0: e.y, t0: e.t, touch }, effects: fx };
    }

    case 'pressPage': {
      if (e.id !== state.p.id) return { state, effects: fx };
      if (e.type === 'hold') {
        if (!state.hit.text) return { state, effects: fx };
        fx.push({ type: 'selectStart', x: state.x0, y: state.y0 });
        return { state: { mode: 'selectText', p: { ...state.p } }, effects: fx };
      }
      if (e.type === 'move') {
        const thr = state.touch ? DRAG_THRESHOLD.touch : DRAG_THRESHOLD.mouse;
        if (Math.hypot(e.x - state.x0, e.y - state.y0) > thr) {
          const { sheet, u, v } = state.hit;
          fx.push({ type: 'grab', sheet, u, v, x: state.x0, y: state.y0 });
          fx.push({ type: 'dragTo', x: e.x, y: e.y });
          return { state: { mode: 'pageDrag', p: { id: e.id, x: e.x, y: e.y }, sheet }, effects: fx };
        }
        return { state: { ...state, p: { id: e.id, x: e.x, y: e.y } }, effects: fx };
      }
      if (e.type === 'up') {
        const { sheet, u, v } = state.hit;
        fx.push({ type: 'tap', sheet, u, v, x: e.x, y: e.y });
      }
      return { state: IDLE, effects: fx };
    }

    case 'pageDrag': {
      if (e.id !== state.p.id) return { state, effects: fx };
      if (e.type === 'move') {
        fx.push({ type: 'dragTo', x: e.x, y: e.y });
        return { state: { ...state, p: { id: e.id, x: e.x, y: e.y } }, effects: fx };
      }
      if (e.type === 'up' || e.type === 'cancel') {
        fx.push({ type: 'release' });
        return { state: IDLE, effects: fx };
      }
      return { state, effects: fx };
    }

    case 'annotate': {
      if (e.id !== state.p.id) return { state, effects: fx };
      if (e.type === 'move') {
        fx.push({ type: 'annotateTo', x: e.x, y: e.y });
        return { state: { mode: 'annotate', p: { id: e.id, x: e.x, y: e.y } }, effects: fx };
      }
      if (e.type === 'up' || e.type === 'cancel') {
        fx.push({ type: 'annotateEnd', x: e.x, y: e.y });
        return { state: IDLE, effects: fx };
      }
      return { state, effects: fx };
    }

    case 'selectText': {
      if (e.id !== state.p.id) return { state, effects: fx };
      if (e.type === 'move') {
        fx.push({ type: 'selectTo', x: e.x, y: e.y });
        return { state: { mode: 'selectText', p: { id: e.id, x: e.x, y: e.y } }, effects: fx };
      }
      if (e.type === 'up' || e.type === 'cancel') {
        fx.push({ type: 'selectEnd', x: e.x, y: e.y });
        return { state: IDLE, effects: fx };
      }
      return { state, effects: fx };
    }

    case 'pressSpace': {
      if (e.id !== state.p.id) return { state, effects: fx };
      if (e.type === 'move') {
        const thr = state.touch ? DRAG_THRESHOLD.touch : DRAG_THRESHOLD.mouse;
        if (Math.hypot(e.x - state.x0, e.y - state.y0) > thr) {
          fx.push({ type: 'orbit', dx: e.x - state.x0, dy: e.y - state.y0 });
          return { state: { mode: 'orbit', p: { id: e.id, x: e.x, y: e.y } }, effects: fx };
        }
        return { state: { ...state, p: { id: e.id, x: e.x, y: e.y } }, effects: fx };
      }
      if (e.type === 'up') fx.push({ type: 'click', x: e.x, y: e.y, t: e.t });
      return { state: IDLE, effects: fx };
    }

    case 'orbit':
    case 'pan': {
      if (e.id !== state.p.id) return { state, effects: fx };
      if (e.type === 'move') {
        const dx = e.x - state.p.x;
        const dy = e.y - state.p.y;
        fx.push(state.mode === 'orbit' ? { type: 'orbit', dx, dy } : { type: 'pan', dx, dy });
        return { state: { mode: state.mode, p: { id: e.id, x: e.x, y: e.y } }, effects: fx };
      }
      if (e.type === 'up' || e.type === 'cancel') {
        fx.push({ type: state.mode === 'orbit' ? 'orbitEnd' : 'panEnd' });
        return { state: IDLE, effects: fx };
      }
      return { state, effects: fx };
    }

    case 'twoFinger': {
      const isA = e.id === state.a.id;
      const isB = e.id === state.b.id;
      if (!isA && !isB) return { state, effects: fx };
      if (e.type === 'move') {
        const a0 = state.a;
        const b0 = state.b;
        const a1 = isA ? { id: a0.id, x: e.x, y: e.y } : a0;
        const b1 = isB ? { id: b0.id, x: e.x, y: e.y } : b0;
        const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
        const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y) || 1;
        const ang0 = Math.atan2(b0.y - a0.y, b0.x - a0.x);
        const ang1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
        let twist = ang1 - ang0;
        if (twist > Math.PI) twist -= 2 * Math.PI;
        if (twist < -Math.PI) twist += 2 * Math.PI;
        const cx = (a1.x + b1.x) / 2;
        const cy = (a1.y + b1.y) / 2;
        fx.push({
          type: 'pinch',
          scale: d1 / d0,
          twist,
          dx: cx - (a0.x + b0.x) / 2,
          dy: cy - (a0.y + b0.y) / 2,
          cx,
          cy,
        });
        return { state: { mode: 'twoFinger', a: a1, b: b1 }, effects: fx };
      }
      if (e.type === 'up' || e.type === 'cancel') {
        fx.push({ type: 'pinchEnd' });
        return { state: { mode: 'settle', pts: [isA ? { ...state.b } : { ...state.a }] }, effects: fx };
      }
      return { state, effects: fx };
    }

    case 'settle': {
      const known = state.pts.some((p) => p.id === e.id);
      if (!known) return { state, effects: fx };
      if (e.type === 'move') {
        const pts = state.pts.map((p) => (p.id === e.id ? { id: e.id, x: e.x, y: e.y } : p));
        return { state: { mode: 'settle', pts }, effects: fx };
      }
      if (e.type === 'up' || e.type === 'cancel') {
        const pts = state.pts.filter((p) => p.id !== e.id);
        return { state: pts.length ? { mode: 'settle', pts } : IDLE, effects: fx };
      }
      return { state, effects: fx };
    }
  }
}

/** Effects that close a single-pointer gesture cut short. */
function endOf(s: GestureState): Effect[] {
  switch (s.mode) {
    case 'pageDrag':
      return [{ type: 'release' }];
    case 'selectText':
      return [{ type: 'selectEnd', x: s.p.x, y: s.p.y }];
    case 'annotate':
      return [{ type: 'annotateEnd', x: s.p.x, y: s.p.y }];
    case 'orbit':
      return [{ type: 'orbitEnd' }];
    case 'pan':
      return [{ type: 'panEnd' }];
    default:
      return [];
  }
}

function singlePointer(s: GestureState): Pt | null {
  switch (s.mode) {
    case 'pressPage':
    case 'pageDrag':
    case 'selectText':
    case 'annotate':
    case 'pressSpace':
    case 'orbit':
    case 'pan':
      return s.p;
    default:
      return null;
  }
}

/** Classifies a wheel event: trackpad pinch / mouse wheel → zoom, trackpad scroll → pan. */
export function classifyWheel(e: {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
}): 'zoom' | 'pan' {
  if (e.ctrlKey) return 'zoom'; // pinch on trackpads arrives as ctrl+wheel
  if (e.deltaMode !== 0) return 'zoom'; // line/page mode: a physical wheel
  // pixel mode: large, purely vertical, notched deltas are almost always a mouse wheel
  if (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY)) return 'zoom';
  return 'pan';
}
