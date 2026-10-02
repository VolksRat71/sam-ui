// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {DataArray, encode, type RLEObject} from '@/jscocotools/mask';
import {
  COMPONENT_MIN_FRACTION,
  COMPONENT_MIN_PX,
  EMPTY_MASK,
  QUEUE_CAP,
  WEIGHTS,
  type Reason,
  type ReviewMark,
  buildQueue,
  covers,
  fingerprint,
  fmt2,
  pct,
  reviewNow,
  reviews,
  round3,
  frameStats,
  locations,
  markValid,
  maskFingerprint,
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
    // stopping into the range is what the user marked, no disappearance; coming back still counts
    expect(kinds(got, 9)).toEqual([]);
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
    expect(markValid(mark, 'browser-sam2', {mask: fingerprint(mask), spanMask: 'x'})).toBe(true);
    expect(markValid(mark, 'browser-sam2', {mask: fingerprint(enc(sq(3, 2))), spanMask: 'x'})).toBe(false);
    expect(markValid(mark, 'sam2', {mask: fingerprint(mask), spanMask: 'x'})).toBe(false);
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
    expect(stepQueue([{reviewed: true}], null, 1, true)).toBeNull();
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
      candidates: i.candidates as NonNullable<Parameters<typeof signals>[2]>['candidates'],
      disagreement: new Map(Object.entries(i.disagreement).map(([f, v]) => [Number(f), v])),
      bounded: i.bounded as Array<[number, number]>,
      flags: i.flags,
      seeds: i.seeds,
      cleared: i.cleared,
    });
    expect(locations(reasons, 40, i.absent)).toEqual(parity.expected.locations);
  });
});

describe('a queue built in the browser', () => {
  const wrap = () => {
    // a square that jumps back to the left at frame 12
    const masks = new Map<number, RLEObject>();
    for (let f = 0; f < 20; f++) masks.set(f, enc(sq(f < 12 ? 2 + f : f - 10, 10)));
    return masks;
  };
  const base = {ranges: [], candidates: [], seeds: [0], flags: []};

  it('ranks tracked and stale objects, skips the rest, and says which stops are reviewed', () => {
    const masks = wrap();
    const marks: ReviewMark[] = [{frame: 12, span: [12, 12], engine: 'browser-sam2', at: 't', mask: fingerprint(masks.get(12)!), reasons: ['jump']}];
    const q = buildQueue(
      [
        {id: 1, state: 'tracked', masks, marks, ...base},
        {id: 2, state: 'stale', masks, marks: [], ...base, flags: [1]}, // 11 frames from the jump: a stop of its own
        {id: 3, state: 'untracked', masks: null, marks: [], ...base},
      ],
      20,
      'browser-sam2',
    );
    expect(q.skipped).toEqual({3: 'untracked'});
    expect(q.objects[1]).toEqual({state: 'tracked', nFrames: 20, unreviewed: 0});
    expect(q.objects[2].unreviewed).toBe(2);
    expect(q.queue.map(e => [e.objectId, e.frame, e.reviewed])).toEqual([
      [2, 1, false],
      [1, 12, true],
      [2, 12, false],
    ]);
  });

  it('drops a mark once the mask on its frame changes, and an empty frame can be reviewed', () => {
    const masks = wrap();
    const old = fingerprint(enc(sq(30, 30)));
    const marks: ReviewMark[] = [
      {frame: 12, span: null, engine: 'browser-sam2', at: 't', mask: old, reasons: []},
      {frame: 3, span: null, engine: 'browser-sam2', at: 't', mask: EMPTY_MASK, reasons: []},
    ];
    masks.delete(3); // no mask there: the object is gone on that frame
    const q = buildQueue([{id: 1, state: 'tracked', masks, marks, ...base, flags: [3]}], 20, 'browser-sam2');
    expect(q.queue.filter(e => e.reviewed).map(e => e.frame)).toEqual([3]);
    expect(maskFingerprint(masks, 3, 20)).toBe(EMPTY_MASK);
    expect(maskFingerprint(masks, 25, 20)).toBeNull();
  });
});

describe('review fixes', () => {
  it('drops a flag left inside an absent range, and never ranks a frame in one', () => {
    const absent = [{start: 10, end: 14, state: 'absent'}];
    const got = signals(statsOf(moving()), 30, {absent, flags: [12, 20]});
    expect(got.has(12)).toBe(false);
    expect(kinds(got, 20)).toEqual(['flag']);
    expect(locations(new Map([[12, [R('flag', 12)]]]), 30, absent)).toEqual([]);
  });

  it('rounds ties half up, as the backend does', () => {
    expect(round3(0.5625)).toBe(0.563);
    expect(fmt2(0.125)).toBe('0.13');
    expect(pct(0.625)).toBe(63);
  });

  it('lets a mark go once any frame of its span changes, and reviews only a stop peaking inside it', () => {
    const masks = new Map<number, RLEObject>();
    for (let f = 0; f < 20; f++) masks.set(f, enc(sq(f < 12 ? 2 + f : f - 10, 10)));
    const now = reviewNow(masks, 12, [10, 13], 20)!;
    const mark: ReviewMark = {frame: 12, span: [10, 13], engine: 'browser-sam2', at: 't', reasons: [], ...now};
    expect(markValid(mark, 'browser-sam2', reviewNow(masks, 12, [10, 13], 20))).toBe(true);
    masks.set(11, masks.get(3)!); // a frame of the span, not the peak
    expect(markValid(mark, 'browser-sam2', reviewNow(masks, 12, [10, 13], 20))).toBe(false);
    expect(reviews(mark, {frame: 13})).toBe(true);
    expect(reviews(mark, {frame: 14})).toBe(false);
  });
});

describe('with the correction semantics: a cleared frame is no disappearance, a candidate no absence', () => {
  it('passes over a cleared frame SAM 2 blanked: no stop before it, no reappearance after', () => {
    const m = moving();
    m[12] = null; // SAM 2 blanks a cleared seed's frame, by design
    expect(kinds(signals(statsOf(m), 30), 11)).toEqual(['stop']); // an empty frame with no seed is one
    expect([...signals(statsOf(m), 30, {seeds: [0, 12], cleared: [12]})]).toEqual([]);
  });

  it('is no stop when SAM 3 keeps a cleared look-alike out for a while, and a comeback still counts', () => {
    const m = moving();
    for (let f = 12; f < 20; f++) m[f] = null;
    const got = signals(statsOf(m), 30, {seeds: [0, 12], cleared: [12]});
    expect([...got.keys()]).toEqual([20]);
    expect(kinds(got, 20)).toEqual(['reappear']);
  });

  it('compares the frames either side of a cleared frame, whatever it holds', () => {
    const m = moving();
    m[12] = sq(40, 30); // a stray mask on the cleared frame (a track from before the skip): not evidence
    expect([...signals(statsOf(m), 30, {seeds: [12], cleared: [12]})]).toEqual([]);
    m[13] = sq(2 + 13, 10, 12);
    const got = signals(statsOf(m), 30, {seeds: [12], cleared: [12]});
    expect(got.get(13)!.find(r => r.kind === 'area')!.detail).toBe('the mask grows by 56% across 1 cleared frame');
    expect(got.has(12)).toBe(false);
  });

  it('keeps a cleared frame inside an absent range a gap', () => {
    const m = moving();
    m[12] = null;
    for (let f = 13; f < 30; f++) m[f] = sq(2 + f + 20, 20);
    const got = signals(statsOf(m), 30, {absent: [{start: 12, end: 12, state: 'absent'}], seeds: [12], cleared: [12]});
    expect([...got.keys()]).toEqual([13]);
    expect(kinds(got, 13)).toEqual(['reappear']);
  });

  it('takes a candidate as a review item, never as absent', () => {
    const masks = new Map<number, RLEObject>();
    for (let f = 0; f < 30; f++) masks.set(f, enc(sq(2 + f, 10)));
    const candidates = [{start: 10, end: 20, state: 'candidate', source: 'text:dog@sam3', score: 0.6}] as NonNullable<Parameters<typeof signals>[2]>['candidates'];
    const q = buildQueue([{id: 1, state: 'tracked', masks, marks: [], ranges: [], candidates: candidates!, seeds: [0], flags: []}], 30, 'browser-sam2');
    expect(q.queue.map(e => [e.frame, e.reasons.map(r => r.kind)])).toEqual([[10, ['candidate']]]);
  });
});


describe('the stop before a gap that runs into a range or a cleared frame (case b)', () => {
  it('is still a stop when empty frames run into an absent range', () => {
    const m = moving();
    for (let f = 7; f < 15; f++) m[f] = null; // the track stops after 6, 7-9 are empty, 10-14 marked absent
    expect(kinds(signals(statsOf(m), 30, {absent: [{start: 10, end: 14, state: 'absent'}]}), 6)).toEqual(['stop']);
  });

  it('is still a stop when empty frames run into a cleared frame', () => {
    const m = moving();
    for (let f = 10; f < 13; f++) m[f] = null; // the track stops after 9, 10-11 are empty, 12 is cleared
    expect(kinds(signals(statsOf(m), 30, {seeds: [0, 12], cleared: [12]}), 9)).toEqual(['stop']);
  });
});
