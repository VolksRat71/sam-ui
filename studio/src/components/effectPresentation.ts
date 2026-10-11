// sam-ui (Apache-2.0). Presentation only: how effect clips are named in the dock, timeline and viewer.
import {backgroundEffects, highlightEffects, moreEffects} from '@/common/components/effects/EffectsUtils';
import {EFFECT_SPECS} from '@/common/components/video/effects/EffectParamSpecs';
import type {EffectClip, EffectTarget} from '~/state/effectClips';
import {objectName} from '~/state/fileNames';

const LAYER_TILES = [...highlightEffects, ...moreEffects];

/** The tile title of an effect on `target` ("PixelateMask" is "Pixelate"); the registry name when no tile has it. */
export function effectTitle(target: EffectTarget, effect: string): string {
  const tiles = target.kind === 'background' ? backgroundEffects : LAYER_TILES;
  return tiles.find(t => t.effectName === effect)?.title ?? effect;
}

/** "Outline · Glow": the effect and, when it has more than one, its style (unless the style is the effect's own name). */
export function clipTitle(clip: Pick<EffectClip, 'target' | 'effect' | 'params'>): string {
  const spec = EFFECT_SPECS[clip.effect]?.params.style;
  const title = effectTitle(clip.target, clip.effect);
  const style = String(clip.params.style);
  // Outline's plain style is "Outline": say it once
  return spec?.kind === 'choice' && spec.options.length > 1 && style !== title ? `${title} · ${style}` : title;
}

/** The layer a clip is on, or "Background". */
export function targetName(target: EffectTarget, objects: ReadonlyArray<{id: number; name?: string | null}>): string {
  return target.kind === 'background' ? 'Background' : objectName(objects.find(o => o.id === target.id) ?? {id: target.id});
}

/** Frames as people count them: "frames 31–102" for the clip [30, 102). */
export function clipFrames(clip: Pick<EffectClip, 'start' | 'end'>): string {
  return clip.end - clip.start === 1 ? `frame ${clip.start + 1}` : `frames ${clip.start + 1}–${clip.end}`;
}
