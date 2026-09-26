// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {FIT, MAX_ZOOM, panBy, zoomAt} from './view';

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
