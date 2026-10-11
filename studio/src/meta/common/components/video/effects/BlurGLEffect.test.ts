// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The background and layer Blur's settings and what they push to the GPU,
// against a recording WebGL2 context (fakeGL). Pixels: the PR's browser run.
import {describe, expect, it} from 'vitest';
import BlurGLEffect, {blurSigma, resolveBlurParams} from './BlurGLEffect';
import type {EffectParams} from './Effect';
import {EFFECT_SPECS} from './EffectParamSpecs';
import {setUpGL} from './fakeGL';

describe('resolveBlurParams', () => {
  it("has the old box's spread: sigma of a (2r+1)-tap box", () => {
    expect(blurSigma(3)).toBe(2);
    expect(blurSigma(12)).toBeCloseTo(Math.sqrt(52));
  });

  it('gives Light/Medium/Strong the 3/6/12 px radius of the old styles at 720p', () => {
    const px = Object.values(EFFECT_SPECS.BackgroundBlur.styles).map(p => resolveBlurParams('BackgroundBlur', p as EffectParams, 720).sigma);
    expect(px).toEqual([3, 6, 12].map(blurSigma));
  });

  it('defaults, clamps and reaches 3 sigma; only the layer Blur feathers', () => {
    expect(resolveBlurParams('BackgroundBlur', {}, 720)).toEqual({sigma: 2, taps: 6, featherSigma: 0, featherTaps: 0});
    expect(resolveBlurParams('BackgroundBlur', {radius: 1, feather: 1}, 720)).toMatchObject({sigma: blurSigma(36), featherTaps: 0});
    expect(resolveBlurParams('BlurMask', {radius: 'x', feather: 0.5}, 720)).toEqual({
      sigma: blurSigma(6), // the default: Light, 6 px at 720p
      taps: Math.ceil(3 * blurSigma(6)),
      featherSigma: 2.4, // 0.5 x 2 % of 720 px, over 3
      featherTaps: 8,
    });
    expect(resolveBlurParams('BlurMask', {radius: 0, feather: -1}, 720)).toMatchObject({sigma: blurSigma(1), featherTaps: 0});
  });
});

describe('BlurGLEffect', () => {
  it('pushes every setting on each apply, in two passes, for the whole frame', async () => {
    const {effect, calls, form, drawImage, context, uniforms} = await setUpGL(new BlurGLEffect());
    effect.setParams({radius: 0.05, style: 'Strong'});
    let from = calls.length;
    effect.apply(form, context(2), []); // a background clip: masks are not its business
    let u = uniforms(from);
    expect(u.get('uNumMasks')).toBe(0);
    expect(u.get('uSigma')).toBe(blurSigma(1)); // 0.05 x 20 px
    expect(u.get('uTaps')).toBe(3);
    expect(u.get('uFeatherTaps')).toBe(0);
    expect(u.get('uVertical')).toBe(1);
    expect(calls.slice(from).filter(([n]) => n === 'drawArrays')).toHaveLength(2);
    expect(drawImage).toHaveBeenCalledTimes(1);

    effect.setParams({});
    from = calls.length;
    effect.apply(form, context(0), []);
    u = uniforms(from);
    expect(u.get('uSigma')).toBe(blurSigma(1));
    expect(u.get('uFeatherSigma')).toBe(0);
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it('as the layer Blur: draws only with masks, feathering their edge', async () => {
    const {effect, calls, form, drawImage, context, uniforms} = await setUpGL(new BlurGLEffect(true));
    effect.apply(form, context(0), []);
    expect(drawImage).not.toHaveBeenCalled();
    effect.setParams({radius: 0.05, feather: 1});
    const from = calls.length;
    effect.apply(form, context(3), []);
    const u = uniforms(from);
    expect(u.get('uNumMasks')).toBe(3);
    expect(u.get('uFeatherSigma')).toBeCloseTo(0.4 / 3); // 2 % of 20 px
    expect(u.get('uFeatherTaps')).toBe(1);
    expect(u.get('uMaskTexture2')).toBe(3);
    expect([0, 1, 2].map(i => u.get(`uPass1_${i}`))).toEqual([4, 5, 6]);
    expect(u.get('uFeather')).toBe(7);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('never draws pass 1 into a texture still bound for the last pass 2 (layer: %s)', async masked => {
    const {effect, form, drawImage, context} = await setUpGL(new BlurGLEffect(masked));
    effect.apply(form, context(3), []);
    effect.apply(form, context(3), []); // fakeGL throws on a feedback loop, as Chrome drops the draw
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['background', false, 1 + 2, ['COLOR_ATTACHMENT0', 'NONE', 'NONE', 'COLOR_ATTACHMENT3']], // frame; pass 1: colour, feathers
    ['layer', true, 1 + 3 + 4, ['COLOR_ATTACHMENT0', 'COLOR_ATTACHMENT1', 'COLOR_ATTACHMENT2', 'COLOR_ATTACHMENT3']], // frame, masks; a colour per mask, feathers
  ])('the %s Blur makes no GL resources per frame, and frees them on cleanup', async (_, masked, textures, buffers) => {
    const {effect, calls, form, context} = await setUpGL(new BlurGLEffect(masked));
    const created = () => calls.filter(([name]) => name.startsWith('create')).length;
    const before = created();
    // pass 1 writes every mask's colour and the feathers at once (attachments set once)
    expect(calls.filter(([name]) => name === 'drawBuffers')).toEqual([['drawBuffers', [buffers]]]);
    for (let i = 0; i < 5; i++) {
      effect.apply(form, context(3), []);
    }
    expect(created()).toBe(before);
    expect(calls.filter(([name]) => name === 'drawBuffers')).toHaveLength(1);
    await effect.cleanup();
    expect(calls.filter(([name]) => name === 'deleteTexture')).toHaveLength(textures);
    expect(calls.filter(([name]) => name === 'deleteFramebuffer')).toHaveLength(1);
  });
});
