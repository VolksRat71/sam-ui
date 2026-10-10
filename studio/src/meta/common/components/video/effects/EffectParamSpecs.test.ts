// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {migrateV1, normalizeParams, withStyle} from '~/state/effectClips';
import {blurSigma, resolveBlurParams} from './BlurGLEffect';
import type {EffectParams} from './Effect';
import {EFFECT_SPECS, styleIndex} from './EffectParamSpecs';
import AllEffects from './Effects';
import {pixelBlock} from './PixelateEffect';

describe('effect param specs', () => {
  it("name every registered effect's variants, in order ('Overlay' is studio's four-fill MaskOverlayEffect)", () => {
    for (const [name, effect] of Object.entries(AllEffects)) {
      const style = EFFECT_SPECS[name]?.params.style;
      expect(style?.kind, name).toBe('choice');
      if (Object.keys(EFFECT_SPECS[name].params).length > 1) {
        continue; // an effect with real settings (Outline) reads its style itself
      }
      const count = name === 'Overlay' ? 4 : effect.numVariants;
      expect(style?.kind === 'choice' && style.options.length, name).toBe(count);
    }
  });

  it('turn a style back into its variant, and anything else into 0', () => {
    expect(styleIndex('EraseForeground', {style: 'Green'})).toBe(2);
    expect(styleIndex('Outline', {style: 'Glow'})).toBe(1);
    expect(styleIndex('Cutout', {style: 'nope'})).toBe(0);
    expect(styleIndex('NotAnEffect', {style: 'Green'})).toBe(0);
  });

  it("every style preset is valid for its effect's own params", () => {
    for (const [name, spec] of Object.entries(EFFECT_SPECS)) {
      for (const preset of Object.values(spec.styles)) {
        for (const key of Object.keys(preset)) {
          expect(spec.params[key], `${name}.${key}`).toBeDefined();
        }
      }
    }
  });

  it("shows a style-only setting only for styles the effect has", () => {
    for (const [name, spec] of Object.entries(EFFECT_SPECS)) {
      const style = spec.params.style;
      for (const p of Object.values(spec.params)) {
        if (p.kind === 'number' && p.onlyStyles != null) {
          expect(style?.kind === 'choice' && p.onlyStyles.every(s => style.options.includes(s)), name).toBe(true);
        }
      }
    }
  });
});

describe('clips saved before Pixelate and Blur had settings (style only)', () => {
  // Meta's sizes by style, in px at 720p: what those clips drew
  const OLD = {
    Pixelate: [10, 20, 30],
    PixelateMask: [10, 20, 30],
    BackgroundBlur: [3, 6, 12],
  };
  // a block size in px, or a blur's sigma (the blur's radius sets it)
  const drawn = (effect: string, params: EffectParams) =>
    effect === 'BackgroundBlur' ? resolveBlurParams(effect, params, 720).sigma : pixelBlock(params.size as number, 720);
  const old = (effect: string, px: number) => (effect === 'BackgroundBlur' ? blurSigma(px) : px);

  it('draw at their style\'s old size, from a stored v2 doc or a v1 map', () => {
    for (const [effect, sizes] of Object.entries(OLD)) {
      const style = EFFECT_SPECS[effect].params.style;
      const options = style.kind === 'choice' ? style.options : [];
      options.forEach((o, variant) => {
        const stored = normalizeParams(effect, {style: o});
        expect(drawn(effect, stored), `${effect} ${o}`).toBe(old(effect, sizes[variant]));
        expect(stored).toEqual(withStyle(effect, normalizeParams(effect, {}), o));
        const v1 = migrateV1({1: {name: effect, variant}}, 10).clips[0].params;
        expect(v1, `${effect} v1 variant ${variant}`).toEqual(stored);
      });
    }
  });

  it('keep settings they do have, and the feather starts hard (as before)', () => {
    expect(normalizeParams('PixelateMask', {style: 'Coarse', size: 0.02})).toMatchObject({size: 0.02, feather: 0});
    expect(normalizeParams('PixelateMask', {style: 'Medium'}).feather).toBe(0);
  });
});
