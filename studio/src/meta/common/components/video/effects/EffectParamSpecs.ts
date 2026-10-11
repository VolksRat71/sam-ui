// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Each effect's settings, by registry name, shared by the main thread (which
// validates and stores them) and the worker (which draws with them). Meta's
// effects have no settings beyond a variant number, so each gets one `style`
// choice whose options name its variants in order: the worker turns the style
// back into that variant (styleIndex), and the shaders are unchanged. A
// style's preset is the params it sets (`styles`), and a stored clip missing
// a setting takes it from its style (normalizeParams), so clips saved when an
// effect had only a style still draw as they did.
import type {EffectParams} from './Effect';

// onlyWhen: shown (and used) only while each named setting has one of these values ({style: ['Glow']})
export type ParamSpec = (
  // percentOfHeight: a fraction of the frame height, shown to people as a percentage (stored as the fraction)
  | {kind: 'number'; min: number; max: number; step: number; default: number; label: string; percentOfHeight?: true}
  // '#rrggbb' or 'layer' (follow the layer's mask colour); followsLayer false: a background's, never 'layer'
  | {kind: 'color'; default: string; label: string; followsLayer?: false}
  | {kind: 'choice'; options: string[]; default: string; label: string}
  // a picture stored in this browser (state/effectImages.ts), by the sha-256 of its bytes; '' for none
  | {kind: 'image'; default: ''; label: string}
  // typed text, drawn only with canvas fillText: cleaned (normalizeParams, cleanText); maxLength in characters as people see them
  | {kind: 'text'; default: string; label: string; maxLength: number; maxLines: number}
) & {onlyWhen?: Record<string, string[]>};
/**
 * subjects: a background effect drawn knowing every tracked layer's mask on
 * the frame (their union), to keep those subjects as they are in the video.
 * Other background effects get no masks: a layer clip draws over them.
 */
export type EffectSpec = {params: Record<string, ParamSpec>; styles: Record<string, Partial<EffectParams>>; subjects?: true};

/** A Meta effect's variants as named styles, in variant order. */
function variants(...options: string[]): EffectSpec {
  return {
    params: {style: {kind: 'choice', options, default: options[0], label: 'Style'}},
    styles: Object.fromEntries(options.map(o => [o, {style: o}])),
  };
}

/**
 * Block size or blur radius in fractions of the frame height, with styles
 * that give Meta's fixed pixel sizes at 720p (`px`): 10/20/30 px blocks,
 * 3/6/12 px blur. The effects round to whole pixels, so 720p is exact.
 */
function sized(key: 'size' | 'radius', label: string, max: number, px: Record<string, number>, extra: EffectSpec['params'] = {}): EffectSpec {
  const options = Object.keys(px);
  const at720 = (n: number) => Math.round((n / 720) * 1000) / 1000;
  return {
    params: {
      [key]: {kind: 'number', min: 0.002, max, step: 0.001, default: at720(px[options[0]]), label, percentOfHeight: true},
      ...extra,
      style: {kind: 'choice', options, default: options[0], label: 'Style'},
    },
    styles: Object.fromEntries(options.map(o => [o, {style: o, [key]: at720(px[o])}])),
  };
}
const FEATHER: ParamSpec = {kind: 'number', min: 0, max: 1, step: 0.05, default: 0, label: 'Feather'};
/** How far a mask's edge softens at feather 1, as a fraction of the frame height. */
export const FEATHER_REACH = 0.02;
/** Spotlight's styles: Meta's six Scope variants, by shape and colour ('Soft' ones draw the fill half see-through, as Meta's did). */
const SPOTLIGHT_STYLES: Record<string, Partial<EffectParams>> = {
  'Colour disc': {shape: 'Disc', color: 'layer'},
  'Colour ring': {shape: 'Ring', color: 'layer'},
  'White disc': {shape: 'Disc', color: '#ffffff'},
  'White ring': {shape: 'Ring', color: '#ffffff'},
  'Soft disc': {shape: 'Disc', color: 'layer'},
  'Soft ring': {shape: 'Ring', color: 'layer'},
};

export const EFFECT_SPECS: Record<string, EffectSpec> = {
  /* Backgrounds */
  Original: variants('Plain', 'Vivid', 'Dimmed'),
  EraseBackground: variants('Black', 'White', 'Green'),
  Desaturate: variants('Gray', 'Gray, high contrast', 'Gray, low contrast'),
  Pixelate: sized('size', 'Block size', 0.08, {Fine: 10, Medium: 20, Coarse: 30}),
  Sobel: variants('Colour edges', 'Green edges', 'White edges', 'Black on white'),
  BackgroundText: variants('Zooming words', 'Scrolling text'),
  BackgroundBlur: sized('radius', 'Radius', 0.05, {Light: 3, Medium: 6, Strong: 12}),
  Gradient: variants('Palette 1', 'Palette 2', 'Palette 3'),
  // the fill behind the tracked subjects, which stay as they are (the style is the fill)
  ReplaceBackground: {
    params: {
      color: {kind: 'color', default: '#2f6fdf', label: 'Colour', followsLayer: false},
      color2: {kind: 'color', default: '#101820', label: 'Second colour', followsLayer: false, onlyWhen: {style: ['Gradient']}},
      angle: {kind: 'number', min: 0, max: 360, step: 1, default: 180, label: 'Angle', onlyWhen: {style: ['Gradient']}},
      image: {kind: 'image', default: '', label: 'Image', onlyWhen: {style: ['Image']}},
      fit: {kind: 'choice', options: ['Cover', 'Contain'], default: 'Cover', label: 'Fit', onlyWhen: {style: ['Image']}},
      feather: FEATHER,
      style: {kind: 'choice', options: ['Colour', 'Gradient', 'Image'], default: 'Colour', label: 'Fill'},
    },
    styles: {Colour: {style: 'Colour'}, Gradient: {style: 'Gradient'}, Image: {style: 'Image'}},
    subjects: true,
  },
  // an editable title, drawn behind the tracked subjects (their pixels put back over it) or in front
  Title: {
    params: {
      text: {kind: 'text', default: 'Your title', label: 'Text', maxLength: 80, maxLines: 3},
      weight: {kind: 'number', min: 300, max: 900, step: 100, default: 700, label: 'Weight'},
      size: {kind: 'number', min: 0.02, max: 0.4, step: 0.005, default: 0.12, label: 'Size', percentOfHeight: true},
      color: {kind: 'color', default: '#ffffff', label: 'Colour', followsLayer: false},
      align: {kind: 'choice', options: ['Left', 'Centre', 'Right'], default: 'Centre', label: 'Alignment'},
      // the text block's centre, as fractions of the frame's width and height
      x: {kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Horizontal position'},
      y: {kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Vertical position'},
      animation: {kind: 'choice', options: ['None', 'Fade', 'Rise', 'Pop'], default: 'Fade', label: 'Entrance'},
      // over the clip's first `entrance` seconds, on its clock
      entrance: {kind: 'number', min: 0.1, max: 3, step: 0.1, default: 0.6, label: 'Entrance seconds', onlyWhen: {animation: ['Fade', 'Rise', 'Pop']}},
      placement: {kind: 'choice', options: ['Behind subjects', 'In front'], default: 'Behind subjects', label: 'Placement'},
    },
    styles: {},
    subjects: true,
  },
  // everything but the tracked subjects in grey
  ColorPop: {
    params: {
      amount: {kind: 'number', min: 0, max: 1, step: 0.05, default: 1, label: 'Amount'},
      contrast: {kind: 'number', min: 0.5, max: 1.5, step: 0.05, default: 1, label: 'Contrast'},
      style: {kind: 'choice', options: ['Gray', 'Gray, high contrast', 'Muted'], default: 'Gray', label: 'Style'},
    },
    styles: {
      Gray: {style: 'Gray', amount: 1, contrast: 1},
      'Gray, high contrast': {style: 'Gray, high contrast', amount: 1, contrast: 1.5},
      Muted: {style: 'Muted', amount: 0.6, contrast: 1},
    },
    subjects: true,
  },

  /* Objects ('Overlay' is studio's MaskOverlayEffect: its four fill strengths) */
  Overlay: variants('Tint', 'Strong tint', 'Light tint', 'Near solid'),
  EraseForeground: variants('White', 'Black', 'Green'),
  Cutout: variants('Unchanged', 'More contrast', 'Less contrast', 'Sepia'),
  Scope: {
    params: {
      shape: {kind: 'choice', options: ['Disc', 'Ring'], default: 'Disc', label: 'Shape'},
      color: {kind: 'color', default: 'layer', label: 'Colour'},
      // 1: Meta's radius (0.8 of the circle on the mask's height) and ring (0.085 of it)
      size: {kind: 'number', min: 0.25, max: 3, step: 0.05, default: 1, label: 'Size'},
      thickness: {kind: 'number', min: 0.25, max: 4, step: 0.05, default: 1, label: 'Ring thickness', onlyWhen: {shape: ['Ring']}},
      darken: {kind: 'number', min: 0, max: 1, step: 0.05, default: 0, label: 'Darken outside'},
      style: {kind: 'choice', options: Object.keys(SPOTLIGHT_STYLES), default: 'Colour disc', label: 'Style'},
    },
    styles: Object.fromEntries(Object.entries(SPOTLIGHT_STYLES).map(([o, p]) => [o, {style: o, size: 1, thickness: 1, darken: 0, ...p}])),
  },
  VibrantMask: variants('Palette 1', 'Palette 2', 'Palette 3'),
  Replace: variants('Angry', 'Angry, square', 'Heart', 'Heart, square', 'Whistle', 'Whistle, square'),
  Burst: variants('Colour rays', 'White rays', 'Colour wedges', 'White wedges'),
  PixelateMask: sized('size', 'Block size', 0.08, {Fine: 10, Medium: 20, Coarse: 30}, {feather: FEATHER}),
  BlurMask: sized('radius', 'Radius', 0.05, {Light: 6, Medium: 12, Strong: 24}, {feather: {...FEATHER, default: 0.5}}),
  Arrow: variants('White arrow', 'Rainbow arrow', 'White dot', 'Rainbow dot'),
  NoisyMask: variants('Noise'),
  Outline: {
    params: {
      width: {kind: 'number', min: 0.002, max: 0.05, step: 0.001, default: 0.006, label: 'Width', percentOfHeight: true},
      color: {kind: 'color', default: 'layer', label: 'Colour'},
      opacity: {kind: 'number', min: 0, max: 1, step: 0.05, default: 1, label: 'Opacity'},
      softness: {kind: 'number', min: 0, max: 1, step: 0.05, default: 0.25, label: 'Softness'},
      // Scribble: how far the stroke wanders out from the edge, and how many times a second it is redrawn (0: never)
      wobble: {kind: 'number', min: 0, max: 0.03, step: 0.001, default: 0.008, label: 'Wobble', percentOfHeight: true, onlyWhen: {style: ['Scribble']}},
      boil: {kind: 'number', min: 0, max: 24, step: 1, default: 8, label: 'Boil per second', onlyWhen: {style: ['Scribble']}},
      style: {kind: 'choice', options: ['Outline', 'Glow', 'Scribble'], default: 'Outline', label: 'Style'},
    },
    styles: {
      Outline: {style: 'Outline', softness: 0.25},
      Glow: {style: 'Glow', width: 0.02, softness: 0.8, opacity: 0.9},
      Scribble: {style: 'Scribble', width: 0.005, softness: 0.25, opacity: 1, wobble: 0.008, boil: 8},
    },
  },
};

/** Setting `key` of `effect` from raw params: a number clamped to its range, else its default (behind normalizeParams, at the worker). */
export function numberParam(effect: string, key: string, params: EffectParams): number {
  const spec = EFFECT_SPECS[effect].params[key] as Extract<ParamSpec, {kind: 'number'}>;
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, v)) : spec.default;
}

/** Whether setting `p` applies with `params` (its onlyWhen). */
export function paramShown(p: ParamSpec, params: EffectParams): boolean {
  return Object.entries(p.onlyWhen ?? {}).every(([key, values]) => values.includes(String(params[key])));
}

/** The style's position among the effect's style options (its Meta variant); 0 when unknown. */
export function styleIndex(effect: string, params: EffectParams): number {
  const style = EFFECT_SPECS[effect]?.params.style;
  return style?.kind === 'choice' ? Math.max(0, style.options.indexOf(String(params.style))) : 0;
}
