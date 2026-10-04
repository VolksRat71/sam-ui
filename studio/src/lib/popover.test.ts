import {expect, it} from 'vitest';
import {placePopover} from './popover';

it('keeps the timeline engine menu inside either horizontal viewport edge', () => {
  for (const left of [-20, 76, 1250]) {
    const p = placePopover({left, top: 350, bottom: 380}, 320, 236, {width: 1280, height: 800});
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(1272);
  }
});
it('opens above a low trigger and limits tall content on narrow screens', () => {
  const p = placePopover({left: 100, top: 450, bottom: 480}, 320, 600, {width: 300, height: 600});
  expect(p.width).toBe(284);
  expect(p.top).toBeGreaterThanOrEqual(8);
  expect(p.top + p.maxHeight).toBeLessThan(450);
});
