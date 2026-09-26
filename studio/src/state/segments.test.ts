// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {encode, DataArray} from '@/jscocotools/mask';
import {paintMask} from '~/worker/maskPixels';
import {maskSegments} from './segments';

describe('maskSegments', () => {
  it('finds runs of non-empty masks in a sparse array', () => {
    const m = (isEmpty: boolean) => ({isEmpty});
    const masks: Array<{isEmpty: boolean} | undefined> = [];
    masks[1] = m(false);
    masks[2] = m(false);
    masks[3] = m(true);
    masks[5] = m(false);
    expect(maskSegments(masks)).toEqual([
      [1, 2],
      [5, 5],
    ]);
    expect(maskSegments([])).toEqual([]);
  });

  it('closes a run that reaches the last frame', () => {
    expect(maskSegments([{isEmpty: false}, {isEmpty: false}])).toEqual([[0, 1]]);
  });
});

describe('paintMask', () => {
  it('paints an RLE mask row-major, with an outline and a translucent fill', () => {
    const h = 8;
    const w = 10;
    const bits = new Uint8Array(h * w); // column-major: x * h + y
    for (let x = 2; x < 9; x++) {
      for (let y = 1; y < 7; y++) {
        bits[x * h + y] = 1;
      }
    }
    const [rle] = encode(new DataArray(bits, [h, w, 1]));
    const out = new Uint32Array(w * h);
    paintMask(out, w, h, rle, '#3880F3', 0.5);
    const alpha = (x: number, y: number) => out[y * w + x] >>> 24;
    const red = (x: number, y: number) => out[y * w + x] & 0xff;
    expect(alpha(0, 0)).toBe(0); // outside
    expect(alpha(2, 1)).toBe(255); // outline
    expect(alpha(5, 4)).toBe(128); // inside, 2 px from every edge
    expect(red(5, 4)).toBe(0x38);
  });
});
