// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Outline's settings and what it pushes to the GPU, against a fake WebGL2
// context that records calls (no GPU in vitest). The pixels are checked in
// the browser harness (see the PR).
import {describe, expect, it} from 'vitest';
import {setUpGL} from './fakeGL';
import OutlineGLEffect, {NOISE_SIZE, boilStep, outlineRgb, resolveOutlineParams, scribbleNoise} from './OutlineGLEffect';

describe('resolveOutlineParams', () => {
  it('defaults every missing param', () => {
    expect(resolveOutlineParams({})).toEqual({width: 0.006, color: 'layer', opacity: 1, softness: 0.25, glow: false, scribble: false, wobble: 0.008, boil: 8});
  });

  it('clamps numbers to range and ignores wrong types', () => {
    expect(resolveOutlineParams({width: 1, opacity: -2, softness: 3})).toMatchObject({width: 0.05, opacity: 0, softness: 1});
    expect(resolveOutlineParams({width: 0})).toMatchObject({width: 0.002});
    expect(resolveOutlineParams({width: '0.02', opacity: NaN, softness: true})).toMatchObject({width: 0.006, opacity: 1, softness: 0.25});
  });

  it("takes '#rrggbb' or 'layer' as the colour, anything else follows the layer", () => {
    expect(resolveOutlineParams({color: '#FFaa00'}).color).toBe('#FFaa00');
    expect(resolveOutlineParams({color: 'layer'}).color).toBe('layer');
    expect(resolveOutlineParams({color: 'red'}).color).toBe('layer');
    expect(resolveOutlineParams({color: '#fff'}).color).toBe('layer');
  });

  it("is Glow only for style 'Glow', Scribble only for 'Scribble'", () => {
    expect(resolveOutlineParams({style: 'Glow'}).glow).toBe(true);
    expect(resolveOutlineParams({style: 'Outline'}).glow).toBe(false);
    expect(resolveOutlineParams({style: 'glow'}).glow).toBe(false);
    expect(resolveOutlineParams({style: 'Scribble'})).toMatchObject({scribble: true, glow: false});
    expect(resolveOutlineParams({style: 'Glow'}).scribble).toBe(false);
  });

  it("clamps Scribble's wobble and boil", () => {
    expect(resolveOutlineParams({wobble: 1, boil: 100})).toMatchObject({wobble: 0.03, boil: 24});
    expect(resolveOutlineParams({wobble: -1, boil: -3})).toMatchObject({wobble: 0, boil: 0});
    expect(resolveOutlineParams({wobble: 'x', boil: null as unknown as number})).toMatchObject({wobble: 0.008, boil: 8});
  });
});

describe('Scribble noise', () => {
  it('is the same lattice for the same seed, every time', () => {
    const a = scribbleNoise(7);
    expect(a).toHaveLength(NOISE_SIZE * NOISE_SIZE);
    expect(scribbleNoise(7)).toEqual(a);
    // pinned: changing the hash changes how every saved Scribble looks
    expect(Array.from(scribbleNoise(0).slice(0, 4))).toEqual([16, 237, 150, 115]);
  });

  it('differs between seeds and spreads over 0..255', () => {
    const [a, b] = [scribbleNoise(0), scribbleNoise(1)];
    const same = a.filter((v, i) => v === b[i]).length;
    expect(same).toBeLessThan(a.length / 50);
    const mean = a.reduce((m, v) => m + v, 0) / a.length;
    expect(mean).toBeGreaterThan(110);
    expect(mean).toBeLessThan(145);
  });

  it('boils on the clip clock: boil redraws a second, none at 0 or with no clock', () => {
    expect(boilStep(0, 8)).toBe(0);
    expect(boilStep(0.124, 8)).toBe(0);
    expect(boilStep(0.125, 8)).toBe(1); // frame 3 at 24 fps
    expect(boilStep(3 / 24, 8)).toBe(1);
    expect(boilStep(1, 8)).toBe(8);
    expect(boilStep(1001 / 30, 12)).toBe(400); // 1001/30 x 12 = 400.4
    expect(boilStep(5, 0)).toBe(0);
    expect(boilStep(undefined, 8)).toBe(0);
  });
});

describe('outlineRgb', () => {
  it('follows the layer colour for layer, else the given colour', () => {
    expect(outlineRgb('layer', '#ff0000')).toEqual([1, 0, 0]);
    expect(outlineRgb('#00ff00', '#ff0000')).toEqual([0, 1, 0]);
  });
});

const setUp = () => setUpGL(new OutlineGLEffect());

describe('OutlineGLEffect', () => {
  it('pushes every setting from params on each apply', async () => {
    const {effect, calls, form, drawImage, context, uniforms} = await setUp();
    effect.setParams({width: 0.05, color: 'layer', opacity: 0.5, softness: 0.8, style: 'Glow'});
    let from = calls.length;
    effect.apply(form, context(2), []);
    let u = uniforms(from);
    expect(u.get('uWidth')).toBe(1); // 0.05 x 20 px
    expect(u.get('uRadius')).toBe(2);
    expect(u.get('uGlow')).toBe(1);
    expect(u.get('uOpacity')).toBe(0.5);
    expect(u.get('uSoftness')).toBe(0.8);
    expect(u.get('uNumMasks')).toBe(2);
    expect(u.get('uColor0')).toEqual([1, 0, 0]);
    expect(u.get('uColor1')).toEqual([0, 0, 1]);
    expect(drawImage).toHaveBeenCalledTimes(1);

    // the next object's params replace these entirely: nothing carries over
    effect.setParams({color: '#00ff00'});
    from = calls.length;
    effect.apply(form, context(1), []);
    u = uniforms(from);
    expect(u.get('uWidth')).toBeCloseTo(0.12);
    expect(u.get('uGlow')).toBe(0);
    expect(u.get('uOpacity')).toBe(1);
    expect(u.get('uNumMasks')).toBe(1);
    expect(u.get('uColor0')).toEqual([0, 1, 0]);
  });

  it('makes no GL resources per frame, and frees them on cleanup', async () => {
    const {effect, calls, form, context} = await setUp();
    const created = () => calls.filter(([name]) => name.startsWith('create')).length;
    const before = created();
    for (let i = 0; i < 5; i++) {
      effect.apply(form, context(3), []);
    }
    expect(created()).toBe(before);
    await effect.cleanup();
    const deleted = calls.filter(([name]) => /^delete(Texture|Framebuffer)$/.test(name)).length;
    expect(deleted).toBe(1 + 3 + 2 + 1 + 2); // frame texture, masks, targets, noise, framebuffers
  });

  it("pushes Scribble's settings and the lattice for the clip time's boil step", async () => {
    const {effect, calls, form, context, uniforms} = await setUp();
    const noiseUploads = (from: number) =>
      calls.slice(from).filter(([name, args]) => name === 'texImage2D' && args[3] === NOISE_SIZE).map(([, args]) => args[8] as Uint8Array);
    const draw = (time: number | undefined) => {
      const from = calls.length;
      effect.apply(form, {...context(1), time}, []);
      return {u: uniforms(from), noise: noiseUploads(from)};
    };
    effect.setParams({style: 'Scribble', width: 0.05, wobble: 0.03, boil: 8});
    const a = draw(0.25);
    expect(a.u.get('uScribble')).toBe(1);
    expect(a.u.get('uGlow')).toBe(0);
    expect(a.u.get('uWobble')).toBeCloseTo(0.6); // 0.03 x 20 px
    expect(a.u.get('uRadius')).toBe(Math.ceil(0.6 + 1.5 * 1 + 1));
    expect(a.u.get('uNoiseScale')).toBeCloseTo(16 / 20 / NOISE_SIZE); // 16 lattice cells a frame height
    expect(a.noise).toEqual([scribbleNoise(2)]);
    expect(draw(0.25).noise).toEqual(a.noise); // the same frame again: the same lattice
    expect(draw(0.3).noise).toEqual(a.noise); // within the same boil step
    expect(draw(0.375).noise).toEqual([scribbleNoise(3)]);
    effect.setParams({style: 'Scribble', boil: 0});
    expect(draw(9).noise).toEqual([scribbleNoise(0)]);
    // other styles ignore the wobble
    effect.setParams({style: 'Outline', wobble: 0.03});
    const o = draw(0.25);
    expect(o.u.get('uScribble')).toBe(0);
    expect(o.u.get('uWobble')).toBe(0);
  });

  it('draws nothing with no masks', async () => {
    const {effect, form, drawImage, context} = await setUp();
    effect.apply(form, context(0), []);
    expect(drawImage).not.toHaveBeenCalled();
  });
});
