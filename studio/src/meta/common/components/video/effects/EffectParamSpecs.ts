// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Each effect's settings, by registry name, shared by the main thread (which
// validates and stores them) and the worker (which draws with them). Meta's
// effects have no settings beyond a variant number, so each gets one `style`
// choice whose options name its variants in order: the worker turns the style
// back into that variant (styleIndex), and the shaders are unchanged. A
// style's preset is the params it sets (`styles`).
import type {EffectParams} from './Effect';

export type ParamSpec =
  | {kind: 'number'; min: number; max: number; step: number; default: number; label: string}
  | {kind: 'color'; default: string; label: string} // '#rrggbb' or 'layer' (follow the layer's mask colour)
  | {kind: 'choice'; options: string[]; default: string; label: string};
export type EffectSpec = {params: Record<string, ParamSpec>; styles: Record<string, Partial<EffectParams>>};

/** A Meta effect's variants as named styles, in variant order. */
function variants(...options: string[]): EffectSpec {
  return {
    params: {style: {kind: 'choice', options, default: options[0], label: 'Style'}},
    styles: Object.fromEntries(options.map(o => [o, {style: o}])),
  };
}

export const EFFECT_SPECS: Record<string, EffectSpec> = {
  /* Backgrounds */
  Original: variants('Plain', 'Vivid', 'Dimmed'),
  EraseBackground: variants('Black', 'White', 'Green'),
  Desaturate: variants('Gray', 'Gray, high contrast', 'Gray, low contrast'),
  Pixelate: variants('Fine', 'Medium', 'Coarse'),
  Sobel: variants('Colour edges', 'Green edges', 'White edges', 'Black on white'),
  BackgroundText: variants('Zooming words', 'Scrolling text'),
  BackgroundBlur: variants('Light', 'Medium', 'Strong'),
  Gradient: variants('Palette 1', 'Palette 2', 'Palette 3'),

  /* Objects ('Overlay' is studio's MaskOverlayEffect: its four fill strengths) */
  Overlay: variants('Tint', 'Strong tint', 'Light tint', 'Near solid'),
  EraseForeground: variants('White', 'Black', 'Green'),
  Cutout: variants('Unchanged', 'More contrast', 'Less contrast', 'Sepia'),
  Scope: variants('Colour disc', 'Colour ring', 'White disc', 'White ring', 'Soft disc', 'Soft ring'),
  VibrantMask: variants('Palette 1', 'Palette 2', 'Palette 3'),
  Replace: variants('Angry', 'Angry, square', 'Heart', 'Heart, square', 'Whistle', 'Whistle, square'),
  Burst: variants('Colour rays', 'White rays', 'Colour wedges', 'White wedges'),
  PixelateMask: variants('Fine', 'Medium', 'Coarse'),
  Arrow: variants('White arrow', 'Rainbow arrow', 'White dot', 'Rainbow dot'),
  NoisyMask: variants('Noise'),
  Outline: {
    params: {
      width: {kind: 'number', min: 0.002, max: 0.05, step: 0.001, default: 0.006, label: 'Width'},
      color: {kind: 'color', default: 'layer', label: 'Colour'},
      opacity: {kind: 'number', min: 0, max: 1, step: 0.05, default: 1, label: 'Opacity'},
      softness: {kind: 'number', min: 0, max: 1, step: 0.05, default: 0.25, label: 'Softness'},
      style: {kind: 'choice', options: ['Outline', 'Glow'], default: 'Outline', label: 'Style'},
    },
    styles: {
      Outline: {style: 'Outline', softness: 0.25},
      Glow: {style: 'Glow', width: 0.02, softness: 0.8, opacity: 0.9},
    },
  },
};

/** The style's position among the effect's style options (its Meta variant); 0 when unknown. */
export function styleIndex(effect: string, params: EffectParams): number {
  const style = EFFECT_SPECS[effect]?.params.style;
  return style?.kind === 'choice' ? Math.max(0, style.options.indexOf(String(params.style))) : 0;
}
