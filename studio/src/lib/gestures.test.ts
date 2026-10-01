// sam-ui (Apache-2.0). New file, not from SAM 2.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  LONG_PRESS_MS,
  TAP_SLOP_PX,
  TouchTracker,
  classifyPress,
  isTouchLike,
  labelFor,
  longPressStartsOn,
  movedBeyondSlop,
  pinchStep,
  type TrackerCallbacks,
} from './gestures';

describe('classifyPress', () => {
  it('a short, still press is a tap', () => {
    expect(classifyPress({dx: 0, dy: 0, ms: 80})).toBe('tap');
    expect(classifyPress({dx: 3, dy: 4, ms: LONG_PRESS_MS - 1})).toBe('tap');
  });

  it('a held, still press is a long press', () => {
    expect(classifyPress({dx: 0, dy: 0, ms: LONG_PRESS_MS})).toBe('long-press');
    expect(classifyPress({dx: 6, dy: 6, ms: 2000})).toBe('long-press');
  });

  it('moving past the slop makes it a drag, however long it was held', () => {
    expect(classifyPress({dx: TAP_SLOP_PX + 1, dy: 0, ms: 50})).toBe('drag');
    expect(classifyPress({dx: 8, dy: 8, ms: 5000})).toBe('drag');
  });
});

describe('movedBeyondSlop', () => {
  it('measures the straight-line distance', () => {
    expect(movedBeyondSlop(6, 8)).toBe(false); // exactly 10
    expect(movedBeyondSlop(6, 8.1)).toBe(true);
    expect(movedBeyondSlop(3, 0, 2)).toBe(true);
  });
});

describe('isTouchLike', () => {
  it('is touch and pen, not mouse', () => {
    expect(isTouchLike('touch')).toBe(true);
    expect(isTouchLike('pen')).toBe(true);
    expect(isTouchLike('mouse')).toBe(false);
    expect(isTouchLike('')).toBe(false);
  });
});

describe('labelFor', () => {
  it('a tap adds the selected kind, a long press the other, a drag none', () => {
    expect(labelFor('tap', 1)).toBe(1);
    expect(labelFor('tap', 0)).toBe(0);
    expect(labelFor('long-press', 1)).toBe(0);
    expect(labelFor('long-press', 0)).toBe(1);
    expect(labelFor('drag', 1)).toBeNull();
  });
});

describe('longPressStartsOn', () => {
  // a stand-in element: closest() finds the first ancestor matching, as the DOM does
  const el = (...ancestors: string[]) => ({
    closest: (selector: string) => (ancestors.includes(selector.slice(1)) ? {} : null),
  });

  it('starts on the video click layer', () => {
    expect(longPressStartsOn(el('click-layer', 'stage-box', 'stage'))).toBe(true);
  });

  it('never on the session overlay, a point marker or elsewhere on the stage', () => {
    expect(longPressStartsOn(el('stage-overlay', 'stage'))).toBe(false);
    expect(longPressStartsOn(el('point', 'points-layer', 'stage'))).toBe(false);
    expect(longPressStartsOn(el('stage'))).toBe(false);
  });

  it('not on something that is not an element', () => {
    expect(longPressStartsOn(null)).toBe(false);
    expect(longPressStartsOn({})).toBe(false);
    expect(longPressStartsOn({closest: 'not a function'})).toBe(false);
  });
});

describe('pinchStep', () => {
  it('scales by the change in finger distance, about their midpoint', () => {
    const s = pinchStep(
      [
        {x: 100, y: 100},
        {x: 200, y: 100},
      ],
      [
        {x: 50, y: 110},
        {x: 250, y: 110},
      ],
    );
    expect(s.factor).toBe(2);
    expect(s).toMatchObject({midX: 150, midY: 110, dx: 0, dy: 10});
  });

  it('does not scale when the fingers start on one spot', () => {
    expect(pinchStep([{x: 5, y: 5}, {x: 5, y: 5}], [{x: 0, y: 5}, {x: 10, y: 5}]).factor).toBe(1);
  });
});

describe('TouchTracker', () => {
  let cb: TrackerCallbacks & {
    onLongPress: ReturnType<typeof vi.fn>;
    onPan: ReturnType<typeof vi.fn>;
    onPinch: ReturnType<typeof vi.fn>;
  };
  let zoomed = false;
  let t: TouchTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    zoomed = false;
    cb = {zoomed: () => zoomed, onLongPress: vi.fn(), onPan: vi.fn(), onPinch: vi.fn()};
    t = new TouchTracker(cb);
  });
  afterEach(() => {
    t.dispose();
    vi.useRealTimers();
  });

  it('leaves a tap to the click', () => {
    t.down(1, 'touch', 10, 10, true);
    vi.advanceTimersByTime(100);
    t.up(1);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(cb.onLongPress).not.toHaveBeenCalled();
    expect(t.allowsClick()).toBe(true);
  });

  it('a long press fires once, where it went down, and eats the click after it', () => {
    t.down(1, 'touch', 40, 60, true);
    t.move(1, 44, 63); // inside the slop
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(cb.onLongPress).toHaveBeenCalledWith(40, 60);
    t.up(1);
    expect(t.allowsClick()).toBe(false);
    expect(t.allowsClick()).toBe(true); // used up
    expect(cb.onLongPress).toHaveBeenCalledTimes(1);
  });

  it('a long press does not fire where it may not (on a point marker)', () => {
    t.down(1, 'touch', 40, 60, false);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(cb.onLongPress).not.toHaveBeenCalled();
    t.up(1);
    expect(t.allowsClick()).toBe(true); // the tap removes the point
  });

  it('ignores the context menu a touch long press opens, never a mouse right click', () => {
    t.down(1, 'touch', 0, 0, true);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(t.allowsContextMenu()).toBe(false);
    t.up(1);
    t.down(2, 'mouse', 0, 0, true);
    expect(t.allowsContextMenu()).toBe(true);
  });

  it('a drag cancels the long press and the click, and pans only when zoomed', () => {
    t.down(1, 'touch', 0, 0, true);
    t.move(1, 30, 0);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    t.up(1);
    expect(cb.onLongPress).not.toHaveBeenCalled();
    expect(cb.onPan).not.toHaveBeenCalled();
    expect(t.allowsClick()).toBe(false);

    zoomed = true;
    t.down(1, 'touch', 0, 0, true);
    t.move(1, 30, 0);
    t.move(1, 35, 4);
    t.up(1);
    expect(cb.onPan.mock.calls).toEqual([
      [30, 0],
      [5, 4],
    ]);
  });

  it('two fingers pinch, never add a point, and the finger left behind does nothing', () => {
    t.down(1, 'touch', 100, 100, true);
    t.down(2, 'touch', 200, 100, true);
    t.move(2, 300, 100);
    expect(cb.onPinch).toHaveBeenCalledTimes(1);
    expect(cb.onPinch.mock.calls[0][0].factor).toBe(2);
    t.up(2);
    zoomed = true;
    t.move(1, 150, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    t.up(1);
    expect(cb.onPan).not.toHaveBeenCalled();
    expect(cb.onLongPress).not.toHaveBeenCalled();
    expect(t.allowsClick()).toBe(false);
  });

  it('a mouse press clears a click left suppressed by a touch', () => {
    t.down(1, 'touch', 0, 0, true);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    t.up(1); // no click followed
    t.down(9, 'mouse', 0, 0, true);
    expect(t.allowsClick()).toBe(true);
  });
});
