import {expect, it} from 'vitest';
import {DataArray, decode, encode} from '@/jscocotools/mask';
import {detailAvailable, combineDetail, type DetailRecord} from './detail';
it('composes only the crop, preserves base, and leaves no-detail RLE untouched', () => {
  const pixels = new Uint8Array(16); pixels[0] = 1;
  const base = encode(new DataArray(pixels, [4, 4, 1]))[0];
  const d: DetailRecord = {id: 'a', rect: [2, 1, 4, 3], points: [[.5, .5, 1]], mask: encode(new DataArray(new Uint8Array([1, 1, 1, 1]), [2, 2, 1]))[0], geometry: {version: 'working-copy-v1', width: 4, height: 4}};
  expect(combineDetail(base, [])).toBe(base);
  const expected = pixels.slice(); for (const i of [9, 10, 13, 14]) expected[i] = 1;
  expect(decode([combineDetail(base, [d])!]).data).toEqual(expected);
  expect(decode([base]).data).toEqual(pixels);
});

it('hides Refine Detail from the browser-only engine and offline mode', () => {
  expect(detailAvailable(false, 'sam2')).toBe(false);
  expect(detailAvailable(true, 'browser-sam2')).toBe(false);
  expect(detailAvailable(true, 'sam2')).toBe(true);
});

it('does not create a floating patch when the base is absent or empty', () => {
  const d: DetailRecord = {id: 'a', rect: [0, 0, 1, 1], points: [[.5, .5, 1]], mask: encode(new DataArray(new Uint8Array([1]), [1, 1, 1]))[0], geometry: {version: 'working-copy-v1', width: 2, height: 2}};
  const empty = encode(new DataArray(new Uint8Array(4), [2, 2, 1]))[0];
  expect(combineDetail(undefined, [d])).toBeUndefined();
  expect(combineDetail(empty, [d])).toBe(empty);
});
