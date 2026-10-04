// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {COMPACT_QUERY, DESKTOP_MIN_WIDTH, isCompact, layoutFor} from './layout';

describe('layoutFor', () => {
  it('is the desktop layout at or above the desktop width, whatever the height', () => {
    expect(layoutFor(1440, 900)).toBe('desktop');
    expect(layoutFor(DESKTOP_MIN_WIDTH, 700)).toBe('desktop');
    expect(layoutFor(1180, 820)).toBe('desktop'); // an iPad on its side
    expect(layoutFor(1400, 420)).toBe('desktop'); // a short desktop window
  });

  it('a phone held upright', () => {
    expect(layoutFor(390, 844)).toBe('phone-portrait'); // iPhone 14
    expect(layoutFor(344, 882)).toBe('phone-portrait'); // a foldable, folded
    expect(layoutFor(599, 900)).toBe('phone-portrait');
  });

  it('a phone on its side', () => {
    expect(layoutFor(844, 390)).toBe('phone-landscape');
    expect(layoutFor(932, 430)).toBe('phone-landscape'); // iPhone Pro Max
    expect(layoutFor(568, 320)).toBe('phone-landscape'); // narrower than a phone held upright
  });

  it('a tablet, or a foldable opened out', () => {
    expect(layoutFor(820, 1180)).toBe('tablet'); // iPad Air, upright
    expect(layoutFor(768, 1024)).toBe('tablet');
    expect(layoutFor(717, 512)).toBe('tablet'); // a foldable, unfolded, on its side
    expect(layoutFor(600, 960)).toBe('tablet');
    expect(layoutFor(1023, 700)).toBe('tablet');
  });

  it('compact is every layout but desktop', () => {
    expect(isCompact('desktop')).toBe(false);
    expect(isCompact('tablet')).toBe(true);
    expect(isCompact('phone-landscape')).toBe(true);
    expect(isCompact('phone-portrait')).toBe(true);
  });

  it('the compact media query stops just below the desktop width', () => {
    expect(COMPACT_QUERY).toBe('(max-width: 1023.98px)');
  });
});
