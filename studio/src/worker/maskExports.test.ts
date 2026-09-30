// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import type {RLEObject} from '@/jscocotools/mask';
import {sourceWithoutAbsent, type MaskSource} from './maskExports';

describe('sourceWithoutAbsent', () => {
  const car = {objectId: 2, label: 'Red car', name: 'car', state: 'tracked', prompt: 'red car', color: '#ff0000', ranges: [{start: 3, end: 5, state: 'absent' as const}]};
  const rle = (id: number, frame: number) => ({size: [1, 1], counts: `${id}@${frame}`}) as unknown as RLEObject;

  it('calls the original source, not itself, once the source is rebound', () => {
    let src: MaskSource = {maskAt: rle, seedsOf: () => new Map()};
    // buildExport rebinds its parameter the same way
    src = sourceWithoutAbsent(src, [car, {...car, objectId: 7, ranges: []}]);
    expect(src.maskAt(2, 2)).toEqual(rle(2, 2));
    expect(src.maskAt(2, 4)).toBeNull();
    expect(src.maskAt(7, 4)).toEqual(rle(7, 4));
  });
});
