// sam-ui (Apache-2.0). New file, not from SAM 2.
import {DataArray, decode, encode} from '@/jscocotools/mask';
import {describe, expect, it} from 'vitest';
import {normalizeParams} from '~/state/effectClips';
import type {EffectMask} from './Effect';
import {setUpGL} from './fakeGL';
import SubjectsBackgroundGLEffect, {gradientDirection, imageRect, unionMasks} from './SubjectsBackgroundGLEffect';

const W = 32;
const H = 20;

/** A mask of the pixels `inside(x, y)`, column-major as SAM's RLE. */
function maskOf(inside: (x: number, y: number) => boolean): EffectMask {
  const data = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) data[x * H + y] = inside(x, y) ? 1 : 0;
  return {bitmap: encode(new DataArray(data, [H, W, 1]))[0], bounds: [[0, 0], [W, H]]};
}

const bitmap = (width: number, height: number) => ({width, height}) as ImageBitmap;
const HASH = 'ab'.repeat(32);

describe('unionMasks', () => {
  it("is jscocotools' decode of every mask, OR-ed, as 0/255, whatever was in the buffer", () => {
    const masks = [
      maskOf((x, y) => x > 3 && x < 12 && y > 2 && y < 9),
      maskOf((x, y) => (x - 20) ** 2 + (y - 10) ** 2 < 30),
      maskOf((x, y) => (x * 7 + y * 3) % 5 === 0), // many short runs: counts past the delta-coded third
      maskOf(() => false),
    ];
    const want = new Uint8Array(W * H);
    for (const m of masks) {
      decode([m.bitmap as never]).data.forEach((v, i) => (want[i] = v > 0 ? 255 : want[i]));
    }
    const out = new Uint8Array(W * H).fill(7);
    unionMasks(masks, out);
    expect(out).toEqual(want);
    unionMasks([], out);
    expect(out.every(v => v === 0)).toBe(true);
    unionMasks([maskOf(() => true)], out);
    expect(out.every(v => v === 255)).toBe(true);
  });
});

describe('picture placement and gradient direction', () => {
  it('Cover fills the frame (cropping), Contain shows all of the picture (bars)', () => {
    expect(imageRect('Cover', {width: 1280, height: 720}, 1280, 720)).toEqual([0, 0, 1, 1]);
    // a square picture on a 16:9 frame
    const cover = imageRect('Cover', {width: 100, height: 100}, 160, 90);
    expect(cover[2]).toBeCloseTo(1);
    expect(cover[3]).toBeCloseTo(160 / 90);
    expect(cover[1]).toBeCloseTo((1 - 160 / 90) / 2);
    const contain = imageRect('Contain', {width: 100, height: 100}, 160, 90);
    expect(contain[3]).toBeCloseTo(1);
    expect(contain[2]).toBeCloseTo(90 / 160);
    expect(contain[0]).toBeCloseTo((1 - 90 / 160) / 2);
  });

  it('runs corner to corner like a CSS linear-gradient at that angle', () => {
    const along = (deg: number, x: number, y: number) => {
      const [dx, dy] = gradientDirection(deg, 160, 90);
      return (x - 80) * dx + (y - 45) * dy + 0.5;
    };
    expect(along(180, 80, 0)).toBeCloseTo(0); // to the bottom: top edge 0, bottom 1
    expect(along(180, 80, 90)).toBeCloseTo(1);
    expect(along(90, 0, 45)).toBeCloseTo(0); // to the right
    expect(along(90, 160, 45)).toBeCloseTo(1);
    expect(along(45, 0, 90)).toBeCloseTo(0); // bottom-left corner to top-right
    expect(along(45, 160, 0)).toBeCloseTo(1);
  });
});

describe('SubjectsBackgroundGLEffect', () => {
  const replace = (params: Record<string, unknown>) => normalizeParams('ReplaceBackground', params);

  it('sets every uniform on every apply, so one instance serves clips with different settings', async () => {
    const {effect, calls, form, context, uniforms, drawImage} = await setUpGL(new SubjectsBackgroundGLEffect('ReplaceBackground'));
    effect.setParams(replace({style: 'Gradient', color: '#ff0000', color2: '#0000ff', angle: 90, feather: 1}));
    let from = calls.length;
    effect.apply(form, context(2), []);
    const a = uniforms(from);
    effect.setParams(replace({style: 'Colour', color: '#00ff00'}));
    from = calls.length;
    effect.apply(form, context(1), []);
    const b = uniforms(from);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    expect(a.get('uFill')).toBe(1);
    expect(a.get('uColor')).toEqual([1, 0, 0]);
    expect(a.get('uColor2')).toEqual([0, 0, 1]);
    expect(a.get('uDirection')).toEqual(gradientDirection(90, W, H));
    expect(a.get('uFeather')).toBeCloseTo((0.02 * H) / Math.sqrt(3));
    expect(b.get('uFill')).toBe(0);
    expect(b.get('uColor')).toEqual([0, 1, 0]);
    expect(b.get('uFeather')).toBe(0);
    expect(b.get('uMode')).toBe(0);
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it('uploads the union of every mask as one texture, the frame as another', async () => {
    const {effect, calls, form, context} = await setUpGL(new SubjectsBackgroundGLEffect('ColorPop'));
    effect.setParams(normalizeParams('ColorPop', {}));
    const from = calls.length;
    const ctx = context(3);
    ctx.masks = [maskOf((x, y) => x < 5 && y < 5), maskOf((x, y) => x > 25 && y > 15), maskOf(() => false)];
    effect.apply(form, ctx, []);
    const uploads = calls.slice(from).filter(([n]) => n === 'texImage2D');
    expect(uploads).toHaveLength(2);
    const union = uploads[1][1].at(-1) as Uint8Array;
    expect(uploads[1][1].slice(2, 5)).toEqual(['LUMINANCE', H, W]); // column-major, as the masks
    const want = new Uint8Array(W * H);
    unionMasks(ctx.masks, want);
    expect(union).toEqual(want);
    expect(union.filter(v => v === 255)).toHaveLength(25 + 6 * 4);
  });

  it('Colour pop: amount and contrast from its settings, no fill or feather', async () => {
    const {effect, calls, form, context, uniforms} = await setUpGL(new SubjectsBackgroundGLEffect('ColorPop'));
    effect.setParams(normalizeParams('ColorPop', {style: 'Gray, high contrast'}));
    const from = calls.length;
    effect.apply(form, context(1), []);
    const u = uniforms(from);
    expect([u.get('uMode'), u.get('uFill'), u.get('uAmount'), u.get('uContrast'), u.get('uFeather')]).toEqual([1, 0, 1, 1.5, 0]);
  });

  it('a picture this browser lacks draws the colour; one it has is uploaded once, until it changes', async () => {
    const {effect, calls, form, context, uniforms} = await setUpGL(new SubjectsBackgroundGLEffect('ReplaceBackground'));
    const uploadsOf = (from: number) => calls.slice(from).filter(([n, args]) => n === 'texImage2D' && args.length === 6);
    effect.setParams(replace({style: 'Image', image: HASH, color: '#123456'}));
    let from = calls.length;
    effect.apply(form, context(1), []); // no images at all
    expect(uniforms(from).get('uFill')).toBe(0);
    const missing = {...context(1), images: new Map([['cd'.repeat(32), bitmap(10, 10)]])};
    effect.apply(form, missing, []);
    expect(uniforms(from).get('uFill')).toBe(0);
    expect(uploadsOf(from)).toHaveLength(0);

    const pic = bitmap(64, 64);
    const ctx = {...context(1), images: new Map([[HASH, pic]])};
    from = calls.length;
    effect.apply(form, ctx, []);
    effect.apply(form, ctx, []);
    expect(uniforms(from).get('uFill')).toBe(2);
    expect(uniforms(from).get('uImageRect')).toEqual(imageRect('Cover', pic, W, H));
    expect(uploadsOf(from).map(([, args]) => args[5])).toEqual([pic]);
    effect.setParams(replace({style: 'Image', image: HASH, fit: 'Contain'}));
    from = calls.length;
    effect.apply(form, {...ctx, images: new Map([[HASH, bitmap(64, 64)]])}, []);
    expect(uploadsOf(from)).toHaveLength(1);
    expect(uniforms(from).get('uImageRect')).toEqual(imageRect('Contain', pic, W, H));
    // the same key with another fill: no picture
    effect.setParams(replace({style: 'Colour', image: HASH}));
    from = calls.length;
    effect.apply(form, ctx, []);
    expect(uniforms(from).get('uFill')).toBe(0);
  });

  it('frees its textures and program in cleanup, and is set up again on a new context', async () => {
    const {effect, calls} = await setUpGL(new SubjectsBackgroundGLEffect('ReplaceBackground'));
    const created = calls.filter(([n]) => n === 'createTexture').length;
    await effect.cleanup();
    expect(calls.filter(([n]) => n === 'deleteTexture')).toHaveLength(created);
    expect(calls.some(([n]) => n === 'deleteProgram')).toBe(true);
  });
});
