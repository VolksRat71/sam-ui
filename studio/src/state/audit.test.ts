// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {DataArray, encode, type RLEObject} from '@/jscocotools/mask';
import {
  COMPONENT_MIN_FRACTION,
  COMPONENT_MIN_PX,
  QUEUE_CAP,
  WEIGHTS,
  type Reason,
  type ReviewMark,
  covers,
  fingerprint,
  frameStats,
  locations,
  markValid,
  rank,
  signals,
  stepQueue,
} from './audit';
import parity from './audit.parity.json';

const H = 48;
const W = 64;

type Grid = boolean[][]; // [y][x]

function blank(h = H, w = W): Grid {
  return Array.from({length: h}, () => Array<boolean>(w).fill(false));
}

function sq(x: number, y: number, s = 8, g: Grid = blank()): Grid {
  for (let yy = y; yy < y + s; yy++) {
    for (let xx = x; xx < x + s; xx++) {
      g[yy][xx] = true;
    }
  }
  return g;
}

/** COCO RLE of a grid (column-major, as pycocotools). */
function enc(g: Grid): RLEObject {
  const h = g.length;
  const w = g[0].length;
  const data = new Uint8Array(h * w);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      data[x * h + y] = g[y][x] ? 1 : 0;
    }
  }
  return encode(new DataArray(data, [h, w, 1]))[0];
}

function statsOf(frames: Record<number, Grid | null>) {
  const out = new Map<number, ReturnType<typeof frameStats>>();
  for (const [f, g] of Object.entries(frames)) {
    out.set(Number(f), frameStats(enc(g ?? blank())));
  }
  return out;
}

function moving(n = 30, x0 = 2, y = 10): Record<number, Grid | null> {
  const out: Record<number, Grid | null> = {};
  for (let f = 0; f < n; f++) {
    out[f] = sq(x0 + f, y);
  }
  return out;
}

const kinds = (got: Map<number, Reason[]>, f: number) => (got.get(f) ?? []).map(r => r.kind).sort();

describe('frame statistics from RLE', () => {
  it('reads a square', () => {
    const st = frameStats(enc(sq(10, 4)));
    expect(st.area).toBe(64);
    expect(st.components).toBe(1);
    expect(st.bbox).toEqual([10, 4, 17, 11]);
    expect(st.centroid![0]).toBeCloseTo(13.5);
    expect(st.centroid![1]).toBeCloseTo(7.5);
  });

  it('reads an empty mask', () => {
    expect(frameStats(enc(blank()))).toEqual({area: 0, bbox: null, centroid: null, components: 0});
  });

  it('counts pieces, not specks, 8-connected', () => {
    expect(frameStats(enc(sq(30, 20, 8, sq(2, 2)))).components).toBe(2);
    const speck = sq(2, 2, 12);
    speck[40][60] = true;
    expect(frameStats(enc(speck)).components).toBe(1);
    expect(frameStats(enc(sq(10, 10, 5, sq(5, 5, 5)))).components).toBe(1); // corner to corner
  });

  it('splits a run that wraps a column', () => {
    const g = blank();
    for (let y = H - 4; y < H; y++) g[y][3] = true;
    for (let y = 0; y < 4; y++) g[y][4] = true;
    const st = frameStats(enc(g));
    expect(st.area).toBe(8);
    expect(st.components).toBe(2);
    expect(st.bbox).toEqual([3, 0, 4, H - 1]);
  });

  it('matches the decoded mask on random masks', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 5; t++) {
      const g = blank(20, 26).map(row => row.map(() => rnd() > 0.7));
      const st = frameStats(enc(g));
      let area = 0;
      let sx = 0;
      let sy = 0;
      g.forEach((row, y) =>
        row.forEach((v, x) => {
          if (v) {
            area++;
            sx += x;
            sy += y;
          }
        }),
      );
      expect(st.area).toBe(area);
      expect(st.centroid![0]).toBeCloseTo(sx / area);
      expect(st.centroid![1]).toBeCloseTo(sy / area);
      // pieces by flood fill
      const seen = g.map(r => r.map(() => false));
      const sizes: number[] = [];
      g.forEach((row, y) =>
        row.forEach((v, x) => {
          if (!v || seen[y][x]) return;
          let n = 0;
          const stack = [[y, x]];
          seen[y][x] = true;
          while (stack.length > 0) {
            const [cy, cx] = stack.pop()!;
            n++;
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const ny = cy + dy;
                const nx = cx + dx;
                if (ny >= 0 && ny < 20 && nx >= 0 && nx < 26 && g[ny][nx] && !seen[ny][nx]) {
                  seen[ny][nx] = true;
                  stack.push([ny, nx]);
                }
              }
          }
          sizes.push(n);
        }),
      );
      const floor = Math.max(COMPONENT_MIN_PX, COMPONENT_MIN_FRACTION * area);
      expect(st.components).toBe(sizes.filter(s => s >= floor).length);
    }
  });
});

describe('signals', () => {
  it('raises nothing for a steady move', () => {
    expect(signals(statsOf(moving()), 30).size).toBe(0);
  });

  it('flags a jump where it lands, and only there', () => {
    const m = moving();
    for (let f = 12; f < 30; f++) m[f] = sq(2 + f + 20, 10);
    const got = signals(statsOf(m), 30);
    expect(kinds(got, 12)).toEqual(['jump']);
    expect([...got.keys()]).toEqual([12]);
  });

  it('flags a change of area', () => {
    const m = moving();
    for (let f = 15; f < 30; f++) m[f] = sq(2 + f, 10, 14);
    expect(kinds(signals(statsOf(m), 30), 15)).toContain('area');
  });

  it('flags a split both ways', () => {
    const m = moving();
    for (let f = 10; f < 16; f++) m[f] = sq(2 + f, 30, 6, sq(2 + f, 2, 6));
    const got = signals(statsOf(m), 30);
    expect(kinds(got, 10)).toContain('components');
    expect(kinds(got, 16)).toContain('components');
  });

  it('turns a gap into a stop and a reappearance', () => {
    const m = moving();
    for (let f = 10; f < 15; f++) m[f] = null;
    const got = signals(statsOf(m), 30);
    expect(kinds(got, 9)).toEqual(['stop']);
    expect(kinds(got, 15)).toEqual(['reappear']);
    expect([...got.keys()].sort((a, b) => a - b)).toEqual([9, 15]);
  });

  it('finds a late start and an early end, and not the clip ends', () => {
    const m: Record<number, Grid | null> = {};
    for (let f = 0; f < 30; f++) m[f] = f >= 5 && f <= 20 ? sq(2 + f, 10) : null;
    const got = signals(statsOf(m), 30);
    expect(kinds(got, 5)).toEqual(['start']);
    expect(kinds(got, 20)).toEqual(['stop']);
  });

  it('ignores absent frames and compares nothing across them', () => {
    const m = moving();
    for (let f = 10; f < 15; f++) m[f] = sq(40, 30);
    const got = signals(statsOf(m), 30, {absent: [{start: 10, end: 14, state: 'absent'}]});
    expect([...got.keys()].some(f => f >= 10 && f <= 14)).toBe(false);
    expect(kinds(got, 9)).toEqual(['stop']);
    expect(kinds(got, 15)).toEqual(['reappear']);
  });

  it('takes candidate starts, flags, and drops what a seed frame raised', () => {
    const m = moving();
    for (let f = 12; f < 30; f++) m[f] = sq(2 + f + 20, 10);
    const got = signals(statsOf(m), 30, {
      candidates: [{start: 7, end: 9, state: 'candidate', source: 'text:dog@sam3'}],
      flags: [3, 12],
      seeds: [12],
    });
    expect(kinds(got, 7)).toEqual(['candidate']);
    expect(kinds(got, 3)).toEqual(['flag']);
    expect(kinds(got, 12)).toEqual(['flag']);
  });

  it('weighs a disagreement by how low the IoU is', () => {
    const got = signals(statsOf(moving()), 30, {disagreement: new Map([[4, 0.79], [8, 0.1], [9, 0.95]])});
    expect(kinds(got, 4)).toEqual(['disagree']);
    expect(got.has(9)).toBe(false);
    expect(got.get(8)![0].strength).toBeGreaterThan(got.get(4)![0].strength);
  });
});

const R = (kind: Reason['kind'], frame: number, strength = 1): Reason => ({kind, frame, strength, detail: kind});

describe('ranking', () => {
  it('merges adjacent frames into one location, each kind once', () => {
    const got = locations(new Map([[10, [R('area', 10)]], [11, [R('jump', 11), R('area', 11, 0.6)]], [12, [R('components', 12)]]]), 40);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({frame: 11, start: 10, end: 12});
    expect(got[0].score).toBeCloseTo(WEIGHTS.area + WEIGHTS.jump + WEIGHTS.components);
  });

  it('keeps far frames apart, best first, and never spans an absent range', () => {
    const far = locations(new Map([[5, [R('area', 5)]], [30, [R('disagree', 30), R('jump', 30)]]]), 40);
    expect(far.map(l => l.frame)).toEqual([30, 5]);
    const gap = new Map([[9, [R('stop', 9)]], [12, [R('reappear', 12)]]]);
    expect(locations(gap, 40, [{start: 10, end: 11, state: 'absent'}]).map(l => l.frame).sort()).toEqual([12, 9]);
    expect(locations(gap, 40)).toHaveLength(1);
  });

  it('caps the queue and drops weak stretches', () => {
    const many = new Map<number, Reason[]>();
    for (let f = 0; f < 2000; f += 50) many.set(f, [R('jump', f)]);
    expect(locations(many, 2000)).toHaveLength(QUEUE_CAP);
    const weak = new Map<number, Reason[]>();
    for (let f = 10; f < 20; f++) weak.set(f, [R('retrack', f, 0.25)]);
    expect(locations(weak, 40)).toEqual([]);
  });

  it('ranks every object together', () => {
    const q = rank(
      new Map([
        [1, [{frame: 3, start: 3, end: 3, score: 1, reasons: [R('area', 3)]}]],
        [2, [{frame: 8, start: 8, end: 8, score: 4, reasons: [R('flag', 8)]}]],
      ]),
    );
    expect(q.map(e => [e.objectId, e.frame])).toEqual([
      [2, 8],
      [1, 3],
    ]);
  });
});

describe('reviewed marks', () => {
  const mask = enc(sq(2, 2));
  const mark: ReviewMark = {frame: 5, span: [4, 6], engine: 'browser-sam2', at: 'now', mask: fingerprint(mask), reasons: []};

  it('hold while the mask on that frame is the same, on the same engine', () => {
    expect(markValid(mark, 'browser-sam2', fingerprint(mask))).toBe(true);
    expect(markValid(mark, 'browser-sam2', fingerprint(enc(sq(3, 2))))).toBe(false);
    expect(markValid(mark, 'sam2', fingerprint(mask))).toBe(false);
    expect(markValid(mark, 'browser-sam2', null)).toBe(false);
  });

  it('review the locations their span overlaps', () => {
    expect(covers(mark, 6, 9)).toBe(true);
    expect(covers(mark, 7, 9)).toBe(false);
    expect(covers({...mark, span: null}, 5, 5)).toBe(true);
  });
});

describe('stepping through the queue', () => {
  const q = [
    {objectId: 1, frame: 30, reviewed: false},
    {objectId: 2, frame: 4, reviewed: true},
    {objectId: 1, frame: 9, reviewed: false},
  ];

  it('goes in rank order from the current stop, and wraps', () => {
    expect(stepQueue(q, null, 1)).toBe(0);
    expect(stepQueue(q, 0, 1)).toBe(1);
    expect(stepQueue(q, 2, 1)).toBe(0);
    expect(stepQueue(q, 0, -1)).toBe(2);
    expect(stepQueue([], null, 1)).toBeNull();
  });

  it('skips reviewed stops when asked', () => {
    expect(stepQueue(q, 0, 1, true)).toBe(2);
    expect(stepQueue([{objectId: 1, frame: 1, reviewed: true}], null, 1, true)).toBeNull();
  });
});

describe('parity with the backend (tracks/audit.py wrote audit.parity.json)', () => {
  it('reads the same statistics and builds the same queue', () => {
    const stats = new Map(Object.entries(parity.masks).map(([f, r]) => [Number(f), frameStats(r)] as const));
    const round = (s: ReturnType<typeof frameStats>) => ({...s, centroid: s.centroid?.map(v => Math.round(v * 1e6) / 1e6) ?? null});
    for (const [f, want] of Object.entries(parity.expected.stats)) {
      expect(round(stats.get(Number(f))!)).toEqual(round(want as ReturnType<typeof frameStats>));
    }
    const i = parity.inputs;
    const reasons = signals(stats, 40, {
      absent: i.absent,
      candidates: i.candidates as Parameters<typeof signals>[2]['candidates'],
      disagreement: new Map(Object.entries(i.disagreement).map(([f, v]) => [Number(f), v])),
      bounded: i.bounded as Array<[number, number]>,
      flags: i.flags,
      seeds: i.seeds,
    });
    expect(locations(reasons, 40, i.absent)).toEqual(parity.expected.locations);
  });
});
