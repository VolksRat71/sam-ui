import {expect, it} from 'vitest';
import {parseObjectColors, recolorTracklets} from './objectColors';
import {colorFor} from './objects';

it('accepts only safe object ids and six-digit display colors from storage', () => {
  expect(parseObjectColors({'2': '#Aa22fF', '-1': '#ffffff', 'oops': '#ffffff', '3': 'red', '4': '#123', '5': 'url(x)'})).toEqual({2: '#aa22ff'});
  for (const raw of [null, [], 'bad', 42]) expect(parseObjectColors(raw)).toEqual({});
});

it('recolors synthetic tracklets and resets defaults without touching masks or clicks', () => {
  const masks = Object.freeze([{frame: 0, data: Object.freeze([0, 3, 2])}]);
  const points = Object.freeze([[0.2, 0.4, 1]]);
  const a = {id: 0, color: colorFor(0), masks, points};
  const b = {id: 1, color: colorFor(1), masks, points};
  recolorTracklets([a, b], {0: '#c05cff'});
  expect(a.color).toBe('#c05cff');
  expect(b.color).toBe(colorFor(1));
  expect(a.masks).toBe(masks);
  expect(a.points).toBe(points);
  recolorTracklets([a, b], {});
  expect(a.color).toBe(colorFor(0));
  expect(a.masks).toBe(masks);
  expect(a.points).toBe(points);
});
