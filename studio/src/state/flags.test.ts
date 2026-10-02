// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {clearFlag, flagsOf, parseFlagMap, pruneFlags, toggleFlag} from './flags';

describe('review flags', () => {
  it('toggles a frame on and off, keeping each lane sorted', () => {
    let m = toggleFlag({}, 1, 30);
    m = toggleFlag(m, 1, 4);
    m = toggleFlag(m, 2, 9);
    expect(flagsOf(m, 1)).toEqual([4, 30]);
    expect(flagsOf(m, 2)).toEqual([9]);
    m = toggleFlag(m, 1, 30);
    expect(flagsOf(m, 1)).toEqual([4]);
    expect(flagsOf(toggleFlag(m, 2, 9), 2)).toEqual([]);
    expect(toggleFlag(m, 2, 9)).not.toHaveProperty('2');
  });

  it('clears a flag once its frame is corrected, and leaves the map alone otherwise', () => {
    const m = toggleFlag(toggleFlag({}, 1, 4), 1, 8);
    expect(flagsOf(clearFlag(m, 1, 4), 1)).toEqual([8]);
    expect(clearFlag(m, 1, 5)).toBe(m);
    expect(clearFlag(m, 3, 4)).toBe(m);
  });

  it('forgets removed objects', () => {
    const m = toggleFlag(toggleFlag({}, 1, 4), 2, 8);
    expect(pruneFlags(m, [2])).toEqual({2: [8]});
  });

  it('reads back only well-formed stored flags', () => {
    expect(parseFlagMap({1: [8, 4, 4], 2: 'x', x: [1], 3: [-1, 2.5, 6]})).toEqual({1: [4, 8], 3: [6]});
    expect(parseFlagMap(null)).toEqual({});
  });
});
