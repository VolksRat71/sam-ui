// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {EFFECT_SPECS, styleIndex} from './EffectParamSpecs';
import AllEffects from './Effects';

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
});
