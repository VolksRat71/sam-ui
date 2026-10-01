// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {
  ABSENT,
  CANDIDATE,
  PRESENT,
  absentAt,
  describeRange,
  nextRange,
  normalizeMarks,
  normalizeRanges,
  paintRange,
  paintTimeline,
  provenanceLabel,
  planUnits,
  rangeAt,
  rangesKey,
  rangeWindows,
  seededWindows,
  spanKinds,
  spanState,
  stateAt,
  timelineView,
  unseededWindows,
  writeCandidates,
} from './ranges';

const r = (start: number, end: number) => ({start, end, state: ABSENT});

describe('absent ranges', () => {
  it('sorts, merges touching ranges and drops invalid ones, as the backend does', () => {
    expect(normalizeRanges([r(8, 9), r(2, 4), r(5, 6), r(12, 20), r(15, 16)])).toEqual([r(2, 6), r(8, 9), r(12, 20)]);
    expect(normalizeRanges([{start: -1, end: 3, state: ABSENT}, {start: 5, end: 4, state: ABSENT}, {start: 1, end: 2, state: 'maybe'}])).toEqual([]);
    expect(normalizeRanges(null)).toEqual([]);
  });

  it('paints a range and unmarking its middle splits it', () => {
    const one = paintRange([], 10, 20, ABSENT);
    expect(one).toEqual([r(10, 20)]);
    expect(paintRange(one, 14, 15, null)).toEqual([r(10, 13), r(16, 20)]);
    expect(paintRange(one, 25, 18, ABSENT)).toEqual([r(10, 25)]); // either drag direction
    expect(paintRange(one, 0, 100, null)).toEqual([]);
    expect(absentAt(one, 10) && absentAt(one, 20) && !absentAt(one, 9) && !absentAt(one, 21)).toBe(true);
    expect(rangeAt(one, 12)).toEqual(r(10, 20));
    expect(rangeAt(one, 30)).toBeNull();
  });

  it('splits the timeline into windows, each with only its own seeds', () => {
    expect(rangeWindows([])).toEqual([{lo: 0, hi: null}]);
    expect(rangeWindows([r(0, 2), r(10, 20)])).toEqual([{lo: 3, hi: 9}, {lo: 21, hi: null}]);
    expect(seededWindows([1, 5, 12, 30], [r(10, 20)])).toEqual([
      {window: {lo: 0, hi: 9}, frames: [1, 5]},
      {window: {lo: 21, hi: null}, frames: [30]},
    ]);
  });

  it('finds the windows no seed reaches, for the lane hint', () => {
    expect(unseededWindows([2], [r(10, 20)], 40)).toEqual([{lo: 21, hi: 39, side: 'after'}]);
    expect(unseededWindows([30], [r(10, 20)], 40)).toEqual([{lo: 0, hi: 9, side: 'before'}]);
    expect(unseededWindows([2, 30], [r(10, 20)], 40)).toEqual([]);
    expect(unseededWindows([2], [], 40)).toEqual([]); // no ranges: plain tracking, no hint
    expect(unseededWindows([2], [r(10, 39)], 40)).toEqual([]); // nothing left after the range
  });

  it('says whether a selection is absent, present or both', () => {
    const ranges = [r(10, 20)];
    expect(spanState(ranges, 12, 15)).toBe('absent');
    expect(spanState(ranges, 0, 5)).toBe('present');
    expect(spanState(ranges, 5, 12)).toBe('mixed');
    expect(spanState(ranges, 20, 10)).toBe('absent');
  });

  it('keys ranges only when there are some, so old browser tracks stay tracked', () => {
    expect(rangesKey([])).toBe('');
    expect(rangesKey([r(3, 4)])).not.toBe(rangesKey([r(3, 5)]));
  });

  it('plans one pass per window, objects sharing a window together', () => {
    const seed = (frame: number) => ({frame});
    const units = planUnits([
      {id: 1, seeds: [seed(2), seed(25)], ranges: [r(10, 20)]},
      {id: 2, seeds: [seed(4)], ranges: []},
      {id: 3, seeds: [seed(5)], ranges: [r(10, 20)]},
      {id: 4, seeds: [seed(15)], ranges: [r(10, 20)]}, // its only seed is absent: nothing to track
    ]);
    expect(units.map(u => [u.window, u.objects.map(o => [o.id, o.seeds.map(s => s.frame)])])).toEqual([
      [{lo: 0, hi: 9}, [[1, [2]], [3, [5]]]],
      [{lo: 0, hi: null}, [[2, [4]]]],
      [{lo: 21, hi: null}, [[1, [25]]]],
    ]);
  });
});

describe('candidate and confirmed ranges', () => {
  const DOG = 'text:dog@sam3';
  const p = (start: number, end: number) => ({start, end, state: PRESENT});
  const c = (start: number, end: number, source = DOG, score?: number) => ({
    start,
    end,
    state: CANDIDATE,
    source,
    ...(score == null ? {} : {score}),
  });

  it('reads present and candidate ranges off the wire, dropping bad ones and absent ones', () => {
    const wire = [
      r(0, 1),
      {start: 2, end: 3, state: 'present', source: null, score: null},
      {start: 4, end: 5, state: 'present'},
      {start: 6, end: 8, state: 'candidate', source: DOG, score: 0.5},
      {start: 9, end: 9, state: 'candidate', source: DOG, score: 0.5},
      {start: 10, end: 11, state: 'candidate', source: DOG, score: 0.25},
      {start: 12, end: 13, state: 'candidate', source: null}, // no source: not a candidate
      {start: 14, end: 15, state: 'candidate', source: DOG, score: 3},
    ];
    expect(normalizeMarks(wire)).toEqual([p(2, 5), c(6, 9, DOG, 0.5), c(10, 11, DOG, 0.25)]);
    expect(normalizeRanges(wire)).toEqual([r(0, 1)]); // tracking still sees absent only
  });

  it('shows absent over present over candidate, one state a frame', () => {
    const view = timelineView([r(10, 14)], [p(12, 20), c(0, 30, DOG, 0.8)]);
    expect(view).toEqual([c(0, 9, DOG, 0.8), r(10, 14), p(15, 20), c(21, 30, DOG, 0.8)]);
    expect([0, 10, 15, 21, 31].map(f => stateAt(view, f))).toEqual(['candidate', 'absent', 'present', 'candidate', 'unknown']);
  });

  it('paints as the backend does: present clears absent, a candidate goes under confirmed frames', () => {
    let t = {ranges: [r(3, 8)], marks: []} as ReturnType<typeof paintTimeline>;
    t = paintTimeline(t, 6, 9, PRESENT);
    expect(t).toEqual({ranges: [r(3, 5)], marks: [p(6, 9)]});
    t = paintTimeline(t, 0, 12, CANDIDATE, {source: DOG, score: 0.4});
    expect(timelineView(t.ranges, t.marks)).toEqual([c(0, 2, DOG, 0.4), r(3, 5), p(6, 9), c(10, 12, DOG, 0.4)]);
    // absent over a present frame wins without deleting it
    t = paintTimeline(t, 9, 9, ABSENT);
    expect(timelineView(t.ranges, t.marks).find(x => x.start === 9)).toEqual(r(9, 9));
    // rejecting clears only the candidate layer; no state clears every layer
    // (layers are stored whole: the candidate still runs 0-12 under the confirmed frames)
    expect(paintTimeline(t, 10, 12, null, {clear: [CANDIDATE]}).marks).toEqual([c(0, 9, DOG, 0.4), p(6, 9)]);
    expect(paintTimeline(t, 0, 12, null)).toEqual({ranges: [], marks: []});
    expect(() => paintTimeline(t, 0, 1, CANDIDATE)).toThrow(/source/);
  });

  it('writes candidates in bulk, a later one winning, replace dropping the old ones', () => {
    let t = {ranges: [], marks: [p(7, 7)]} as ReturnType<typeof paintTimeline>;
    t = writeCandidates(t, [c(0, 2, DOG, 0.9), c(1, 3, 'tool', 0.5)]);
    expect(t.marks).toEqual([c(0, 0, DOG, 0.9), c(1, 3, 'tool', 0.5), p(7, 7)]);
    t = writeCandidates(t, [c(5, 9)], true);
    expect(timelineView(t.ranges, t.marks)).toEqual([c(5, 6), p(7, 7), c(8, 9)]);
    expect(() => writeCandidates(t, [c(4, 2)])).toThrow();
  });

  it('never changes the browser seeds key: only absent ranges do', () => {
    const t = paintTimeline(paintTimeline({ranges: [r(1, 2)], marks: []}, 4, 5, PRESENT), 6, 8, CANDIDATE, {source: DOG});
    expect(rangesKey(t.ranges)).toBe(rangesKey([r(1, 2)]));
  });

  it('says which states a selection covers, and steps between candidates', () => {
    const view = timelineView([r(10, 14)], [p(20, 22), c(0, 4), c(30, 31)]);
    expect([...spanKinds(view, 3, 11)].sort()).toEqual(['absent', 'candidate', 'unknown']);
    expect([...spanKinds(view, 20, 21)]).toEqual(['present']);
    expect(nextRange(view, 5, 1, CANDIDATE)).toEqual(c(30, 31));
    expect(nextRange(view, 5, -1, CANDIDATE)).toEqual(c(0, 4));
    expect(nextRange(view, 31, 1, CANDIDATE)).toBeNull();
    expect(provenanceLabel(c(0, 1, DOG, 0.875))).toBe('text:dog@sam3 · score 0.88');
    expect(provenanceLabel(c(0, 1, DOG))).toBe('text:dog@sam3 · no score');
  });

  it('describes a range in words, frames 1-based, so no state is told by colour alone', () => {
    expect(describeRange(r(0, 4))).toBe('Frames 1–5: absent (not in the shot)');
    expect(describeRange(p(9, 9))).toBe('Frame 10: present (confirmed)');
    expect(describeRange(c(2, 3, DOG, 0.5))).toBe('Frames 3–4: candidate, unconfirmed (text:dog@sam3 · score 0.50)');
  });
});
