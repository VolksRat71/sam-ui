// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Touch gestures on the preview, as pure functions (useTouchGestures.ts holds
// the timers and pointers). One finger: a tap adds a point of the selected
// kind (the Add / Remove toggle), a long press adds the other kind, and a
// drag pans the zoomed view. Two fingers pinch to zoom. A mouse keeps its
// clicks: left adds the selected kind, right the other.

/** A press held this long without moving is a long press. */
export const LONG_PRESS_MS = 500;
/** A finger that moves further than this (CSS px) is dragging, not pressing. */
export const TAP_SLOP_PX = 10;

export type Gesture = 'tap' | 'long-press' | 'drag';

export type Press = {
  /** how far the pointer moved from where it went down, in CSS px */
  dx: number;
  dy: number;
  /** how long it has been down, in ms */
  ms: number;
};

/** Pointers that get the touch gestures; a mouse keeps its own buttons. */
export function isTouchLike(pointerType: string): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

export function movedBeyondSlop(dx: number, dy: number, slop: number = TAP_SLOP_PX): boolean {
  return Math.hypot(dx, dy) > slop;
}

/** What a single-finger press is, so far (or at release). */
export function classifyPress({dx, dy, ms}: Press): Gesture {
  if (movedBeyondSlop(dx, dy)) {
    return 'drag';
  }
  return ms >= LONG_PRESS_MS ? 'long-press' : 'tap';
}

/**
 * The point label a gesture adds: a tap adds the selected kind, a long press
 * the other one, a drag none. 1 is positive, 0 negative (SAM's labels).
 */
export function labelFor(gesture: Gesture, selected: 0 | 1): 0 | 1 | null {
  if (gesture === 'tap') {
    return selected;
  }
  if (gesture === 'long-press') {
    return selected === 1 ? 0 : 1;
  }
  return null;
}

export type Pt = {x: number; y: number};

export type PinchStep = {
  /** zoom factor since the last step */
  factor: number;
  /** the fingers' midpoint now, in client px */
  midX: number;
  midY: number;
  /** how far the midpoint moved since the last step */
  dx: number;
  dy: number;
};

/** One step of a two-finger pinch, from the fingers' last and current places. */
export function pinchStep(before: [Pt, Pt], after: [Pt, Pt]): PinchStep {
  const d0 = Math.hypot(before[1].x - before[0].x, before[1].y - before[0].y);
  const d1 = Math.hypot(after[1].x - after[0].x, after[1].y - after[0].y);
  const mid0 = {x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2};
  const mid1 = {x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2};
  return {
    // fingers that start on the same spot cannot scale anything
    factor: d0 > 0 && d1 > 0 ? d1 / d0 : 1,
    midX: mid1.x,
    midY: mid1.y,
    dx: mid1.x - mid0.x,
    dy: mid1.y - mid0.y,
  };
}

export type TrackerCallbacks = {
  /** whether the view is zoomed in, so a one-finger drag pans it */
  zoomed: () => boolean;
  /** a long press at (x, y), in client px */
  onLongPress: (x: number, y: number) => void;
  /** a one-finger drag on the zoomed view, by (dx, dy) client px */
  onPan: (dx: number, dy: number) => void;
  onPinch: (step: PinchStep) => void;
};

type Mode = 'idle' | 'press' | 'pan' | 'pinch';

/**
 * Follows the pointers on the preview and turns touch into gestures. A tap
 * is left to the browser's own click (so it adds a point the way a mouse
 * click does); this only says, through allowsClick, when the click that
 * follows a long press, a drag or a pinch must be ignored, and through
 * allowsContextMenu, when a long press's context menu must be (the long
 * press has already added its point).
 */
export class TouchTracker {
  private pointers = new Map<number, Pt>();
  private start: Pt = {x: 0, y: 0};
  private mode: Mode = 'idle';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private suppress = false;
  private lastType = 'mouse';

  constructor(private readonly cb: TrackerCallbacks) {}

  down(id: number, pointerType: string, x: number, y: number, canLongPress: boolean): void {
    this.lastType = pointerType;
    if (!isTouchLike(pointerType)) {
      this.suppress = false;
      return;
    }
    if (this.pointers.size >= 2) {
      return; // a third finger changes nothing
    }
    if (this.pointers.size === 0) {
      this.suppress = false;
      this.start = {x, y};
      this.mode = 'press';
      this.clearTimer();
      if (canLongPress) {
        this.timer = setTimeout(() => this.fire(), LONG_PRESS_MS);
      }
    } else {
      // a second finger: a pinch, never a point
      this.clearTimer();
      this.mode = 'pinch';
      this.suppress = true;
    }
    this.pointers.set(id, {x, y});
  }

  move(id: number, x: number, y: number): void {
    const prev = this.pointers.get(id);
    if (prev == null) {
      return;
    }
    if (this.mode === 'pinch') {
      const before = [...this.pointers.values()] as [Pt, Pt];
      this.pointers.set(id, {x, y});
      const after = [...this.pointers.values()] as [Pt, Pt];
      if (before.length === 2) {
        this.cb.onPinch(pinchStep(before, after));
      }
      return;
    }
    this.pointers.set(id, {x, y});
    if (this.mode === 'press') {
      if (movedBeyondSlop(x - this.start.x, y - this.start.y)) {
        this.clearTimer();
        this.suppress = true;
        this.mode = this.cb.zoomed() ? 'pan' : 'idle';
        if (this.mode === 'pan') {
          this.cb.onPan(x - this.start.x, y - this.start.y);
        }
      }
    } else if (this.mode === 'pan') {
      this.cb.onPan(x - prev.x, y - prev.y);
    }
  }

  /** A pointer went up or was cancelled. */
  up(id: number): void {
    if (!this.pointers.delete(id)) {
      return;
    }
    if (this.pointers.size === 0) {
      this.clearTimer();
      this.mode = 'idle';
    } else if (this.mode === 'pinch') {
      this.mode = 'idle'; // the finger left behind does nothing until it lifts
    }
  }

  /** Whether the click now arriving should add a point; asking uses up the answer. */
  allowsClick(): boolean {
    const ok = !this.suppress;
    this.suppress = false;
    return ok;
  }

  /** Whether the context menu now arriving is a real right click. */
  allowsContextMenu(): boolean {
    if (this.lastType === 'touch') {
      return false; // a long press, handled by its timer
    }
    return !(this.lastType === 'pen' && this.suppress);
  }

  dispose(): void {
    this.clearTimer();
    this.pointers.clear();
    this.mode = 'idle';
  }

  private fire(): void {
    this.timer = null;
    if (this.mode !== 'press') {
      return;
    }
    this.mode = 'idle';
    this.suppress = true;
    this.cb.onLongPress(this.start.x, this.start.y);
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
