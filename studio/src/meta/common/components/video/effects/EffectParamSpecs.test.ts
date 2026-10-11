// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {migrateV1, normalizeParams, withStyle} from '~/state/effectClips';
import {blurSigma, resolveBlurParams} from './BlurGLEffect';
import type {EffectParams} from './Effect';
import {EFFECT_SPECS, paramShown, styleIndex} from './EffectParamSpecs';
import AllEffects from './Effects';
import {pixelBlock} from './PixelateEffect';

describe('effect param specs', () => {
  it("name every registered effect's variants, in order ('Overlay' is studio's four-fill MaskOverlayEffect)", () => {
    for (const [name, effect] of Object.entries(AllEffects)) {
      if (name === 'Title') {
        continue; // studio's own: settings, no styles
      }
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

  it("shows a conditional setting only for values its condition's choice has", () => {
    for (const [name, spec] of Object.entries(EFFECT_SPECS)) {
      for (const p of Object.values(spec.params)) {
        for (const [key, values] of Object.entries(p.onlyWhen ?? {})) {
          const on = spec.params[key];
          expect(on?.kind === 'choice' && values.every(v => on.options.includes(v)), `${name}: ${key}`).toBe(true);
        }
      }
    }
  });
});

describe('Replace background and Colour pop', () => {
  it('are subjects backgrounds (they get the masks), as is the Title; of the layer effects only Echo gets them (D8)', () => {
    expect(Object.keys(EFFECT_SPECS).filter(n => EFFECT_SPECS[n].subjects)).toEqual(['ReplaceBackground', 'Title', 'ColorPop', 'Echo']);
  });

  it('start from their defaults: a colour fill with no picture, a full grey', () => {
    expect(normalizeParams('ReplaceBackground', {})).toEqual({color: '#2f6fdf', color2: '#101820', angle: 180, image: '', fit: 'Cover', feather: 0, style: 'Colour'});
    expect(normalizeParams('ColorPop', {})).toEqual({amount: 1, contrast: 1, style: 'Gray'});
    expect(withStyle('ColorPop', normalizeParams('ColorPop', {}), 'Muted')).toMatchObject({amount: 0.6, contrast: 1});
  });

  it('show only the settings their fill (or shape) uses', () => {
    const shown = (effect: string, params: EffectParams) =>
      Object.entries(EFFECT_SPECS[effect].params)
        .filter(([, p]) => paramShown(p, normalizeParams(effect, params)))
        .map(([k]) => k);
    expect(shown('ReplaceBackground', {style: 'Colour'})).toEqual(['color', 'feather', 'style']);
    expect(shown('ReplaceBackground', {style: 'Gradient'})).toEqual(['color', 'color2', 'angle', 'feather', 'style']);
    expect(shown('ReplaceBackground', {style: 'Image'})).toEqual(['color', 'image', 'fit', 'feather', 'style']);
    expect(shown('Scope', {style: 'Colour disc'})).not.toContain('thickness');
    expect(shown('Scope', {style: 'Colour disc', shape: 'Ring'})).toContain('thickness');
    expect(shown('Outline', {style: 'Scribble'})).toContain('boil');
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

describe('Title', () => {
  it('starts as a white bold fading title in the middle, behind the subjects', () => {
    expect(normalizeParams('Title', {})).toEqual({
      text: 'Your title',
      weight: 700,
      size: 0.12,
      color: '#ffffff',
      align: 'Centre',
      x: 0.5,
      y: 0.5,
      animation: 'Fade',
      entrance: 0.6,
      placement: 'Behind subjects',
    });
  });

  it('keeps every setting in range: Inter weights 300-900, size, position inside the frame, entrance length', () => {
    const p = normalizeParams('Title', {weight: 1000, size: 2, x: -1, y: 1.4, entrance: 0, align: 'Justify', animation: 'Spin', placement: 'Above', color: 'red'});
    expect(p).toMatchObject({weight: 900, size: 0.4, x: 0, y: 1, entrance: 0.1, align: 'Centre', animation: 'Fade', placement: 'Behind subjects', color: '#ffffff'});
    expect(normalizeParams('Title', {weight: 250, size: 0}).weight).toBe(300);
    expect(normalizeParams('Title', {weight: 640}).weight).toBe(600);
    expect(normalizeParams('Title', {color: 'layer'}).color).toBe('#ffffff'); // a background's colour: no layer to follow
  });

  it('shows the entrance length only with an entrance', () => {
    const shown = (animation: string) => paramShown(EFFECT_SPECS.Title.params.entrance, normalizeParams('Title', {animation}));
    expect(['None', 'Fade', 'Rise', 'Pop'].map(shown)).toEqual([false, true, true, true]);
  });
});
