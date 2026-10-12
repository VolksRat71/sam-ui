import {describe, expect, it} from 'vitest';
import {mattePreview, reconcilePreviewImages} from './matteView';
import {normalizeParams, updateClip, type EffectDoc} from './effectClips';
const authored: EffectDoc = {version: 2, clips: [{id: 'picture', target: {kind: 'background'}, effect: 'ReplaceBackground', params: normalizeParams('ReplaceBackground', {style: 'Image', image: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}), start: 0, end: 247, row: 0, phase: 0}]};
describe('matte preview documents', () => {
  it('preserves the authored Look document for normal preview and export', () => {
    const before = JSON.stringify(authored);
    expect(mattePreview(authored, 'overlay', 1, [1, 2], 247)).toBe(authored);
    const alpha = mattePreview(authored, 'alpha', 1, [1, 2], 247)!;
    expect(alpha.clips.map(c => c.effect)).toEqual(['EraseForeground', 'Outline', 'EraseBackground']);
    expect(alpha.clips[1].params.opacity).toBe(0);
    expect(JSON.stringify(authored)).toBe(before);
    expect(mattePreview(authored, 'edge', 1, [1, 2], 247)!.clips[0].params.softness).toBe(0);
  });
  it('re-picking the same picture changes preview identity so missing uploads retry', () => {
    const pickedAgain = updateClip(authored, 'picture', {params: authored.clips[0].params});
    expect(pickedAgain).not.toBe(authored);
    expect(pickedAgain).toEqual(authored);
    expect(mattePreview(pickedAgain, 'overlay', 1, [1], 247)).toBe(pickedAgain);
    const sent = new Set<string>();
    reconcilePreviewImages(sent, pickedAgain);
    expect(sent.size).toBe(0); // a missing upload stays eligible for sendImages
  });
  it('uses honest normal preview when no selected layer is available', () => {
    expect(mattePreview(authored, 'alpha', null, [1], 247)).toBe(authored);
    expect(mattePreview(authored, 'edge', 9, [1], 247)).toBe(authored);
    expect(mattePreview(authored, 'alpha', 1, [1], 0)).toBe(authored);
  });
  it('suppresses every other overlay and keeps the selected matte full range', () => {
    for (const mode of ['alpha', 'edge'] as const) {
      const preview = mattePreview(authored, mode, 2, [1, 2, 3], 247)!;
      expect(preview.clips.filter(c => c.target.kind === 'object' && c.target.id !== 2).map(c => c.params.opacity)).toEqual([0, 0]);
      expect(preview.clips.every(c => c.start === 0 && c.end === 247)).toBe(true);
      expect(preview.clips.some(c => c.effect === 'ReplaceBackground')).toBe(false);
    }
    expect(mattePreview(authored, 'alpha', 2, [1, 2], 247)!.clips).toEqual(expect.arrayContaining([expect.objectContaining({target: {kind: 'background'}, effect: 'EraseBackground', params: {style: 'Black'}}), expect.objectContaining({target: {kind: 'object', id: 2}, effect: 'EraseForeground', params: {style: 'White'}})]));
  });
  it('invalidates sent-picture cache on a temporary preview and after export completion', () => {
    const sent = new Set(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    reconcilePreviewImages(sent, mattePreview(authored, 'alpha', 1, [1], 247));
    expect(sent.has('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    sent.add('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'); // export resends its authored image
    reconcilePreviewImages(sent, mattePreview(authored, 'alpha', 1, [1], 247));
    expect(sent.size).toBe(0); // returning to normal must decode/send again
    sent.add('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    reconcilePreviewImages(sent, authored);
    expect(sent.has('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
  });
});
