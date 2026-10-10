// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {normalizeParams} from '~/state/effectClips';
import {clipFrames, clipTitle, effectTitle, targetName} from './effectPresentation';

describe('effect clip names', () => {
  it('uses the tile titles, the style when there is a choice, and frames as people count them', () => {
    const pim = {kind: 'object', id: 0} as const;
    expect(effectTitle(pim, 'PixelateMask')).toBe('Pixelate');
    expect(effectTitle({kind: 'background'}, 'Sobel')).toBe('Outline');
    expect(effectTitle(pim, 'Sparkle')).toBe('Sparkle'); // a newer build's effect
    expect(clipTitle({target: pim, effect: 'Outline', params: normalizeParams('Outline', {style: 'Glow'})})).toBe('Outline · Glow');
    expect(clipTitle({target: pim, effect: 'NoisyMask', params: normalizeParams('NoisyMask', {})})).toBe('Noisy');
    expect(clipFrames({start: 30, end: 102})).toBe('frames 31–102');
    expect(clipFrames({start: 4, end: 5})).toBe('frame 5');
    expect(targetName(pim, [{id: 0, name: 'Pim'}])).toBe('Pim');
    expect(targetName({kind: 'background'}, [])).toBe('Background');
  });
});
