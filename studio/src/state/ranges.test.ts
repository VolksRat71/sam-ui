// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {
  ABSENT,
  absentAt,
  endAbsenceAt,
  normalizeRanges,
  paintRange,
  planUnits,
  rangeAt,
  rangesKey,
  rangeWindows,
  seededWindows,
  spanState,
  unseededWindows,
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

  it('ends an absence at a frame: [s, e] becomes [s, f-1], and at s the range goes', () => {
    const two = [r(10, 40), r(50, 60)];
    expect(endAbsenceAt(two, 25)).toEqual([r(10, 24), r(50, 60)]);
    expect(endAbsenceAt(two, 40)).toEqual([r(10, 39), r(50, 60)]);
    expect(endAbsenceAt(two, 50)).toEqual([r(10, 40)]); // never [50, 49]
    expect(endAbsenceAt(two, 45)).toEqual(two); // not absent there: unchanged
    expect(endAbsenceAt(undefined, 3)).toEqual([]);
    expect(two).toEqual([r(10, 40), r(50, 60)]); // the input is left alone
  });
});
