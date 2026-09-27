// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {findBorders, outlineArea, simplifyClosed, traceMask, vectorJson} from './contours';

function canvas(w: number, h: number) {
  const m = new Uint8Array(w * h);
  const rect = (x0: number, y0: number, x1: number, y1: number, v = 1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = v;
  };
  return {m, rect};
}

const sortPts = (pts: number[][]) => [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe('traceMask', () => {
  it('traces a square through its boundary pixel centres, as findContours does', () => {
    const {m, rect} = canvas(60, 50);
    rect(10, 5, 40, 35); // 30 x 30 pixels: x 10..39, y 5..34
    const t = traceMask(m, 60, 50);
    expect(t.holes).toEqual([]);
    expect(t.pieces).toHaveLength(1);
    expect(sortPts(t.pieces[0])).toEqual(sortPts([[10, 5], [39, 5], [39, 34], [10, 34]]));
    // the raw border: every boundary pixel once, area 29 x 29 (cv2.contourArea)
    const [b] = findBorders(m, 60, 50);
    expect(b.hole).toBe(false);
    expect(b.points).toHaveLength(4 * 29);
    expect(outlineArea(b.points)).toBe(29 * 29);
  });

  it('gives a donut one piece and one hole', () => {
    const {m, rect} = canvas(64, 64);
    rect(10, 10, 50, 50);
    rect(20, 20, 40, 40, 0); // 20 x 20 hole
    const t = traceMask(m, 64, 64);
    expect(t.pieces).toHaveLength(1);
    expect(t.holes).toHaveLength(1);
    // a hole border runs through the foreground pixels around the hole
    const xs = t.holes[0].map(p => p[0]);
    const ys = t.holes[0].map(p => p[1]);
    expect(Math.min(...xs)).toBe(19);
    expect(Math.max(...xs)).toBe(40);
    expect(Math.min(...ys)).toBe(19);
    expect(Math.max(...ys)).toBe(40);
    expect(outlineArea(t.holes[0])).toBeGreaterThan(400);
  });

  it('orders pieces largest first, and drops pieces and holes under 150 px', () => {
    const {m, rect} = canvas(100, 60);
    rect(5, 5, 20, 20); // small: 14 x 14 = 196
    rect(40, 5, 90, 50); // large
    rect(60, 20, 66, 26, 0); // a 6 x 6 hole: too small to keep
    rect(3, 50, 10, 55); // a speck: dropped
    const t = traceMask(m, 100, 60);
    expect(t.pieces).toHaveLength(2);
    expect(Math.min(...t.pieces[0].map(p => p[0]))).toBe(40);
    expect(Math.min(...t.pieces[1].map(p => p[0]))).toBe(5);
    expect(t.holes).toEqual([]);
  });

  it('finds nothing in an empty frame', () => {
    expect(traceMask(new Uint8Array(20 * 10), 20, 10)).toEqual({pieces: [], holes: []});
  });

  it('keeps 8-connected pixels as one piece', () => {
    const {m, rect} = canvas(60, 60);
    rect(5, 5, 25, 25);
    rect(25, 25, 45, 45); // touches the first only at a corner
    expect(traceMask(m, 60, 60).pieces).toHaveLength(1);
  });
});

describe('simplifyClosed', () => {
  it('drops points within eps of the outline', () => {
    const ring: [number, number][] = [];
    for (let x = 0; x < 20; x++) ring.push([x, x % 2 === 0 ? 0 : 0.5]);
    for (let y = 0; y < 20; y++) ring.push([20, y]);
    for (let x = 20; x > 0; x--) ring.push([x, 20]);
    for (let y = 20; y > 0; y--) ring.push([0, y]);
    const s = simplifyClosed(ring, 1.2);
    expect(s.length).toBeLessThanOrEqual(6);
    expect(s.length).toBeGreaterThanOrEqual(4);
  });
});

describe('vectorJson', () => {
  it('writes the contours.py layout, with nulls where there is no mask and provenance', () => {
    const w = 64;
    const h = 64;
    const {m: donut, rect} = canvas(w, h);
    rect(10, 10, 50, 50);
    rect(20, 20, 40, 40, 0);
    const {m: two, rect: rect2} = canvas(w, h);
    rect2(2, 2, 20, 20);
    rect2(30, 30, 60, 60);
    const frames = [donut, null, two, new Uint8Array(w * h)];
    const v = vectorJson({engine: 'browser-sam2', model: 'sam2.1_hiera_tiny', object: {id: 3, name: 'Red cup'}, fps: 24, w, h, frames: 4}, i => frames[i]);
    expect(v).toMatchObject({version: 1, engine: 'browser-sam2', model: 'sam2.1_hiera_tiny', object: {id: 3, name: 'Red cup'}, fps: 24, w, h, frames: 4});
    expect(v.add).toHaveLength(2);
    expect(v.sub).toHaveLength(1);
    expect(v.add.every(slot => slot.length === 4)).toBe(true);
    expect(v.add[0][0]).not.toBeNull(); // the donut
    expect(v.add[1][0]).toBeNull();
    expect(v.sub[0][0]).not.toBeNull(); // its hole
    expect(v.add.map(s => s[1])).toEqual([null, null]); // no mask
    // two pieces: slot 0 is the larger
    expect(Math.min(...v.add[0][2]!.map(p => p[0]))).toBe(30);
    expect(Math.min(...v.add[1][2]!.map(p => p[0]))).toBe(2);
    expect(v.sub[0][2]).toBeNull();
    expect(v.add.map(s => s[3])).toEqual([null, null]); // an empty mask
  });
});
