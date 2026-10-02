// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {FIT, MAX_ZOOM, panBy, toScreen, zoomAt, zoomWheelDelta} from './view';

describe('zoomAt', () => {
  it('keeps the point under the cursor still', () => {
    const v = zoomAt(FIT, 2, 100, 50, 640, 360);
    expect(v.zoom).toBe(2);
    // the screen point (100, 50) maps to the same content point before and after
    const before = {x: (100 - FIT.x) / FIT.zoom, y: (50 - FIT.y) / FIT.zoom};
    const after = {x: (100 - v.x) / v.zoom, y: (50 - v.y) / v.zoom};
    expect(after).toEqual(before);
  });

  it('clamps the zoom and snaps back to fit', () => {
    expect(zoomAt(FIT, 100, 0, 0, 640, 360).zoom).toBe(MAX_ZOOM);
    const zoomed = zoomAt(FIT, 3, 200, 100, 640, 360);
    expect(zoomAt(zoomed, 0.01, 0, 0, 640, 360)).toEqual(FIT);
  });
});

describe('panBy', () => {
  it('does nothing at fit, and stops before the video leaves the pane', () => {
    expect(panBy(FIT, 50, 50, 640, 360)).toEqual(FIT);
    const v = panBy({zoom: 2, x: 0, y: 0}, 10_000, -10_000, 640, 360);
    expect(v).toEqual({zoom: 2, x: 640, y: -360});
  });
});

describe('toScreen', () => {
  it('maps video points through the zoom and pan', () => {
    expect(toScreen(FIT, 640, 360, 0.25, 0.5)).toEqual({x: 160, y: 180});
    // zoomed 2x about the centre, moved 10 px right
    expect(toScreen({zoom: 2, x: 10, y: 0}, 640, 360, 0.25, 0.5)).toEqual({x: 10, y: 180});
    expect(toScreen({zoom: 2, x: 10, y: 0}, 640, 360, 0.5, 0.5)).toEqual({x: 330, y: 180});
  });

  it('agrees with zoomAt: the point under the cursor stays under it', () => {
    const v = zoomAt(FIT, 3, 100, -40, 640, 360); // cursor 100 px right of centre, 40 up
    const p = toScreen(v, 640, 360, (320 + 100) / 640, (180 - 40) / 360);
    expect(p.x).toBeCloseTo(420);
    expect(p.y).toBeCloseTo(140);
  });
});

it('zooms with Shift on either wheel axis, keeps Ctrl/Meta, and leaves plain scroll for pan', () => {
  const e = {shiftKey: false, ctrlKey: false, metaKey: false, deltaX: 0, deltaY: -100, deltaMode: 0};
  expect(zoomWheelDelta(e, 400)).toBeNull();
  expect(zoomWheelDelta({...e, shiftKey: true}, 400)).toBe(-100);
  expect(zoomWheelDelta({...e, shiftKey: true, deltaY: 0, deltaX: -100}, 400)).toBe(-100);
  expect(zoomWheelDelta({...e, ctrlKey: true}, 400)).toBe(-100);
  expect(zoomWheelDelta({...e, metaKey: true, deltaY: -2, deltaMode: 1}, 400)).toBe(-32);
});
