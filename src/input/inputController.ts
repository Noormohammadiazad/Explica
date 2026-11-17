import {
  IDLE,
  HOLD_SECONDS,
  reduce,
  classifyWheel,
  type Effect,
  type GestureState,
  type Hit,
  type GestureEvent,
  type PointerType,
} from './gestures';

export interface InputHandlers {
  hitTest(x: number, y: number): Hit;
  effect(e: Effect, now: number): void;
  zoom(factor: number, x: number, y: number): void;
  pan(dx: number, dy: number): void;
  hover(x: number, y: number): string;
  key(e: KeyboardEvent): boolean;
}

/**
 * DOM adapter: turns pointer/wheel/keyboard events into gesture-machine
 * events (hit-testing on pointer-down) and dispatches the resulting effects.
 */
export class InputController {
  state: GestureState = IDLE;
  private space = false;
  private hoverQueued = false;
  private holdTimer = 0;
  private lastHover = { x: 0, y: 0 };
  /** Detaches every listener at once (dispose). */
  private readonly listening = new AbortController();
  private readonly touchAction: string;

  constructor(
    private readonly el: HTMLElement,
    private readonly h: InputHandlers,
  ) {
    const signal = this.listening.signal;
    el.addEventListener('pointerdown', this.onDown, { signal });
    el.addEventListener('pointermove', this.onMove, { signal });
    el.addEventListener('pointerup', this.onUp, { signal });
    el.addEventListener('pointercancel', this.onCancel, { signal });
    el.addEventListener('lostpointercapture', this.onCancel, { signal });
    el.addEventListener('wheel', this.onWheel, { passive: false, signal });
    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('keyup', this.onKeyUp, { signal });
    window.addEventListener('blur', () => (this.space = false), { signal });
    // Safari's proprietary pinch events; prevent page zoom
    el.addEventListener('gesturestart', (e) => e.preventDefault(), { signal });
    // every touch is a gesture on the book, never a scroll or zoom of the page
    this.touchAction = el.style.touchAction;
    el.style.touchAction = 'none';
  }

  /** Stops listening and gives the element back as it was. */
  dispose(): void {
    this.reset();
    this.listening.abort();
    this.el.style.touchAction = this.touchAction;
  }

  get busy(): boolean {
    return this.state.mode !== 'idle';
  }

  /** Forgets any gesture in progress (a new document replaces everything it referred to). */
  reset(): void {
    this.state = IDLE;
    clearTimeout(this.holdTimer);
    this.el.style.cursor = 'default';
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toEvent(type: GestureEvent['type'], e: PointerEvent): GestureEvent {
    const { x, y } = this.local(e);
    return {
      type,
      id: e.pointerId,
      x,
      y,
      t: e.timeStamp / 1000,
      button: e.button,
      pointerType: (e.pointerType || 'mouse') as PointerType,
      mods: { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, space: this.space },
    };
  }

  private dispatch(ev: GestureEvent): void {
    const { state, effects } = reduce(this.state, ev);
    this.state = state;
    for (const fx of effects) this.h.effect(fx, ev.t);
    this.updateCursor();
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    e.preventDefault();
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer may already be gone */
    }
    const ev = this.toEvent('down', e);
    ev.hit = this.h.hitTest(ev.x, ev.y);
    this.dispatch(ev);
    // a press that stays put on text becomes a text selection
    clearTimeout(this.holdTimer);
    if (ev.hit.kind === 'sheet' && ev.hit.text) {
      const id = e.pointerId;
      const pointerType = ev.pointerType;
      this.holdTimer = window.setTimeout(() => {
        const s = this.state;
        if (s.mode !== 'pressPage' || s.p.id !== id) return;
        this.dispatch({ ...ev, type: 'hold', x: s.p.x, y: s.p.y, t: performance.now() / 1000, pointerType, hit: undefined });
      }, HOLD_SECONDS * 1000);
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (this.state.mode === 'idle') {
      if (e.pointerType === 'mouse') this.queueHover(this.local(e));
      return;
    }
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const last = events.length ? events[events.length - 1] : e;
    this.dispatch(this.toEvent('move', last));
  };

  private onUp = (e: PointerEvent): void => {
    clearTimeout(this.holdTimer);
    this.dispatch(this.toEvent('up', e));
  };

  private onCancel = (e: PointerEvent): void => {
    if (this.state.mode === 'idle') return;
    this.dispatch(this.toEvent('cancel', e));
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { x, y } = this.local(e);
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (classifyWheel(e) === 'zoom') {
      const k = e.ctrlKey ? 0.0105 : 0.0016;
      this.h.zoom(Math.exp(-dy * k), x, y);
    } else {
      this.h.pan(-dx, -dy);
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.code === 'Space') {
      this.space = true;
      e.preventDefault();
      this.updateCursor();
      return;
    }
    if (this.h.key(e)) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') {
      this.space = false;
      this.updateCursor();
    }
  };

  private queueHover(p: { x: number; y: number }): void {
    this.lastHover = p;
    if (this.hoverQueued) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      if (this.state.mode === 'idle') this.el.style.cursor = this.space ? 'grab' : this.h.hover(this.lastHover.x, this.lastHover.y);
    });
  }

  private updateCursor(): void {
    const m = this.state.mode;
    this.el.style.cursor =
      m === 'pageDrag' || m === 'orbit' || m === 'pan'
        ? 'grabbing'
        : m === 'selectText'
          ? 'text'
          : m === 'annotate'
            ? this.el.style.cursor
          : this.space
            ? 'grab'
            : this.el.style.cursor;
  }
}
