// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The layer and background Pixelate's block size and feather, as pushed to
// the GPU on every apply (recording WebGL2 context, fakeGL).
import {describe, expect, it} from 'vitest';
import {EFFECT_SPECS} from './EffectParamSpecs';
import {setUpGL} from './fakeGL';
import PixelateEffect, {pixelBlock} from './PixelateEffect';
import PixelateMaskGLEffect from './PixelateMaskGLEffect';

describe('pixelBlock', () => {
  it('gives Fine/Medium/Coarse the old 10/20/30 px blocks at 720p, and whole pixels, at least 1', () => {
    for (const name of ['Pixelate', 'PixelateMask']) {
      expect(Object.values(EFFECT_SPECS[name].styles).map(p => pixelBlock(p.size as number, 720))).toEqual([10, 20, 30]);
    }
    expect(pixelBlock(0.042, 1080)).toBe(45);
    expect(pixelBlock(0.002, 100)).toBe(1);
  });
});

describe('PixelateMaskGLEffect', () => {
  it('pushes block size and feather from params on each apply, nothing carried over', async () => {
    const {effect, calls, form, context, uniforms} = await setUpGL(new PixelateMaskGLEffect());
    effect.setParams({size: 0.08, feather: 1, style: 'Coarse'});
    let from = calls.length;
    effect.apply(form, context(2), []);
    let u = uniforms(from);
    expect(u.get('uBlockSize')).toBe(2); // 0.08 x 20 px
    expect(u.get('uFeather')).toBeCloseTo(0.4 / Math.sqrt(3)); // 2 % of 20 px, as a box
    expect(u.get('uNumMasks')).toBe(2);

    effect.setParams({});
    from = calls.length;
    effect.apply(form, context(1), []);
    u = uniforms(from);
    expect(u.get('uBlockSize')).toBe(1); // Fine's 0.014 x 20 px, rounded
    expect(u.get('uFeather')).toBe(0); // the hard edge, as before
  });
});

describe('PixelateEffect', () => {
  it('pushes the block size from params on each apply', async () => {
    const {effect, calls, form, context, uniforms} = await setUpGL(new PixelateEffect());
    effect.setParams({size: 0.08});
    let from = calls.length;
    effect.apply(form, context(0), []);
    expect(uniforms(from).get('uBlockSize')).toBe(2);
    effect.setParams({size: 0.002});
    from = calls.length;
    effect.apply(form, context(0), []);
    expect(uniforms(from).get('uBlockSize')).toBe(1);
  });
});
