import {describe, expect, it} from 'vitest';
import {formatTimecode, rangeGeometry} from './geometry';

describe('lined-script frame geometry', () => {
  it('gives a single inclusive frame one cell, and a full clip exactly 100%', () => {
    expect(rangeGeometry({start: 0, end: 0}, 247, 'inclusive')).toEqual({left: 0, width: 100 / 247});
    expect(rangeGeometry({start: 0, end: 246}, 247, 'inclusive')).toEqual({left: 0, width: 100});
    expect(rangeGeometry({start: 246, end: 246}, 247, 'inclusive').width).toBeCloseTo(100 / 247);
  });
  it('aligns adjacent exclusive Look clips without gaps or double-counting', () => {
    const a = rangeGeometry({start: 0, end: 45}, 247, 'exclusive');
    const b = rangeGeometry({start: 45, end: 247}, 247, 'exclusive');
    expect(a.left + a.width).toBe(b.left);
    expect(b.left + b.width).toBeCloseTo(100);
    expect(rangeGeometry({start: 45, end: 45}, 247, 'exclusive').width).toBe(0);
  });
  it('clips out-of-bounds spans and handles empty videos', () => {
    expect(rangeGeometry({start: -4, end: 500}, 247, 'inclusive')).toEqual({left: 0, width: 100});
    expect(rangeGeometry({start: 3, end: 1}, 247, 'inclusive').width).toBe(0);
    expect(rangeGeometry({start: 0, end: 0}, 0, 'inclusive')).toEqual({left: 0, width: 0});
  });
});

describe('slate timecode', () => {
  it('rolls frames, seconds, minutes and hours from zero-based frame indices', () => {
    expect(formatTimecode(23, 24)).toBe('00:00:00:23');
    expect(formatTimecode(24, 24)).toBe('00:00:01:00');
    expect(formatTimecode(24 * 60, 24)).toBe('00:01:00:00');
    expect(formatTimecode(24 * 3600, 24)).toBe('01:00:00:00');
    expect(formatTimecode(216, 24)).toBe('00:00:09:00');
    expect(formatTimecode(30, 29.97)).toBe('00:00:01:00');
  });
  it('keeps unavailable and negative input readable', () => {
    expect(formatTimecode(-1, 24)).toBe('00:00:00:00');
    expect(formatTimecode(0, 0)).toBe('00:00:00:00');
    expect(formatTimecode(Infinity, 24)).toBe('00:00:00:00');
  });
});
