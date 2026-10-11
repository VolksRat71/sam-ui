// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {migrateV1, normalizeParams} from '~/state/effectClips';
import {EFFECT_SPECS, styleIndex} from './EffectParamSpecs';
import {setUpGL} from './fakeGL';
import ScopeGLEffect from './ScopeGLEffect';

const STYLES = ['Colour disc', 'Colour ring', 'White disc', 'White ring', 'Soft disc', 'Soft ring'];

describe('Spotlight (Scope) settings', () => {
  it("keeps Meta's six variants as its styles, in order, each a shape and colour at size 1, thickness 1, darken 0", () => {
    const style = EFFECT_SPECS.Scope.params.style;
    expect(style.kind === 'choice' && style.options).toEqual(STYLES);
    STYLES.forEach((s, variant) => {
      const stored = normalizeParams('Scope', {style: s}); // a clip saved before Spotlight had settings
      expect(stored).toEqual({
        shape: variant % 2 === 1 ? 'Ring' : 'Disc',
        color: variant === 2 || variant === 3 ? '#ffffff' : 'layer',
        size: 1,
        thickness: 1,
        darken: 0,
        style: s,
      });
      expect(styleIndex('Scope', stored)).toBe(variant);
      expect(migrateV1({1: {name: 'Scope', variant}}, 10).clips[0].params).toEqual(stored);
    });
  });

  // Meta's ScopeGLEffect, per variant v: ring = v % 2, white = floor(v / 2) % 2 (a vec4(1) fill),
  // see-through = floor(v / 2) % 3 == 2 (the layer colour's alpha, 128), radius 0.8 and ring 0.085 in the shader
  it("gives Meta's uniforms for each old style: the same shape, fill colour and see-through flag", async () => {
    for (const [variant, s] of STYLES.entries()) {
      const {effect, calls, form, context, uniforms} = await setUpGL(new ScopeGLEffect());
      effect.setParams(normalizeParams('Scope', {style: s}));
      effect.variant = styleIndex('Scope', effect.params);
      const from = calls.length;
      effect.apply(form, context(2), []);
      const u = uniforms(from);
      const white = Math.floor(variant / 2) % 2 === 1;
      expect(u.get('uFillColor'), s).toBe(variant % 2);
      expect(u.get('uTransparency'), s).toBe(Math.floor(variant / 2) % 3 === 2 ? 1 : 0);
      // white was vec4(1) with alpha forced to 1; (255, 255, 255, a) / 255 with alpha forced to 1 is the same
      expect(u.get('uMaskColor0'), s).toEqual(white ? [255, 255, 255, 128] : [255, 0, 0, 128]);
      expect(u.get('uMaskColor1'), s).toEqual(white ? [255, 255, 255, 128] : [0, 0, 255, 128]);
      expect([u.get('uScale'), u.get('uThickness'), u.get('uDimCount')], s).toEqual([1, 1, 0]);
    }
  });

  it('draws the chosen shape, colour, size and thickness, set again on every apply; never darkens in a pass', async () => {
    const {effect, calls, form, context, uniforms} = await setUpGL(new ScopeGLEffect());
    effect.setParams(normalizeParams('Scope', {style: 'Colour disc', shape: 'Ring', color: '#00ff00', size: 1.5, thickness: 2, darken: 0.6}));
    let from = calls.length;
    effect.apply(form, context(1), []);
    let u = uniforms(from);
    expect([u.get('uFillColor'), u.get('uMaskColor0'), u.get('uScale'), u.get('uThickness'), u.get('uDimCount')]).toEqual([1, [0, 255, 0, 128], 1.5, 2, 0]);
    effect.setParams(normalizeParams('Scope', {style: 'Colour disc'}));
    from = calls.length;
    effect.apply(form, context(1), []);
    u = uniforms(from);
    expect([u.get('uFillColor'), u.get('uMaskColor0'), u.get('uScale'), u.get('uThickness'), u.get('uDimCount')]).toEqual([0, [255, 0, 0, 128], 1, 1, 0]);
  });

  it('dims once outside any number of circles, each at its size, and the next pass is a normal one again', async () => {
    const {effect, calls, form, context, uniforms, drawImage} = await setUpGL(new ScopeGLEffect());
    const ctx = context(3);
    const circles = ctx.masks.map((mask, k) => ({mask, size: [1, 1.5, 0.5][k]}));
    let from = calls.length;
    effect.dim(form, ctx, circles, 0.6);
    let u = uniforms(from);
    expect(u.get('uDimCount')).toBe(3);
    expect(u.get('uDarken')).toBe(0.6);
    expect([...(u.get('uDimScale') as Float32Array).slice(0, 3)]).toEqual([1, 1.5, 0.5]);
    expect([...(u.get('uDimBox') as Float32Array).slice(0, 4)]).toEqual([4 / 32, 4 / 20, 12 / 32, 12 / 20].map(Math.fround));
    expect(calls.slice(from).filter(([n]) => n === 'drawArrays')).toHaveLength(1);
    expect(drawImage).toHaveBeenCalledTimes(1);
    effect.dim(form, ctx, [], 0.6); // nothing to cut out: nothing drawn
    expect(drawImage).toHaveBeenCalledTimes(1);
    effect.setParams(normalizeParams('Scope', {}));
    from = calls.length;
    effect.apply(form, ctx, []);
    u = uniforms(from);
    expect(u.get('uDimCount')).toBe(0);
  });
});
