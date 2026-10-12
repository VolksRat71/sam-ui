// sam-ui (Apache-2.0). Preview only: these documents are never saved or exported.
import {imageKeys, normalizeParams, type EffectClip, type EffectDoc} from './effectClips';
export type MatteView = 'overlay' | 'alpha' | 'edge';
export function mattePreview(doc: EffectDoc | null, mode: MatteView, selectedId: number | null, ids: readonly number[], numFrames: number): EffectDoc | null {
  if (doc == null || mode === 'overlay' || selectedId == null || !ids.includes(selectedId) || numFrames < 1) return doc;
  const clip = (id: number | null, effect: string, params: EffectClip['params']): EffectClip => ({id: `matte-view-${id ?? 'background'}`, target: id == null ? {kind: 'background'} : {kind: 'object', id}, effect, params: normalizeParams(effect, params), start: 0, end: numFrames, row: 0, phase: 0});
  const clips = ids.map(id => id !== selectedId ? clip(id, 'Outline', {opacity: 0}) : mode === 'alpha' ? clip(id, 'EraseForeground', {style: 'White'}) : clip(id, 'Outline', {style: 'Outline', width: .002, color: 'layer', opacity: 1, softness: 0}));
  if (mode === 'alpha') clips.push(clip(null, 'EraseBackground', {style: 'Black'}));
  return {version: 2, clips};
}
/** The worker frees pictures absent from both its current preview and active exports. */
export function reconcilePreviewImages(sent: Set<string>, preview: EffectDoc | null) {
  const retained = new Set(imageKeys(preview ?? {version: 2, clips: []}));
  sent.forEach(key => {if (!retained.has(key)) sent.delete(key);});
}
